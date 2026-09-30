/**
 * tests/unit/media-engine.test.ts
 *
 * The media adapter protocol is data, so it is tested the way data is: the
 * validator rejects nonsense specs, the mapping primitives resolve vendor
 * payloads, and the engine turns a spec into an upstream call without knowing
 * anything about the vendor.
 */
import { describe, it, expect } from "vitest";
import { parseMediaSpec, type MediaProvider, type MediaSpec } from "@/lib/media/spec";
import { applyMapping, executeMedia, getPath } from "@/lib/media/engine";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";
import { computeMediaCredits } from "@/lib/media/billing";
import { encryptSecret } from "@/lib/crypto/secrets";

const PROVIDER: MediaProvider = {
  id: "mp1",
  name: "MiniMax Image",
  baseUrl: "https://api.minimax.cn",
  encryptedApiKey: encryptSecret("vendor-key"),
  enabled: true,
  priority: 1,
  models: {},
  specs: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MINIMAX_OK = {
  id: "task-1",
  data: { image_urls: ["https://cdn.example/a.png", "https://cdn.example/b.png"] },
  metadata: { success_count: 2, failed_count: 0 },
  base_resp: { status_code: 0, status_msg: "success" },
};

describe("parseMediaSpec", () => {
  it("accepts the shipped MiniMax seed", () => {
    const parsed = parseMediaSpec(MINIMAX_IMAGE_SPEC);
    expect(parsed.ok).toBe(true);
  });

  it("rejects an unknown capability and a bad path", () => {
    const parsed = parseMediaSpec({
      specVersion: 2,
      capability: "image.hologram",
      transport: { method: "POST", path: "v1/nope" },
      auth: { type: "bearer" },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("capability");
    expect(parsed.errors.join(" ")).toContain("transport.path");
  });

  it("rejects a transform mixed with plain keys", () => {
    const parsed = parseMediaSpec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
      request: { $const: 1, nope: "$.x" },
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("getPath", () => {
  const value = { a: { b: [{ c: 1 }] } };
  it("reads dotted and indexed paths", () => {
    expect(getPath(value, "$.a.b[0].c")).toBe(1);
    expect(getPath(value, "$")).toBe(value);
    expect(getPath(value, "$.a.missing")).toBeUndefined();
  });
});

describe("applyMapping", () => {
  const scope = {
    model: "image-01",
    size: "1536x1024",
    response_format: "b64_json",
    image: "https://cdn/ref.png",
  };

  it("passes a path through, and drops keys that resolve to nothing", () => {
    expect(applyMapping({ model: "$.model", nope: "$.missing" }, scope)).toEqual({
      model: "image-01",
    });
  });

  it("maps OpenAI size to a vendor aspect ratio", () => {
    const mapping = (MINIMAX_IMAGE_SPEC.request as Record<string, unknown>).aspect_ratio;
    expect(applyMapping(mapping, scope)).toBe("3:2");
    expect(applyMapping(mapping, { ...scope, size: "nonsense" })).toBe("1:1");
  });

  it("maps response_format onto the vendor vocabulary", () => {
    const mapping = (MINIMAX_IMAGE_SPEC.request as Record<string, unknown>).response_format;
    // `/v1/images/*` whitelist the body, so the normalised camelCase key is the
    // only one in scope. Using `$.response_format` here silently fell through to
    // the default and downgraded every `b64_json` request to `url`.
    expect(applyMapping(mapping, { responseFormat: "b64_json" })).toBe("base64");
    expect(applyMapping(mapping, { responseFormat: "url" })).toBe("url");
    expect(applyMapping(mapping, {})).toBe("url");
  });

  it("emits subject_reference only when an image is present", () => {
    const mapping = (MINIMAX_IMAGE_SPEC.request as Record<string, unknown>).subject_reference;
    expect(applyMapping(mapping, { ...scope, image: "https://cdn/ref.png" })).toEqual([
      { type: "character", image_file: "https://cdn/ref.png" },
    ]);
    expect(applyMapping(mapping, { model: "image-01" })).toBeUndefined();
  });

  it("projects arrays with $from/$to and compares with $eq", () => {
    const vendor = {
      data: { image_urls: ["u1", "u2"] },
      base_resp: { status_code: 1026 },
    };
    const response = MINIMAX_IMAGE_SPEC.response as Record<string, unknown>;
    expect(applyMapping(response.items, vendor)).toEqual([
      { kind: "url", value: "u1" },
      { kind: "url", value: "u2" },
    ]);
    const rule = (MINIMAX_IMAGE_SPEC.errors ?? []).find((r) =>
      JSON.stringify(r.when).includes("1026"),
    )?.when;
    expect(applyMapping(rule, vendor)).toBe(true);
    expect(applyMapping(rule, MINIMAX_OK)).toBe(false);
  });
});

describe("computeMediaCredits", () => {
  it("treats pricePerItem as whole 积分 and converts to 0.001-unit storage", () => {
    // 2 积分/张 × 3 张 = 6 积分 = 6000 units.
    expect(computeMediaCredits(2, 3)).toBe(6000);
    // The regression this guards: 100 积分 used to be stored as 100 units and
    // therefore billed (and displayed) as 0.1 积分.
    expect(computeMediaCredits(100, 1)).toBe(100_000);
  });
  it("treats a zero or negative price as free", () => {
    expect(computeMediaCredits(0, 5)).toBe(0);
    expect(computeMediaCredits(-5, 2)).toBe(0);
  });
  it("ignores non-finite input", () => {
    expect(computeMediaCredits(Number.NaN, 2)).toBe(0);
    expect(computeMediaCredits(2, Number.NaN)).toBe(0);
  });
});

describe("executeMedia (MiniMax spec)", () => {
  it("maps the request and returns url items", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return jsonResponse(MINIMAX_OK);
    }) as unknown as typeof fetch;

    const outcome = await executeMedia({
      spec: MINIMAX_IMAGE_SPEC,
      provider: PROVIDER,
      input: { model: "image-01", prompt: "a cat", n: 2, size: "1536x1024" },
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.items).toEqual([
      { kind: "url", value: "https://cdn.example/a.png" },
      { kind: "url", value: "https://cdn.example/b.png" },
    ]);
    expect(outcome.result.successCount).toBe(2);

    expect(calls[0].url).toBe("https://api.minimax.cn/v1/image_generation");
    const sent = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect(sent.model).toBe("image-01");
    expect(sent.aspect_ratio).toBe("3:2");
    expect(sent.response_format).toBe("url");
  });

  it("translates a vendor error code even though the HTTP status is 200", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        data: {},
        base_resp: { status_code: 1026, status_msg: "sensitive" },
      })) as unknown as typeof fetch;

    const outcome = await executeMedia({
      spec: MINIMAX_IMAGE_SPEC,
      provider: PROVIDER,
      input: { model: "image-01", prompt: "x" },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.status).toBe(400);
    expect(outcome.error.code).toBe("content_filter");
  });

  it("rejects n above the spec limit before calling upstream", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse(MINIMAX_OK);
    }) as unknown as typeof fetch;

    const outcome = await executeMedia({
      spec: MINIMAX_IMAGE_SPEC,
      provider: PROVIDER,
      input: { model: "image-01", prompt: "x", n: 12 },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("executeMedia (async provider)", () => {
  const ASYNC_SPEC: MediaSpec = {
    specVersion: 2,
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
        successValues: ["SUCCEEDED"],
        failureValues: ["FAILED"],
      },
    },
  };

  it("submits, then polls until the task succeeds", async () => {
    const seen: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      seen.push(target);
      if (target.endsWith("/v1/videos")) {
        return jsonResponse({ task_id: "abc" });
      }
      poll += 1;
      if (poll === 1) return jsonResponse({ status: "RUNNING" });
      return jsonResponse({ status: "SUCCEEDED", output: { urls: ["https://cdn/v.mp4"] } });
    }) as unknown as typeof fetch;

    const outcome = await executeMedia({
      spec: ASYNC_SPEC,
      provider: { ...PROVIDER, baseUrl: "https://video.example" },
      input: { model: "vid-1", prompt: "a wave" },
      fetchImpl,
    });

    expect(seen[0]).toBe("https://video.example/v1/videos");
    expect(seen[1]).toBe("https://video.example/v1/videos/abc");
    expect(seen[2]).toBe("https://video.example/v1/videos/abc");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.items).toEqual([{ kind: "url", value: "https://cdn/v.mp4" }]);
    expect(outcome.result.taskId).toBe("abc");
  });

  it("fails the call when the task itself fails", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/v1/videos")) return jsonResponse({ task_id: "abc" });
      return jsonResponse({ status: "FAILED" });
    }) as unknown as typeof fetch;

    const outcome = await executeMedia({
      spec: ASYNC_SPEC,
      provider: { ...PROVIDER, baseUrl: "https://video.example" },
      input: { model: "vid-1", prompt: "x" },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("upstream_task_failed");
  });
});
