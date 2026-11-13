/**
 * tests/unit/media-jobs.test.ts
 *
 * The async media job API: `POST /v1/media/jobs` → 202, then poll.
 *
 * Why it exists: the synchronous media routes must answer with one status code,
 * which forces the heartbeat trade-off (commit 200 after 20 s, so a later
 * failure is an error envelope inside 200). A job has no such constraint — the
 * client is not holding the connection — so "how long may a vendor take" stops
 * being a decision the relay has to make on the client's behalf.
 *
 * What is pinned here:
 *   - submit answers 202 with a pollable id, before the work is done;
 *   - the work runs in-process and the poll eventually shows the same payload
 *     the synchronous route would have returned;
 *   - a failure is reported as a failed job with the upstream's error;
 *   - another account cannot read (or cancel) the job;
 *   - cancellation stops a job that is already running;
 *   - a job interrupted by a restart is marked as such instead of polling
 *     `running` forever;
 *   - the per-account in-flight limit is enforced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { createMediaProvider } from "@/lib/db/media-providers";
import { listUsageByKey } from "@/lib/db/usage";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";
import { POST as submitPOST } from "@/app/api/v1/media/jobs/route";
import { GET as jobGET, DELETE as jobDELETE } from "@/app/api/v1/media/jobs/[id]/route";
import { claimMediaJob, createMediaJob, failMediaJobsWithoutUpstream, getMediaJob, setMediaJobUpstream } from "@/lib/db/media-jobs";
import { resumeMediaJob } from "@/lib/media/jobs";
import { ASYNC_SPEC_FOR_TEST } from "./async-spec-fixture";

const UPSTREAM_OK = {
  id: "task-1",
  data: { image_urls: ["https://cdn.example/a.png"] },
  metadata: { success_count: 1, failed_count: 0 },
  base_resp: { status_code: 0, status_msg: "success" },
};

async function seed(): Promise<{ plain: string; keyId: string }> {
  const user = await createUser({
    username: "j-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 10_000,
    allowedModels: [],
  });
  const key = await createApiKey({ userId: user.id, label: "jobs" });
  await createMediaProvider({
    name: "MiniMax Image",
    baseUrl: "https://api.minimax.cn",
    apiKey: "vendor-key",
    models: { "image-01": { upstreamId: "image-01", pricePerItem: 2, enabled: true } },
    specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
  });
  return { plain: key.plainKey, keyId: key.key.id };
}

/** A provider whose spec submits a task and polls it. */
async function seedAsync(): Promise<{ plain: string; keyId: string; providerId: string }> {
  const user = await createUser({
    username: "j-async-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 10_000,
    allowedModels: [],
  });
  const key = await createApiKey({ userId: user.id, label: "jobs" });
  const provider = await createMediaProvider({
    name: "Async Video",
    baseUrl: "https://async.test",
    apiKey: "vendor-key",
    models: { vid: { upstreamId: "vid-up", pricePerItem: 2, enabled: true } },
    specs: [ASYNC_SPEC_FOR_TEST as unknown as Record<string, unknown>],
  });
  return { plain: key.plainKey, keyId: key.key.id, providerId: provider.id };
}

function submit(plain: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/v1/media/jobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${plain}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function poll(request: Request, id: string) {
  return jobGET(request, { params: Promise.resolve({ id }) });
}

async function waitFor(
  plain: string,
  id: string,
  wanted: string[],
  timeoutMs = 5_000,
): Promise<{ status: string; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  const req = new Request(`http://localhost:3000/v1/media/jobs/${id}`, {
    headers: { Authorization: `Bearer ${plain}` },
  });
  while (Date.now() < deadline) {
    const res = await poll(req, id);
    const body = (await res.json()) as Record<string, unknown>;
    if (wanted.includes(String(body.status))) return { status: String(body.status), body };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${id} never reached ${wanted.join("/")} within ${timeoutMs}ms`);
}

describe("async media jobs", () => {
  beforeEach(() => {
    __resetDbForTest();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify(UPSTREAM_OK), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers 202 with a pollable id before the work is done", async () => {
    const { plain } = await seed();
    const res = await submitPOST(submit(plain, { capability: "image.generate", model: "image-01", prompt: "a cat" }));

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("media.job");
    // Either it has not started yet or it is already running — both are "not
    // done", which is the whole point of the endpoint.
    expect(["queued", "running"]).toContain(String(body.status));
    expect(res.headers.get("Location")).toBe(`/v1/media/jobs/${body.id}`);
  });

  it("finishes with the same payload the synchronous route would have returned", async () => {
    const { plain, keyId } = await seed();
    const res = await submitPOST(submit(plain, { capability: "image.generate", model: "image-01", prompt: "a cat" }));
    const { id } = (await res.json()) as { id: string };

    const done = await waitFor(plain, id, ["succeeded"]);
    const result = done.body.result as { data: Array<{ url?: string }> };
    expect(result.data[0].url).toBe("https://cdn.example/a.png");
    expect(done.body.error).toBeNull();

    // Billed exactly once, on the successful job.
    expect(await listUsageByKey(keyId)).toHaveLength(1);
  });

  it("reports an upstream failure as a failed job", async () => {
    const { plain } = await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "bad key" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await submitPOST(submit(plain, { capability: "image.generate", model: "image-01", prompt: "x" }));
    const { id } = (await res.json()) as { id: string };
    const done = await waitFor(plain, id, ["failed"]);

    const error = done.body.error as { code: string };
    expect(error.code).toBe("upstream_auth_failed");
  });

  it("hides a job from another account", async () => {
    const { plain } = await seed();
    const other = await seed();
    const res = await submitPOST(submit(plain, { capability: "image.generate", model: "image-01", prompt: "x" }));
    const { id } = (await res.json()) as { id: string };

    const req = new Request(`http://localhost:3000/v1/media/jobs/${id}`, {
      headers: { Authorization: `Bearer ${other.plain}` },
    });
    expect((await poll(req, id)).status).toBe(404);
    expect((await jobDELETE(req, { params: Promise.resolve({ id }) })).status).toBe(404);
  });

  it("stops a running job when the client cancels it", async () => {
    const { plain } = await seed();
    // A vendor that never answers, until the abort arrives.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    const res = await submitPOST(submit(plain, { capability: "image.generate", model: "image-01", prompt: "x" }));
    const { id } = (await res.json()) as { id: string };
    await waitFor(plain, id, ["running"]);

    const del = await jobDELETE(
      new Request(`http://localhost:3000/v1/media/jobs/${id}`, {
        headers: { Authorization: `Bearer ${plain}` },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(del.status).toBe(200);

    const done = await waitFor(plain, id, ["failed"]);
    expect((done.body.error as { code: string }).code).toBe("job_cancelled");
  });

  it("marks a job that never reached the vendor as interrupted", async () => {
    const user = await createUser({
      username: "j-int-" + Math.random().toString(36).slice(2, 8),
      password: "x",
      quotaType: "credits",
      quotaLimit: 1000,
      allowedModels: [],
    });
    const job = await createMediaJob({
      userId: user!.id,
      apiKeyId: null,
      capability: "image.generate",
      model: "image-01",
      request: { model: "image-01", prompt: "x" },
    });

    // No upstream id: nothing to resume, so saying so is the honest outcome.
    expect(await failMediaJobsWithoutUpstream()).toBeGreaterThanOrEqual(1);
    const after = await getMediaJob(job.id);
    expect(after?.status).toBe("failed");
    expect(after?.error?.code).toBe("job_interrupted");
  });

  it("finishes an async vendor's job by polling the upstream task id", async () => {
    const { plain, keyId } = await seedAsync();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Submit answers with a task id; the poll answers with the result.
        return String(url).endsWith("/v1/videos")
          ? new Response(JSON.stringify({ task_id: "up_1", status: "WAITING" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ status: "SUCCEEDED", output: { urls: ["https://cdn.example/v.mp4"] } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      }),
    );

    const res = await submitPOST(submit(plain, { capability: "video.generate", model: "vid", prompt: "a wave" }));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    const done = await waitFor(plain, id, ["succeeded"], 8_000);
    const result = done.body.result as { data: Array<{ url?: string }> };
    expect(result.data[0].url).toBe("https://cdn.example/v.mp4");
    // Both phases happened, and the poll used the stored id.
    expect(seen.some((u) => u.endsWith("/v1/videos/up_1"))).toBe(true);
    expect(await listUsageByKey(keyId)).toHaveLength(1);
  });

  it("resumes a job from its stored upstream task id (a restart)", async () => {
    const { plain, providerId } = await seedAsync();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ status: "SUCCEEDED", output: { urls: ["https://cdn.example/resumed.mp4"] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const user = await createUser({
      username: "j-resume-" + Math.random().toString(36).slice(2, 8),
      password: "x",
      quotaType: "credits",
      quotaLimit: 1000,
      allowedModels: [],
    });
    // A real key on that user: the job bills through it when it settles.
    const jobKey = await createApiKey({ userId: user!.id, label: "resume" });
    const job = await createMediaJob({
      userId: user!.id,
      apiKeyId: jobKey.key.id,
      capability: "video.generate",
      model: "vid",
      request: { model: "vid", prompt: "a wave" },
    });
    // What a process would have left behind: running, with the vendor's id.
    await claimMediaJob(job.id);
    await setMediaJobUpstream(job.id, { taskId: "up_9", providerId });

    await resumeMediaJob(job.id);

    const after = await getMediaJob(job.id);
    expect(after?.status).toBe("succeeded");
    const result = after?.result as { data: Array<{ url?: string }> };
    expect(result.data[0].url).toBe("https://cdn.example/resumed.mp4");
    expect(plain).toBeTruthy();
  });

  it("refuses more in-flight jobs than the account limit", async () => {
    const { plain } = await seed();
    const user = await createUser({
      username: "j-limit-" + Math.random().toString(36).slice(2, 8),
      password: "x",
      quotaType: "credits",
      quotaLimit: 1000,
      allowedModels: [],
    });
    // Seed the queue with the real rows, then submit with a key of that user.
    const key = await createApiKey({ userId: user!.id, label: "l" });
    for (let i = 0; i < 3; i++) {
      await createMediaJob({
        userId: user!.id,
        apiKeyId: key.key.id,
        capability: "image.generate",
        model: "image-01",
        request: { model: "image-01", prompt: "x" },
      });
    }

    const res = await submitPOST(
      submit(key.plainKey, { capability: "image.generate", model: "image-01", prompt: "x" }),
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("too_many_jobs");
    expect(plain).toBeTruthy();
  });

  it("refuses a capability that is not a job (TTS, transcription)", async () => {
    const { plain } = await seed();
    const res = await submitPOST(submit(plain, { capability: "audio.tts", model: "tts-1", input: "hi" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unsupported_capability");
  });
});
