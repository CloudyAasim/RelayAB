/**
 * src/lib/db/media-jobs.ts
 *
 * Persistence for async media jobs.
 *
 * The point of a job is that the client is not holding a connection, so the
 * state has to outlive the request that created it — and ideally the process.
 * A row per job is the whole design: `queued` → `running` → `succeeded` |
 * `failed`, with the normalized request stored up front so a restart can at
 * least tell the truth about what was lost.
 */
import { getAll, getOne, run } from "./sqlite";
import { generateId } from "../crypto/hashing";

export type MediaJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface MediaJobError {
  status: number;
  code: string;
  message: string;
}

export interface MediaJob {
  id: string;
  userId: string;
  apiKeyId: string | null;
  capability: string;
  model: string;
  status: MediaJobStatus;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: MediaJobError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
}

/** How long a finished job stays readable. */
export const MEDIA_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function rowToMediaJob(row: Record<string, unknown>): MediaJob {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    apiKeyId: row.api_key_id === null || row.api_key_id === undefined ? null : String(row.api_key_id),
    capability: String(row.capability),
    model: String(row.model),
    status: row.status as MediaJobStatus,
    request: JSON.parse(String(row.request)) as Record<string, unknown>,
    result: row.result ? (JSON.parse(String(row.result)) as Record<string, unknown>) : null,
    error: row.error ? (JSON.parse(String(row.error)) as MediaJobError) : null,
    createdAt: String(row.created_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    expiresAt: String(row.expires_at),
  };
}

export async function createMediaJob(input: {
  userId: string;
  apiKeyId: string | null;
  capability: string;
  model: string;
  request: Record<string, unknown>;
  ttlMs?: number;
}): Promise<MediaJob> {
  const id = generateId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? MEDIA_JOB_TTL_MS));
  run(
    `INSERT INTO media_jobs
       (id, user_id, api_key_id, capability, model, status, request, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.userId,
      input.apiKeyId,
      input.capability,
      input.model,
      "queued",
      JSON.stringify(input.request),
      now.toISOString(),
      expiresAt.toISOString(),
    ],
  );
  const job = await getMediaJob(id);
  if (!job) throw new Error("media job disappeared immediately after insert");
  return job;
}

export async function getMediaJob(id: string): Promise<MediaJob | null> {
  return getOne("SELECT * FROM media_jobs WHERE id = ?", [id], rowToMediaJob);
}

export async function getMediaJobForUser(id: string, userId: string): Promise<MediaJob | null> {
  return getOne("SELECT * FROM media_jobs WHERE id = ? AND user_id = ?", [id, userId], rowToMediaJob);
}

/**
 * Take a queued job, atomically.
 *
 * `status = 'queued'` is the guard: a job can only be claimed once, so a retry
 * or a second worker cannot run the same generation twice and bill it twice.
 */
export async function claimMediaJob(id: string): Promise<MediaJob | null> {
  const changed = run(
    "UPDATE media_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
    [new Date().toISOString(), id],
  );
  return changed > 0 ? getMediaJob(id) : null;
}

export async function finishMediaJob(id: string, result: Record<string, unknown>): Promise<void> {
  run("UPDATE media_jobs SET status = 'succeeded', result = ?, error = NULL, finished_at = ? WHERE id = ?", [
    JSON.stringify(result),
    new Date().toISOString(),
    id,
  ]);
}

export async function failMediaJob(id: string, error: MediaJobError): Promise<void> {
  run("UPDATE media_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [
    JSON.stringify(error),
    new Date().toISOString(),
    id,
  ]);
}

/** Jobs this user still has in flight (queued or running). */
export async function countActiveMediaJobs(userId?: string): Promise<number> {
  const row = userId
    ? getOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM media_jobs WHERE status IN ('queued','running') AND user_id = ?",
        [userId],
      )
    : getOne<{ n: number }>("SELECT COUNT(*) AS n FROM media_jobs WHERE status IN ('queued','running')");
  return Number(row?.n ?? 0);
}

/**
 * Mark in-flight jobs as failed on startup.
 *
 * A job runs in this process. Nothing upstream is resumable, and a job that was
 * `running` when the process died is not going to finish — so the honest move is
 * to say so once, rather than leave a row that polls as `running` forever.
 */
export async function failInterruptedMediaJobs(): Promise<number> {
  return run(
    `UPDATE media_jobs
        SET status = 'failed', finished_at = ?,
            error = ?
      WHERE status IN ('queued','running')`,
    [
      new Date().toISOString(),
      JSON.stringify({
        status: 503,
        code: "job_interrupted",
        message: "the server restarted before this job finished — submit it again",
      }),
    ],
  );
}

/** Drop finished jobs past their TTL. Called when a new job is created. */
export async function pruneExpiredMediaJobs(now = new Date()): Promise<number> {
  return run("DELETE FROM media_jobs WHERE expires_at < ?", [now.toISOString()]);
}

/** Most recent jobs for a user, newest first. */
export async function listMediaJobs(userId: string, limit = 20): Promise<MediaJob[]> {
  return getAll(
    "SELECT * FROM media_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    [userId, limit],
    rowToMediaJob,
  );
}
