/**
 * tests/unit/media-engine-diagnostics.test.ts
 *
 * When an async provider answers 2xx with no task id, the old message was
 * "upstream did not return a task id" and nothing else. That is a dead end:
 * the likeliest cause is the vendor refusing the call — permissions, quota,
 * an account restriction — and saying so in a field the spec does not map.
 *
 * This was not hypothetical: the MiniMax video endpoints return exactly that,
 * and the operator reads "upstream did not return a task id" with no way to
 * tell a bad spec path from a denied account.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { executeMedia } from "@/lib/media/engine";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { MediaProvider, MediaSpec } from "@/lib/media/spec";

afterEach(() => vi.unstubAllGlobals());

function provider(): MediaProvider {
  return {
    id: "p1",
    name: "V",
    baseUrl: "https://v.example",
    encryptedApiKey: encryptSecret("k"),
    enabled: true,
    priority: 0,
    models: { vid: { upstreamId: "vid", enabled: true } },
    specs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MediaProvider;
}

/** Minimal async spec: submits, expects a task id back. */
function asyncSpec(extraErrors: unknown[] = []): MediaSpec {
  return {
    specVersion: 1,
    capability: "video.generate",
    models: ["vid"],
    transport: { method: "POST", path: "/v1/video_generation" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: { taskId: "$.task_id" },
    async: {
      submitTaskId: "$.task_id",
      poll: {
        method: "GET",
        path: "/v1/query/video_generation?task_id={{taskId}}",
        intervalMs: 1,
        timeoutMs: 1000,
        statusPath: "$.status",
        statusMap: { Success: "ok", Fail: "fail" },
      },
    },
    errors: extraErrors,
  } as unknown as MediaSpec;
}

const deniedBody = {
  base_resp: { status_code: 1004, status_msg: "account has no permission for this model" },
};

describe("no_task_id diagnostics", () => {
  it("carries the upstream body so a denial is legible", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(deniedBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const out = await executeMedia({
      spec: asyncSpec(),
      provider: provider(),
      input: { model: "vid", prompt: "a cat" } as never,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("no_task_id");
    // The whole point: the operator can read *why*.
    expect(out.error.message).toContain("no permission for this model");
    expect(out.error.message).toContain("1004");
  });

  it("says so plainly when the body is empty", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));

    const out = await executeMedia({
      spec: asyncSpec(),
      provider: provider(),
      input: { model: "vid", prompt: "a cat" } as never,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("empty body");
  });

  it("still prefers the spec's own error rule when one matches", async () => {
    // A spec that knows about 1004 should keep its own wording; the payload
    // summary is a fallback, not an override.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(deniedBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const out = await executeMedia({
      spec: asyncSpec([{ when: { $eq: ["$.base_resp.status_code", 1004] }, status: 502, code: "upstream_auth_failed" }]),
      provider: provider(),
      input: { model: "vid", prompt: "a cat" } as never,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("upstream_auth_failed");
  });

  it("keeps the summary short enough to stay a message", async () => {
    const huge = { base_resp: { status_msg: "x".repeat(5000) } };
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(huge), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const out = await executeMedia({
      spec: asyncSpec(),
      provider: provider(),
      input: { model: "vid", prompt: "a cat" } as never,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message.length).toBeLessThan(500);
    expect(out.error.message).toContain("…");
  });
});
