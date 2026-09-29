/**
 * tests/integration/media-images.test.ts
 *
 * End-to-end through the real route handlers: an API key calls
 * `POST /v1/images/generations` (and `edits`), the relay resolves the media
 * provider by model name, runs the provider's spec against a stubbed upstream,
 * charges per produced image and records the usage row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey, getApiKeyByPlaintext } from "@/lib/db/keys";
import { listUsageByKey } from "@/lib/db/usage";
import { createMediaProvider } from "@/lib/db/media-providers";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";

const UPSTREAM_OK = {
  id: "task-1",
  data: { image_urls: ["https://cdn.example/a.png"] },
  metadata: { success_count: 1, failed_count: 0 },
  base_resp: { status_code: 0, status_msg: "success" },
};

async function asJson(res: Response): Promise<{ status: number; body: any }> {
  const status = res.status;
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status, body };
}

describe("media image endpoints", () => {
  let calls: Array<{ url: string; body: string }> = [];

  beforeEach(async () => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    calls = [];

    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(UPSTREAM_OK), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await createMediaProvider({
      name: "MiniMax Image",
      baseUrl: "https://api.minimax.cn",
      apiKey: "vendor-key",
      models: {
        "image-01": { upstreamId: "image-01", pricePerItem: 2000, enabled: true },
      },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function makeKey() {
    const user = await createUser({
      username: "mediauser",
      password: "longenoughpassword",
      quotaType: "credits",
      quotaLimit: 1_000_000,
    });
    const { plainKey } = await createApiKey({ userId: user.id, label: "media" });
    return { user, plainKey };
  }

  it("generates images, charges per item and records usage", async () => {
    const { user, plainKey } = await makeKey();
    const { POST } = await import("@/app/api/v1/images/generations/route");

    const res = await POST(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { authorization: `Bearer ${plainKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "image-01", prompt: "a cat", size: "1024x1024" }),
      }),
    );
    const { status, body } = await asJson(res);

    expect(status).toBe(200);
    expect(body.data[0].url).toBe("https://cdn.example/a.png");
    expect(calls[0].url).toBe("https://api.minimax.cn/v1/image_generation");

    // 2000 units = 2 积分 for the one image that came back.
    const owner = await getUserById(user.id);
    expect(owner?.quotaUsed).toBe(2000);

    const key = await getApiKeyByPlaintext(plainKey);
    const logs = await listUsageByKey(key!.id);
    expect(logs[0].images).toBe(1);
    expect(logs[0].creditsUsed).toBe(2000);
    expect(logs[0].capability).toBe("image.generate");
  });

  it("rejects an unknown media model", async () => {
    const { plainKey } = await makeKey();
    const { POST } = await import("@/app/api/v1/images/generations/route");
    const res = await POST(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { authorization: `Bearer ${plainKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "x" }),
      }),
    );
    const { status, body } = await asJson(res);
    expect(status).toBe(404);
    expect(body.error.code).toBe("model_not_found");
  });

  it("maps an uploaded image to a subject reference on the edit endpoint", async () => {
    const { plainKey } = await makeKey();
    const { POST } = await import("@/app/api/v1/images/edits/route");

    const form = new FormData();
    form.append("model", "image-01");
    form.append("prompt", "same character, new scene");
    form.append("size", "1024x1024");
    form.append("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "ref.png");

    const res = await POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { authorization: `Bearer ${plainKey}` },
        body: form,
      }),
    );
    const { status, body } = await asJson(res);

    expect(status).toBe(200);
    expect(body.data[0].url).toBe("https://cdn.example/a.png");

    const sent = JSON.parse(calls[0].body) as Record<string, unknown>;
    const references = sent.subject_reference as Array<Record<string, string>>;
    expect(references[0].type).toBe("character");
    expect(references[0].image_file).toMatch(/^data:image\/png;base64,/);
  });

  it("lists media models with relay metadata but keeps them off the Anthropic surface", async () => {
    const { plainKey } = await makeKey();
    const { GET: openaiModels } = await import("@/app/api/v1/models/route");
    const { GET: anthropicModels } = await import("@/app/api/anthropic/v1/models/route");

    const authed = { authorization: `Bearer ${plainKey}` };
    const openaiRes = await openaiModels(
      new Request("http://localhost/api/v1/models", { headers: authed }),
    );
    const openai = await asJson(openaiRes);
    const media = openai.body.data.find((m: any) => m.id === "image-01");
    expect(media).toBeDefined();
    expect(media.relay.kind).toBe("media");
    expect(media.relay.capability).toBe("image.generate");
    expect(media.relay.edit_mode).toBe("reference");
    expect(media.relay.sizes).toContain("1024x1024");

    const anthropicRes = await anthropicModels(
      new Request("http://localhost/api/anthropic/v1/models", { headers: authed }),
    );
    const anthropic = await asJson(anthropicRes);
    const ids = (anthropic.body.data ?? []).map((m: any) => m.id);
    expect(ids).not.toContain("image-01");
  });
});
