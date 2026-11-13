/**
 * src/lib/media/jobs.ts
 *
 * Async media jobs, modelled on how a vendor's own task system works: submit,
 * keep the **upstream task id**, and poll it.
 *
 * The synchronous media routes are OpenAI-compatible, which is why they must
 * answer with one status code — and why a slow vendor forced the heartbeat
 * trade-off documented in §89 of the change log. A job has no such constraint,
 * and (unlike a plain "run it in the background" job) it survives a restart:
 * the vendor's task keeps running whether or not this process does, so the id is
 * the part worth persisting. On boot, jobs that reached the vendor are resumed;
 * the ones that did not are reported as interrupted.
 *
 * Two-phase by design:
 *   submit  → `submitMediaRequest` either finishes (synchronous vendor) or hands
 *             back the upstream id, which is stored before anything else happens.
 *   poll    → `resumeMediaRequest` polls to the end and settles once.
 */
import {
  claimMediaJob,
  claimMediaJobPoll,
  clearMediaJobPollOwners,
  countActiveMediaJobs,
  createMediaJob as insertMediaJob,
  failMediaJob,
  failMediaJobsWithoutUpstream,
  finishMediaJob,
  getMediaJob,
  getMediaJobForUser,
  listResumableMediaJobs,
  pruneExpiredMediaJobs,
  releaseMediaJobPoll,
  setMediaJobUpstream,
  type MediaJob,
  type MediaJobError,
} from "../db/media-jobs";
import {
  imageItemsResponse,
  mediaItemsResponse,
  resumeMediaRequest,
  resultItems,
  submitMediaRequest,
} from "./handler";
import type { MediaCapability } from "./spec";
import type { MediaResult } from "./engine";
import type { ApiKey, User } from "../db/types";
import { getApiKeyById } from "../db/keys";
import { getUserById } from "../db/users";
import { generateId } from "../crypto/hashing";

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
/** How many may be in flight across the deployment (one process, one SQLite). */
export const MAX_ACTIVE_JOBS = 12;
/** A result larger than this is a bug, not a job — refuse to store it. */
const MAX_JOB_RESULT_BYTES = 8 * 1024 * 1024;

/** Abort handles for jobs this process is driving, so `DELETE` can stop one. */
const running = new Map<string, AbortController>();

/**
 * What a client sees.
 *
 * Same key names as the synchronous responses where they exist (`created`,
 * `data`), plus the job fields — a client that already parses `data[].url` can
 * keep doing that once the job succeeds. The upstream id is deliberately not
 * exposed: it belongs to our vendor account, not the caller's.
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
 * finds `job_interrupted` (or, if the task reached the vendor, keeps going to
 * `succeeded`).
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

/** Claim a queued job and drive it. */
export async function runMediaJob(id: string): Promise<void> {
  const job = await claimMediaJob(id);
  if (!job) return;
  await driveJob(job);
}

/** Drive a job that the submit phase already handed to the vendor. */
export async function resumeMediaJob(id: string): Promise<void> {
  const job = await getMediaJob(id);
  if (!job || job.status !== "running" || !job.upstreamTaskId) return;
  await driveJob(job);
}

/**
 * Resolve what a job needs, then either submit or poll.
 *
 * The recovery entry point: called once at boot per resumable job. Clears the
 * dead polling leases first, because the process that held them is gone.
 */
export async function recoverMediaJobs(): Promise<{ resumed: number; failed: number }> {
  const cleared = await clearMediaJobPollOwners();
  if (cleared > 0) {
    console.warn(`[relayab] cleared ${cleared} stale media-job poll lease(s)`);
  }
  const resumable = await listResumableMediaJobs();
  for (const job of resumable) {
    void resumeMediaJob(job.id).catch(() => {
      // Recorded in the row; a throw here is only the write failing.
    });
  }
  const failed = await failMediaJobsWithoutUpstream();
  return { resumed: resumable.length, failed };
}

async function driveJob(job: MediaJob): Promise<void> {
  const controller = new AbortController();
  running.set(job.id, controller);
  try {
    const apiKey = await apiKeyFor(job);
    const user = await userFor(job);

    // Already at the vendor: only the polling half is left.
    if (job.upstreamTaskId) {
      await pollAndFinish(job, apiKey, user, controller);
      return;
    }

    const submitted = await submitMediaRequest({
      capability: job.capability as MediaCapability,
      input: job.request as never,
      apiKey,
      user,
      signal: controller.signal,
    });

    if (!submitted.ok) {
      await failMediaJob(
        job.id,
        controller.signal.aborted
          ? { status: 499, code: "job_cancelled", message: "cancelled by the client" }
          : submitted.error,
      );
      return;
    }

    if ("pending" in submitted) {
      // Persist the id **before** polling: this single write is what lets a
      // restart finish the job instead of reporting it lost.
      await setMediaJobUpstream(job.id, submitted.pending);
      await pollAndFinish(
        { ...job, upstreamTaskId: submitted.pending.taskId, providerId: submitted.pending.providerId },
        apiKey,
        user,
        controller,
      );
      return;
    }

    await finishWithResult(job, submitted.value.result);
  } catch (err) {
    const aborted = controller.signal.aborted;
    await failMediaJob(job.id, {
      status: aborted ? 499 : 500,
      code: aborted ? "job_cancelled" : "job_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running.delete(job.id);
  }
}

/**
 * Poll the upstream task to the end, under a lease.
 *
 * The lease exists because a resumed job can be driven by more than one process
 * (the original one finishing, a new one after a restart). Only the holder
 * polls, so the settlement inside `resumeMediaRequest` runs exactly once.
 */
async function pollAndFinish(
  job: MediaJob,
  apiKey: ApiKey,
  user: User,
  controller: AbortController,
): Promise<void> {
  const owner = `${process.pid}-${generateId(12)}`;
  if (!(await claimMediaJobPoll(job.id, owner))) return;

  try {
    const resumed = await resumeMediaRequest({
      capability: job.capability as MediaCapability,
      input: job.request as never,
      apiKey,
      user,
      taskId: job.upstreamTaskId!,
      ...(job.providerId ? { providerId: job.providerId } : {}),
      signal: controller.signal,
    });

    if (!resumed.ok) {
      await failMediaJob(
        job.id,
        controller.signal.aborted
          ? { status: 499, code: "job_cancelled", message: "cancelled by the client" }
          : resumed.error,
      );
      return;
    }
    await finishWithResult(job, resumed.value.result);
  } finally {
    await releaseMediaJobPoll(job.id, owner);
  }
}

/** Turn a finished media result into the stored payload. */
async function finishWithResult(job: MediaJob, result: MediaResult): Promise<void> {
  const items = await resultItems(result);
  const payload =
    job.capability === "image.generate" || job.capability === "image.edit"
      ? imageItemsResponse(items)
      : mediaItemsResponse(items, result.taskId);

  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size > MAX_JOB_RESULT_BYTES) {
    await failMediaJob(job.id, {
      status: 502,
      code: "result_too_large",
      message: `the result is ${size} bytes, over the ${MAX_JOB_RESULT_BYTES} byte job limit`,
    });
    return;
  }
  await finishMediaJob(job.id, payload);
}

/** Stop a job. Queued jobs fail immediately; running ones are aborted. */
export async function cancelMediaJob(id: string, userId: string): Promise<boolean> {
  const job = await getMediaJobForUser(id, userId);
  if (!job) return false;
  if (job.status === "succeeded" || job.status === "failed") return true;

  const controller = running.get(id);
  if (controller) controller.abort();
  else {
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
  const key = job.apiKeyId ? await getApiKeyById(job.apiKeyId) : null;
  if (!key) throw new Error("the API key this job was submitted with no longer exists");
  return key;
}

async function userFor(job: MediaJob): Promise<User> {
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
