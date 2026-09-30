/**
 * tests/unit/media-fetch.test.ts
 *
 * `$fetch` — a follow-up GET used when the upstream hands back an id that has
 * to be exchanged for a real URL (MiniMax video: `file_id` → download URL).
 *
 * The point of these tests is that the exchange happens **inside** the spec's
 * response mapping, so the client still receives a plain `url`.
 */
import { describe, it, expect } from "vitest";
import { applyMapping, executeMedia } from "@/lib/media/engine";
import { parseMediaSpec, type MediaProvider } from "@/lib/media/spec";
import { encryptSecret } from "@/lib/crypto/secrets";

function makeProvider(): MediaProvider {
  return {
    id: "mp",
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn",
    encryptedApiKey: encryptSecret("k"),
    enabled: true,
    priority: 1,
    models: {},
    specs: [],
    createdAt: "",
    updatedAt: "",
  };
}

const VIDEO_SPEC = {
  specVersion: 1,
  capability: "video.generate",
  transport: { method: "POST", path: "/v1/video_generation" },
  auth: { type: "bearer" },
  request: { model: "$.model", prompt: "$.prompt" },
  response: {
    taskId: "$.task_id",
    status: "$.status",
    items: [
      {
        kind: "url",
        value: {
          $fetch: {
            path: "$.file_id",
            url: "/v1/files/retrieve?file_id={{ $.file_id }}",
            pick: "$.file.download_url",
          },
        },
      },
    ],
    successCount: { $const: 1 },
  },
  async: {
    submitTaskId: "$.task_id",
    poll: {
      method: "GET",
      path: "/v1/query/video_generation?task_id={{taskId}}",
      intervalMs: 1,
      timeoutMs: 5000,
      statusPath: "$.status",
      // MiniMax documents the terminal status in lower case.
      successValues: ["success"],
      failureValues: ["failed", "Fail"],
    },
  },
} as unknown as MediaSpecType;

type MediaSpecType = ReturnType<typeof parseMediaSpec> extends { ok: true; spec: infer S }
  ? S
  : never;

describe("$fetch primitive", () => {
  it("stays a pure marker while mapping (no network during applyMapping)", () => {
    const mapped = applyMapping(
      { $fetch: { path: "$.file_id", url: "/v1/files/retrieve?file_id={{ $.file_id }}", pick: "$.file.download_url" } },
      { file_id: "abc 123" },
    ) as Record<string, { url: string; pick: string }>;
    expect(mapped.__fetch.url).toBe("/v1/files/retrieve?file_id=abc%20123");
    expect(mapped.__fetch.pick).toBe("$.file.download_url");
  });

  it("resolves the id into a real URL during executeMedia", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      seen.push(target);
      if (target.startsWith("https://api.minimax.cn/v1/video_generation")) {
        return new Response(JSON.stringify({ task_id: "t-1", base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (target.includes("/v1/query/video_generation")) {
        return new Response(
          JSON.stringify({
            task_id: "t-1",
            status: "success",
            file_id: "205258526306433",
            base_resp: { status_code: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // The follow-up retrieve.
      return new Response(
        JSON.stringify({ file: { download_url: "https://cdn.minimax/out.mp4" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await executeMedia({
      spec: VIDEO_SPEC,
      provider: makeProvider(),
      input: { model: "MiniMax-Hailuo-02", prompt: "a wave" },
      fetchImpl,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Lower-case `success` converged (no timeout) and the id became a URL.
    expect(out.result.items).toEqual([
      { kind: "url", value: "https://cdn.minimax/out.mp4" },
    ]);
    expect(seen.some((u) => u.includes("/v1/files/retrieve?file_id=205258526306433"))).toBe(
      true,
    );
  });
});

describe("spec validation for polling placeholders", () => {
  it("rejects {{taskId}} on the submit path", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation?task_id={{taskId}}" },
      auth: { type: "bearer" },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("async.poll.path");
  });

  it("still allows {{taskId}} on the poll path", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation" },
      auth: { type: "bearer" },
      async: {
        submitTaskId: "$.task_id",
        poll: {
          method: "GET",
          path: "/v1/query/video_generation?task_id={{taskId}}",
          successValues: ["Success"],
          failureValues: ["Fail"],
        },
      },
    });
    expect(parsed.ok).toBe(true);
  });
});
