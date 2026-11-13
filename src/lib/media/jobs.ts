/**
 * src/lib/media/jobs.ts
 *
 * Async media jobs: the answer to "no client should hold a connection open".
 *
 * The synchronous media routes are OpenAI-compatible, which is why they have to
 * answer with a status code in one shot — and why a slow vendor forced the
 * heartbeat trade-off documented in §89 of the change log. A job has no such
 * constraint: the client gets `202` immediately, the generation runs in this
 * process, and the client polls a state it can read at its own pace.
 *
 * What it is not: a queue. There is no worker pool and no retry — a job runs as
 * soon as it is accepted, with the vendor's own `limits.timeoutMs` as its
 * deadline. If the process restarts mid-flight the job is marked
 * `job_interrupted`, because nothing upstream is resumable and claiming
 * otherwise would leave a job polling as `running` forever.
 */
import {
  claimMediaJob,
  countActiveMediaJobs,
  createMediaJob as insertMediaJob,
  failMediaJob,
  finishMediaJob,
  getMediaJob,
  getMediaJobForUser,
  pruneExpiredMediaJobs,
  type MediaJob,
  type MediaJobError,
} from "../db/media-jobs";
import { executeMediaRequest, imageItemsResponse, mediaItemsResponse, resultItems } from "./handler";
import type { MediaCapability } from "./spec";
import type { ApiKey, User } from "../db/types";

/**
 * Which capabilities may be submitted as a job.
 *
 * The slow ones. TTS and transcription are fast enough that a job adds a poll
 * round-trip for nothing, and their responses are bytes/text rather than the
 * JSON payload a job stores.
 */
export const MEDIA_JOB_CAPABILITIES = [
  "image.generate",
  "image.edit",
  "video.generate",
  "music.generate",
] as const;

export type MediaJobCapability = (typeof MEDIA_JOB_CAPABILITIES)[number];

export function isMediaJobCapability(value: string): value is MediaJobCapability {
  return (MEDIA_JOB_CAPABILITIES as readonly string[]).includes(value);
}

/** How many jobs one account may have in flight. */
export const MAX_ACTIVE_JOBS_PER_USER = 3;
/** How many may be in flight across the deployment (one SQLite, one process). */
export const MAX_ACTIVE_JOBS = 12;
/** A result larger than this is a bug, not a job — refuse to store it. */
const MAX_JOB_RESULT_BYTES = 8 * 1024 * 1024;

/** Abort handles for jobs running in this process, so `DELETE` can stop one. */
const running = new Map<string, AbortController>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * What a client sees.
 *
 * Same key names as the synchronous responses where they exist (`created`,
 * `data`), plus the job fields — a client that already parses `data[].url` can
 * keep doing that once the job succeeds.
 */
export function mediaJobView(job: MediaJob): Record<string, unknown> {
  return {
    id: job.id,
    object: "media.job",
    status: job.status,
    capability: job.capability,
    model: job.model,
    created_at: Math.floor(Date.parse(job.createdAt) / 1000),
    ...(job.startedAt ? { started_at: Math.floor(Date.parse(job.startedAt) / 1000) } : {}),
    ...(job.finishedAt ? { finished_at: Math.floor(Date.parse(job.finishedAt) / 1000) } : {}),
    result: job.result,
    error: job.error,
  };
}

export type CreateJobOutcome =
  | { ok: true; job: MediaJob }
  | { ok: false; error: MediaJobError };

/**
 * Accept a job and start it.
 *
 * The row is written before anything runs, so `202` always refers to something
 * the client can poll — even if the process dies a millisecond later, the poll
 * finds `job_interrupted` instead of a 404.
 */
export async function submitMediaJob(args: {
  capability: MediaJobCapability;
  user: User;
  apiKey: ApiKey;
  request: Record<string, unknown>;
}): Promise<CreateJobOutcome> {
  await pruneExpiredMediaJobs();

  const [mine, all] = await Promise.all([
    countActiveMediaJobs(args.user.id),
    countActiveMediaJobs(),
  ]);
  if (mine >= MAX_ACTIVE_JOBS_PER_USER) {
    return {
      ok: false,
      error: {
        status: 429,
        code: "too_many_jobs",
        message: `this account already has ${mine} jobs in flight (limit ${MAX_ACTIVE_JOBS_PER_USER})`,
      },
    };
  }
  if (all >= MAX_ACTIVE_JOBS) {
    return {
      ok: false,
      error: {
        status: 429,
        code: "too_many_jobs",
        message: `the deployment already has ${all} jobs in flight (limit ${MAX_ACTIVE_JOBS})`,
      },
    };
  }

  const job = await insertMediaJob({
    userId: args.user.id,
    apiKeyId: args.apiKey.id,
    capability: args.capability,
    model: String(args.request.model ?? ""),
    request: args.request,
  });

  // Deliberately not awaited: the 202 means "accepted", not "finished".
  void runMediaJob(job.id).catch(() => {
    // `runMediaJob` records its own failure; a throw here would be the row write
    // itself failing, which there is no one left to tell.
  });

  return { ok: true, job };
}

/**
 * Run one job.
 *
 * Claimed atomically, so a double call cannot generate (or bill) twice. The
 * vendor's `limits.timeoutMs` is the deadline, applied inside
 * `executeMediaRequest`; the local controller only exists so `DELETE` can stop
 * a job that is already running.
 */
export async function runMediaJob(id: string): Promise<void> {
  const job = await claimMediaJob(id);
  if (!job) return;

  const controller = new AbortController();
  running.set(id, controller);

  try {
    const outcome = await executeMediaRequest({
      capability: job.capability as MediaCapability,
      input: job.request as never,
      apiKey: await apiKeyFor(job),
      user: await userFor(job),
      signal: controller.signal,
    });

    if (!outcome.ok) {
      /**
       * A cancellation looks like an upstream failure from the handler's point
       * of view — the fetch it was awaiting was aborted. The abort is ours, so
       * say what actually happened rather than blaming the vendor.
       */
      await failMediaJob(
        id,
        controller.signal.aborted
          ? { status: 499, code: "job_cancelled", message: "cancelled by the client" }
          : outcome.error,
      );
      return;
    }

    const items = await resultItems(outcome.value.result);
    const payload =
      job.capability === "image.generate" || job.capability === "image.edit"
        ? imageItemsResponse(items)
        : mediaItemsResponse(items, outcome.value.result.taskId);

    const size = Buffer.byteLength(JSON.stringify(payload));
    if (size > MAX_JOB_RESULT_BYTES) {
      await failMediaJob(id, {
        status: 502,
        code: "result_too_large",
        message: `the result is ${size} bytes, over the ${MAX_JOB_RESULT_BYTES} byte job limit`,
      });
      return;
    }
    await finishMediaJob(id, payload);
  } catch (err) {
    const aborted = controller.signal.aborted;
    await failMediaJob(id, {
      status: aborted ? 499 : 500,
      code: aborted ? "job_cancelled" : "job_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running.delete(id);
  }
}

/** Stop a job. Queued jobs fail immediately; running ones are aborted. */
export async function cancelMediaJob(id: string, userId: string): Promise<boolean> {
  const job = await getMediaJobForUser(id, userId);
  if (!job) return false;
  if (job.status === "succeeded" || job.status === "failed") return true;

  const controller = running.get(id);
  if (controller) controller.abort();
  else {
    // Never started (or already finished between the read and here): claim it
    // with a status transition so it cannot be claimed afterwards.
    await failMediaJob(id, {
      status: 499,
      code: "job_cancelled",
      message: "cancelled before it started",
    });
  }
  return true;
}

export async function describeMediaJob(id: string, userId: string): Promise<Record<string, unknown> | null> {
  const job = await getMediaJobForUser(id, userId);
  return job ? mediaJobView(job) : null;
}

export async function pruneJobs(): Promise<number> {
  return pruneExpiredMediaJobs();
}

/**
 * The key the job was submitted with.
 *
 * `executeMediaRequest` needs a key row for the model whitelist and for the
 * usage record. A deleted key is the only way this is null — and then the job
 * cannot run, which the failure below says plainly.
 */
async function apiKeyFor(job: MediaJob): Promise<ApiKey> {
  const { getApiKeyById } = await import("../db/keys");
  const key = job.apiKeyId ? await getApiKeyById(job.apiKeyId) : null;
  if (!key) throw new Error("the API key this job was submitted with no longer exists");
  return key;
}

async function userFor(job: MediaJob): Promise<User> {
  const { getUserById } = await import("../db/users");
  const user = await getUserById(job.userId);
  if (!user) throw new Error("the account that submitted this job no longer exists");
  return user;
}

/** Exported for tests: the in-memory handles of jobs running now. */
export function __runningJobsForTest(): Map<string, AbortController> {
  return running;
}

/** Kept so a caller can read one job without a user check (internal use). */
export async function getJob(id: string): Promise<MediaJob | null> {
  return getMediaJob(id);
}
