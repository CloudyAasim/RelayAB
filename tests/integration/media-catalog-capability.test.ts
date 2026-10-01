/**
 * tests/integration/media-catalog-capability.test.ts
 *
 * A provider can hold specs of several capabilities. The catalogue used to read
 * `provider.specs[0]` for every model, which is only correct while a provider has
 * one spec — configuring the real AgnesCN provider (an image spec *and* a video
 * spec) advertised `agnes-video-2.5-flash` as `image.generate` and dropped the
 * video spec's `modes`/`async` metadata entirely.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createMediaProvider } from "@/lib/db/media-providers";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";

const IMAGE_SPEC = {
  specVersion: 1,
  capability: "image.generate",
  displayName: "Agnes 图像",
  models: ["agnes-image-2.1-flash"],
  transport: { method: "POST", path: "/v1/images/generations", contentType: "application/json" },
  auth: { type: "bearer" },
  request: { model: "$.model", prompt: "$.prompt" },
  response: { items: { $from: "$.data", $to: { kind: "url", value: "$.url" } } },
  limits: { maxN: 1, timeoutMs: 180000 },
  metadata: { modes: ["text-to-image"], sizes: ["1024x1024"], max_n: 1 },
};

const VIDEO_SPEC = {
  specVersion: 1,
  capability: "video.generate",
  displayName: "Agnes Video 2.5 Flash",
  models: ["agnes-video-2.5-flash"],
  transport: { method: "POST", path: "/v1/videos", contentType: "application/json" },
  auth: { type: "bearer" },
  request: { model: "$.model", prompt: "$.prompt", mode: { $const: "text" } },
  response: { taskId: "$.video_id", status: "$.status", items: [{ kind: "url", value: "$.url" }] },
  async: {
    submitTaskId: "$.video_id",
    poll: {
      method: "GET",
      path: "/agnesapi?video_id={{taskId}}&model_name=agnes-video-2.5-flash",
      statusMap: { queued: "wait", completed: "ok", failed: "fail", "": "wait" },
    },
  },
  limits: { maxN: 1, timeoutMs: 240000 },
  metadata: { modes: ["text-to-video"], async: true, sizes: ["1280x720"] },
};

async function asJson(res: Response): Promise<{ body: any }> {
  return { body: await res.json() };
}

describe("media catalogue capability per model", () => {
  beforeEach(async () => {
    __resetDbForTest();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
    await createMediaProvider({
      name: "AgnesCN",
      baseUrl: "https://api.agnes-ai.cn",
      apiKey: "agnes-key",
      models: {
        "agnes-image-2.1-flash": { upstreamId: "agnes-image-2.1-flash", pricePerItem: 0, enabled: true },
        "agnes-video-2.5-flash": { upstreamId: "agnes-video-2.5-flash", pricePerItem: 0, enabled: true },
      },
      specs: [IMAGE_SPEC, VIDEO_SPEC] as unknown as Record<string, unknown>[],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function listMedia() {
    const user = await createUser({
      username: "catuser",
      password: "longenoughpassword",
      quotaType: "credits",
      quotaLimit: 1_000_000,
    });
    const { plainKey } = await createApiKey({ userId: user.id, label: "catalog" });
    const { GET } = await import("@/app/api/v1/models/route");
    const res = await GET(new Request("http://localhost/api/v1/models", {
      headers: { authorization: `Bearer ${plainKey}` },
    }));
    const { body } = await asJson(res);
    return body.data.filter((m: { relay?: { kind?: string } }) => m.relay?.kind === "media");
  }

  it("labels the video model with its own capability and metadata", async () => {
    const media = await listMedia();
    const video = media.find((m: { id: string }) => m.id === "agnes-video-2.5-flash");
    expect(video, "video model missing from the catalogue").toBeDefined();
    // The bug: this used to be "image.generate" because the image spec came first.
    expect(video.relay.capability).toBe("video.generate");
    expect(video.relay.modes).toEqual(["text-to-video"]);
    expect(video.relay.async).toBe(true);
    expect(video.relay.sizes).toContain("1280x720");
  });

  it("labels the image model with the image spec", async () => {
    const media = await listMedia();
    const image = media.find((m: { id: string }) => m.id === "agnes-image-2.1-flash");
    expect(image.relay.capability).toBe("image.generate");
    expect(image.relay.modes).toEqual(["text-to-image"]);
    expect(image.relay.edit_mode).toBeUndefined();
  });
});
