/**
 * tests/integration/media-audio-video.test.ts
 *
 * The same engine drives every media capability; what differs is the endpoint
 * and how the body comes back. Covers:
 *   - video   → asynchronous vendor (submit + poll) collapsed into one response
 *   - speech  → binary passthrough (audio bytes must never be JSON-parsed)
 *   - audio   → multipart upload built by the `$file` transform, transcript back
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { createMediaProvider } from "@/lib/db/media-providers";
import type { MediaSpec } from "@/lib/media/spec";

const VIDEO_SPEC = {
  specVersion: 1,
  capability: "video.generate",
  transport: { method: "POST", path: "/v1/videos" },
  auth: { type: "bearer" },
  request: { model: "$.model", prompt: "$.prompt" },
  response: {
    taskId: "$.task_id",
    status: "$.status",
    items: { $from: "$.output.urls", $to: { kind: "url", value: "$" } },
  },
  async: {
    submitTaskId: "$.task_id",
    poll: {
      method: "GET",
      path: "/v1/videos/{{taskId}}",
      intervalMs: 1,
      timeoutMs: 5000,
      statusPath: "$.status",
      successValues: ["SUCCEEDED"],
      failureValues: ["FAILED"],
    },
  },
} as unknown as MediaSpec;

const TTS_SPEC = {
  specVersion: 1,
  capability: "audio.tts",
  transport: { method: "POST", path: "/v1/tts" },
  auth: { type: "bearer" },
  responseMode: "binary",
  request: { model: "$.model", input: "$.input", voice: "$.voice" },
} as unknown as MediaSpec;

const STT_SPEC = {
  specVersion: 1,
  capability: "audio.stt",
  transport: {
    method: "POST",
    path: "/v1/stt",
    contentType: "multipart/form-data",
  },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    file: {
      $file: { path: "$.image", filename: "$.filename", contentType: "audio/mpeg" },
    },
    language: "$.language",
  },
  response: { text: "$.text" },
} as unknown as MediaSpec;

async function asJson(res: Response): Promise<{ status: number; body: any }> {
  const status = res.status;
  const text = await res.text();
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    return { status, body: text };
  }
}

describe("media video / audio endpoints", () => {
  let calls: Array<{ url: string; body: unknown }> = [];

  beforeEach(async () => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    calls = [];

    const user = await createUser({
      username: "mediauser2",
      password: "longenoughpassword",
      quotaType: "credits",
      quotaLimit: 1_000_000,
    });
    const { plainKey } = await createApiKey({ userId: user.id, label: "media" });
    (globalThis as unknown as Record<string, unknown>).__mediaKey = plainKey;

    await createMediaProvider({
      name: "Mock Media",
      baseUrl: "https://media.example",
      apiKey: "vendor-key",
      models: {
        "video-01": { upstreamId: "video-01", pricePerItem: 5000, enabled: true },
        "tts-1": { upstreamId: "tts-1", pricePerItem: 1000, enabled: true },
        "stt-1": { upstreamId: "stt-1", pricePerItem: 1500, enabled: true },
      },
      specs: [VIDEO_SPEC, TTS_SPEC, STT_SPEC],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const key = () => (globalThis as unknown as Record<string, string>).__mediaKey;
  const authed = (model: string) => ({
    authorization: `Bearer ${key()}`,
    "content-type": "application/json",
  });

  it("video: submits, polls, and returns the finished clip", async () => {
    let poll = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body });
      if (String(url).endsWith("/v1/videos")) {
        return new Response(JSON.stringify({ task_id: "task-9" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      poll += 1;
      const payload =
        poll === 1
          ? { status: "RUNNING" }
          : { status: "SUCCEEDED", output: { urls: ["https://cdn/v.mp4"] } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/v1/videos/generations/route");
    const res = await POST(
      new Request("http://localhost/api/v1/videos/generations", {
        method: "POST",
        headers: authed("video-01"),
        body: JSON.stringify({ model: "video-01", prompt: "a wave" }),
      }),
    );
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.data[0].url).toBe("https://cdn/v.mp4");
    expect(body.id).toBe("task-9");
    expect(calls[0].url).toBe("https://media.example/v1/videos");
    expect(calls[1].url).toBe("https://media.example/v1/videos/task-9");
  });

  it("speech: returns the upstream audio bytes untouched", async () => {
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });

    const { POST } = await import("@/app/api/v1/audio/speech/route");
    const res = await POST(
      new Request("http://localhost/api/v1/audio/speech", {
        method: "POST",
        headers: authed("tts-1"),
        body: JSON.stringify({ model: "tts-1", input: "hello", voice: "alloy" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ input: "hello", voice: "alloy" });
  });

  it("transcriptions: uploads audio as a real multipart file and returns text", async () => {
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/v1/audio/transcriptions/route");
    const form = new FormData();
    form.append("model", "stt-1");
    form.append("language", "en");
    form.append("file", new Blob([new Uint8Array([9, 9, 9])], { type: "audio/mpeg" }), "clip.mp3");

    const res = await POST(
      new Request("http://localhost/api/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${key()}` },
        body: form,
      }),
    );
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.text).toBe("hello world");

    const upstream = calls[0].body as FormData;
    expect(upstream).toBeInstanceOf(FormData);
    const file = upstream.get("file") as File;
    expect(file.name).toBe("clip.mp3");
    expect(file.size).toBe(3);
    expect(upstream.get("language")).toBe("en");
  });
});
