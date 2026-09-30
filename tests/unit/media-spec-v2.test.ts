/**
 * tests/unit/media-spec-v2.test.ts
 *
 * Regression cover for the five protocol gaps that produced every recurring
 * failure while MiniMax specs were written by hand. Each test names the bug it
 * prevents from coming back, because none of them are obvious from the code.
 */
import { describe, it, expect } from "vitest";
import { applyMapping, buildMediaScope, executeMedia } from "@/lib/media/engine";
import { parseMediaSpec, validateMediaSpecs, type MediaProvider, type MediaSpec } from "@/lib/media/spec";
import { pickSpecForModel, pickSpecForRequest } from "@/lib/db/media-providers";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "mp",
  name: "MiniMax",
  baseUrl: "https://api.minimax.cn",
  encryptedApiKey: encryptSecret("k"),
  enabled: true,
  priority: 1,
  models: {
    hailuo: { upstreamId: "MiniMax-Hailuo-02", pricePerItem: 500, enabled: true },
    h3: { upstreamId: "MiniMax-H3", pricePerItem: 800, enabled: true },
  },
  specs: [],
  createdAt: "",
  updatedAt: "",
};

const spec = (raw: unknown): MediaSpec => {
  const parsed = parseMediaSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------

describe("gap 1 — two vendor API versions of one capability", () => {
  const v1 = spec({
    specVersion: 2,
    capability: "video.generate",
    models: ["hailuo"],
    transport: { method: "POST", path: "/v1/video_generation" },
    auth: { type: "bearer" },
    response: { taskId: "$.task_id", status: "$.status" },
    async: {
      submitTaskId: "$.task_id",
      poll: { method: "GET", path: "/v1/query?task_id={{taskId}}", statusMap: { Success: "ok", "": "wait" } },
    },
  });
  const v2 = spec({
    specVersion: 2,
    capability: "video.generate",
    models: ["h3"],
    transport: { method: "POST", path: "/v2/video_generation" },
    auth: { type: "bearer" },
    response: { taskId: "$.task_id", status: "$.task.status" },
    async: {
      submitTaskId: "$.task_id",
      poll: { method: "GET", path: "/v2/query/{{taskId}}", statusMap: { succeeded: "ok", "": "wait" } },
    },
  });

  it("routes each model to the spec that declares it", () => {
    const scoped = { ...provider, specs: [v1, v2] };
    expect(pickSpecForModel(scoped, "video.generate", "hailuo")?.transport.path).toBe(
      "/v1/video_generation",
    );
    expect(pickSpecForModel(scoped, "video.generate", "h3")?.transport.path).toBe(
      "/v2/video_generation",
    );
  });

  it("keeps a spec without `models` as the catch-all", () => {
    const unscoped = spec({
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v3/video_generation" },
      auth: { type: "bearer" },
      response: { items: [] },
    });
    const mixed = { ...provider, specs: [v2, unscoped] };
    expect(pickSpecForModel(mixed, "video.generate", "h3")?.transport.path).toBe(
      "/v2/video_generation",
    );
    expect(pickSpecForModel(mixed, "video.generate", "anything")?.transport.path).toBe(
      "/v3/video_generation",
    );
  });

  it("refuses to save two unscoped specs of the same capability", () => {
    const result = validateMediaSpecs([
      {
        specVersion: 2,
        capability: "video.generate",
        transport: { method: "POST", path: "/v1/video_generation" },
        auth: { type: "bearer" },
        response: { items: [] },
      },
      {
        specVersion: 2,
        capability: "video.generate",
        transport: { method: "POST", path: "/v2/video_generation" },
        auth: { type: "bearer" },
        response: { items: [] },
      },
    ]);
    expect(result.errors.join(" ")).toContain("do not list `models`");
  });

  it("refuses a model claimed by two specs", () => {
    const result = validateMediaSpecs([
      {
        specVersion: 2,
        capability: "video.generate",
        models: ["h3"],
        transport: { method: "POST", path: "/a" },
        auth: { type: "bearer" },
        response: { items: [] },
      },
      {
        specVersion: 2,
        capability: "video.generate",
        models: ["h3"],
        transport: { method: "POST", path: "/b" },
        auth: { type: "bearer" },
        response: { items: [] },
      },
    ]);
    expect(result.errors.join(" ")).toContain("already served");
  });

  it("still resolves an image.edit request through image-to-image modes", () => {
    const image = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      response: { items: [] },
      metadata: { modes: ["text-to-image", "image-to-image"] },
    });
    expect(pickSpecForRequest({ ...provider, specs: [image] }, "image.edit", "h3")).toBe(image);
  });
});

// ---------------------------------------------------------------------------

describe("gap 2 — snake_case vs camelCase", () => {
  it("exposes every key under both spellings", () => {
    const scope = buildMediaScope({ prompt: "cat", responseFormat: "b64_json" });
    expect(scope.responseFormat).toBe("b64_json");
    expect(scope.response_format).toBe("b64_json");
  });

  it("aliases a client-supplied snake_case key to camelCase", () => {
    const scope = buildMediaScope({ prompt: "cat", extra: { negative_prompt: "blurry" } });
    expect(scope.negative_prompt).toBe("blurry");
    expect(scope.negativePrompt).toBe("blurry");
  });

  it("resolves to the same value whichever spelling the client used", () => {
    // The OpenAI wire format is snake_case, and the route normalizes it to
    // camelCase; both must read back as the client sent them.
    const snake = buildMediaScope({
      extra: { response_format: "b64_json" },
      responseFormat: "b64_json",
    });
    expect(snake.response_format).toBe("b64_json");
    expect(snake.responseFormat).toBe("b64_json");

    // A client that sent only camelCase still resolves under the snake name.
    const camel = buildMediaScope({ extra: { responseFormat: "b64_json" } });
    expect(camel.responseFormat).toBe("b64_json");
    expect(camel.response_format).toBe("b64_json");
  });

  it("lets a real key win over an alias of another key", () => {
    const scope = buildMediaScope({
      responseFormat: "b64_json",
      extra: { response_format: "url", negative_prompt: "blurry" },
    });
    expect(scope.responseFormat).toBe("b64_json");
    expect(scope.negative_prompt).toBe("blurry");
    expect(scope.negativePrompt).toBe("blurry");
  });

  it("drops absent optionals so $ifPresent still works", () => {
    const scope = buildMediaScope({ model: "m", image: undefined });
    expect("image" in scope).toBe(false);
  });

  it("resolves a spec path whichever way the operator spells it", () => {
    const mapping = {
      $enum: { path: "$.response_format", map: { b64_json: "base64" }, default: "url" },
    };
    // Client sent camelCase (the route normalizes it) …
    expect(applyMapping(mapping, buildMediaScope({ responseFormat: "b64_json" }))).toBe("base64");
    // … and the client sent snake_case (the raw body is passed through).
    expect(applyMapping(mapping, buildMediaScope({ extra: { response_format: "b64_json" } }))).toBe(
      "base64",
    );
  });
});

// ---------------------------------------------------------------------------

describe("gap 3 — upstream encoding", () => {
  const tts = spec({
    specVersion: 2,
    capability: "audio.tts",
    transport: { method: "POST", path: "/v1/t2a_v2" },
    auth: { type: "bearer" },
    request: { text: "$.input", output_format: { $const: "url" } },
    response: { items: [{ kind: "base64", encoding: "hex", value: "$.data.audio" }] },
  });

  it("converts hex to base64 when the spec declares it", async () => {
    const out = await executeMedia({
      spec: tts,
      provider,
      input: { model: "speech-2.8-hd", input: "hi" },
      fetchImpl: (async () =>
        json({ data: { audio: "49443304000000fffb90c4" } })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 49 44 33 04 00 00 00 ff fb 90 c4 == "ID3\x04…" in base64.
    expect(out.result.items).toEqual([{ kind: "base64", value: "SUQzBAAAAP/7kMQ=" }]);
  });

  it("leaves a plain url alone", async () => {
    const urlSpec = spec({
      specVersion: 2,
      capability: "audio.tts",
      transport: { method: "POST", path: "/v1/t2a_v2" },
      auth: { type: "bearer" },
      response: { items: [{ kind: "url", value: "$.data.audio" }] },
    });
    const out = await executeMedia({
      spec: urlSpec,
      provider,
      input: { model: "m", input: "hi" },
      fetchImpl: (async () => json({ data: { audio: "https://cdn/x.mp3" } })) as unknown as typeof fetch,
    });
    expect(out.ok && out.result.items).toEqual([{ kind: "url", value: "https://cdn/x.mp3" }]);
  });

  it("strips a data URL prefix when asked for base64", async () => {
    const dataUrlSpec = spec({
      specVersion: 2,
      capability: "audio.tts",
      transport: { method: "POST", path: "/v1/t2a_v2" },
      auth: { type: "bearer" },
      response: { items: [{ kind: "base64", encoding: "dataUrl", value: "$.data.audio" }] },
    });
    const out = await executeMedia({
      spec: dataUrlSpec,
      provider,
      input: { model: "m", input: "hi" },
      fetchImpl: (async () =>
        json({ data: { audio: "data:audio/mpeg;base64,QUJDRA==" } })) as unknown as typeof fetch,
    });
    expect(out.ok && out.result.items).toEqual([{ kind: "base64", value: "QUJDRA==" }]);
  });

  it("accepts a single object where an array was expected", async () => {
    const singleSpec = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      response: { items: { kind: "url", value: "$.data.url" } },
    });
    const out = await executeMedia({
      spec: singleSpec,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () => json({ data: { url: "https://cdn/a.png" } })) as unknown as typeof fetch,
    });
    expect(out.ok && out.result.items).toEqual([{ kind: "url", value: "https://cdn/a.png" }]);
  });
});

// ---------------------------------------------------------------------------

describe("gap 4 — error vocabularies", () => {
  it("matches a rule on the upstream HTTP status", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v2/video_generation" },
      auth: { type: "bearer" },
      response: { items: [] },
      errors: [{ httpStatus: 402, status: 402, code: "upstream_credit_exhausted" }],
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () =>
        json({ error: { type: "insufficient_balance_error" } }, 402)) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatchObject({ status: 402, code: "upstream_credit_exhausted" });
  });

  it("still matches an in-body vendor code on a 200, and surfaces the vendor's own message", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      response: { items: [], errorMessage: "$.base_resp.status_msg" },
      errors: [{ when: { $eq: ["$.base_resp.status_code", 1026] }, status: 400, code: "content_filter" }],
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () =>
        json({ data: {}, base_resp: { status_code: 1026, status_msg: "sensitive" } })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("content_filter");
    expect(out.error.message).toBe("sensitive");
  });

  it("rejects a rule that can never fire", () => {
    const parsed = parseMediaSpec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
      response: { items: [] },
      errors: [{ status: 400, code: "bad_request" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("can never fire");
  });
});

// ---------------------------------------------------------------------------

describe("gap 5 — async status vocabularies", () => {
  const base = {
    specVersion: 2,
    capability: "video.generate",
    transport: { method: "POST", path: "/v1/video_generation" },
    auth: { type: "bearer" },
    response: { taskId: "$.task_id", status: "$.status", items: { $from: "$.urls", $to: { kind: "url", value: "$" } } },
    async: { submitTaskId: "$.task_id" },
  };

  it("matches case-insensitively by default", async () => {
    const s = spec({
      ...base,
      async: {
        ...base.async,
        poll: {
          method: "GET",
          path: "/q?task_id={{taskId}}",
          intervalMs: 1,
          timeoutMs: 2000,
          successValues: ["Success"],
          failureValues: ["Fail"],
        },
      },
    });
    // The vendor's own docs say both `Success` and `success`; either must work.
    for (const status of ["Success", "success", "SUCCESS"]) {
      const out = await executeMedia({
        spec: s,
        provider,
        input: { model: "m", prompt: "p" },
        fetchImpl: poller({ task_id: "t1" }, { status, urls: ["https://cdn/v.mp4"] }),
      });
      expect(out.ok, `status ${status}`).toBe(true);
    }
  });

  it("honours an exact matcher when the spec asks for one", async () => {
    const s = spec({
      ...base,
      async: {
        ...base.async,
        poll: {
          method: "GET",
          path: "/q?task_id={{taskId}}",
          intervalMs: 1,
          timeoutMs: 120,
          statusMatch: "exact",
          successValues: ["Success"],
          failureValues: ["Fail"],
        },
      },
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: poller({ task_id: "t1" }, { status: "success", urls: ["https://cdn/v.mp4"] }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("task_timeout");
  });

  it("names the observed status when it times out", async () => {
    const s = spec({
      ...base,
      async: {
        ...base.async,
        poll: {
          method: "GET",
          path: "/q?task_id={{taskId}}",
          intervalMs: 1,
          timeoutMs: 60,
          statusMatch: "exact",
          successValues: ["Success"],
          failureValues: ["Fail"],
        },
      },
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: poller({ task_id: "t1" }, { status: "Rendering" }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain('last status "Rendering"');
  });

  it("requires a catch-all in statusMap so a new state cannot hang the poll", () => {
    const parsed = parseMediaSpec({
      ...base,
      async: {
        ...base.async,
        poll: { method: "GET", path: "/q?task_id={{taskId}}", statusMap: { Success: "ok" } },
      },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("catch-all");
  });

  it("rejects a poll with no way to terminate", () => {
    const parsed = parseMediaSpec({
      ...base,
      async: { ...base.async, poll: { method: "GET", path: "/q?task_id={{taskId}}" } },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("no status can ever terminate");
  });

  it("maps a whole vendor vocabulary at once", async () => {
    const s = spec({
      ...base,
      async: {
        ...base.async,
        poll: {
          method: "GET",
          path: "/q?task_id={{taskId}}",
          intervalMs: 1,
          timeoutMs: 2000,
          statusMap: { Success: "ok", Fail: "fail", Preparing: "wait", "": "wait" },
        },
      },
    });
    // Preparing must be treated as "still running", not as a terminal state.
    let calls = 0;
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.includes("/v1/video_generation")) return json({ task_id: "t1" });
        calls += 1;
        return calls < 3
          ? json({ status: "Preparing" })
          : json({ status: "Success", urls: ["https://cdn/v.mp4"] });
      }) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("surfaces a terminal failure as upstream_task_failed", async () => {
    const s = spec({
      ...base,
      async: {
        ...base.async,
        poll: {
          method: "GET",
          path: "/q?task_id={{taskId}}",
          intervalMs: 1,
          timeoutMs: 2000,
          statusMap: { Success: "ok", Fail: "fail", "": "wait" },
        },
      },
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: poller({ task_id: "t1" }, { status: "Fail" }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("upstream_task_failed");
  });
});

/** fetch stub: submit once, then always return the same poll body. */
function poller(submitBody: unknown, pollBody: unknown): typeof fetch {
  return (async (u: string | URL | Request) => {
    const url = String(u);
    if (url.includes("/v1/video_generation")) return json(submitBody);
    return json(pollBody);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------

describe("silent emptiness", () => {
  it("refuses a mapped 2xx that produced nothing", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      // A typo'd path: the upstream answered fine, the mapping found nothing.
      response: { items: { $from: "$.data.images", $to: { kind: "url", value: "$" } } },
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () => json({ data: { image_urls: ["https://cdn/a.png"] } })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("upstream_contract_mismatch");
    expect(out.error.message).toContain("response.items");
  });

  it("accepts an empty result when the spec opts in", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      response: { items: { $from: "$.data.images", $to: { kind: "url", value: "$" } } },
      allowEmpty: true,
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () => json({ data: {} })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
  });

  it("does not apply to transcription, which has no items", async () => {
    const s = spec({
      specVersion: 2,
      capability: "audio.stt",
      transport: { method: "POST", path: "/v1/speech_to_text" },
      auth: { type: "bearer" },
      response: { text: "$.text" },
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "asr-1.0" },
      fetchImpl: (async () => json({ text: "" })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("transport breadth", () => {
  it("maps header values from the request scope", async () => {
    const s = spec({
      specVersion: 2,
      capability: "audio.stt",
      transport: {
        method: "POST",
        path: "/v1/speech_to_text",
        headers: { language: "$.language" },
      },
      auth: { type: "bearer" },
      request: { model: "$.model" },
      response: { text: "$.text" },
    });
    let seen: Headers | undefined;
    await executeMedia({
      spec: s,
      provider,
      input: { model: "asr-1.0", language: "en" },
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        seen = init.headers as Headers;
        return json({ text: "hi" });
      }) as unknown as typeof fetch,
    });
    expect(seen?.get("language")).toBe("en");
  });

  it("omits a header whose mapping resolves to nothing", async () => {
    const s = spec({
      specVersion: 2,
      capability: "audio.stt",
      transport: { method: "POST", path: "/v1/speech_to_text", headers: { language: "$.language" } },
      auth: { type: "bearer" },
      request: { model: "$.model" },
      response: { text: "$.text" },
    });
    let seen: Headers | undefined;
    await executeMedia({
      spec: s,
      provider,
      input: { model: "asr-1.0" },
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        seen = init.headers as Headers;
        return json({ text: "hi" });
      }) as unknown as typeof fetch,
    });
    expect(seen?.has("language")).toBe(false);
  });

  it("substitutes {{model}} in a path-style endpoint", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v2/models/{{model}}/images" },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.url" }] },
    });
    let seen = "";
    await executeMedia({
      spec: s,
      provider,
      input: { model: "flux pro", prompt: "p" },
      fetchImpl: (async (u: string | URL | Request) => {
        seen = String(u);
        return json({ url: "https://cdn/a.png" });
      }) as unknown as typeof fetch,
    });
    expect(seen).toBe("https://api.minimax.cn/v2/models/flux%20pro/images");
  });

  it("lets a spec override the provider base URL", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      baseUrl: "https://api.minimax.io",
      transport: { method: "POST", path: "/v2/video_generation" },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.url" }] },
    });
    let seen = "";
    await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async (u: string | URL | Request) => {
        seen = String(u);
        return json({ url: "https://cdn/a.png" });
      }) as unknown as typeof fetch,
    });
    expect(seen.startsWith("https://api.minimax.io/")).toBe(true);
  });

  it("encodes a form-urlencoded body", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      transport: {
        method: "POST",
        path: "/v1/images",
        contentType: "application/x-www-form-urlencoded",
      },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt", n: { $toString: "$.n" } },
      response: { items: [{ kind: "url", value: "$.url" }] },
    });
    let body = "";
    let contentType = "";
    await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "a cat", n: 2 },
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        body = String(init.body);
        contentType = (init.headers as Headers).get("content-type") ?? "";
        return json({ url: "https://cdn/a.png" });
      }) as unknown as typeof fetch,
    });
    expect(contentType).toContain("application/x-www-form-urlencoded");
    // `+` is the correct form encoding for a space, not %20.
    expect(body).toBe("prompt=a+cat&n=2");
  });

  it("collects url items from an SSE stream", async () => {
    const s = spec({
      specVersion: 2,
      capability: "image.generate",
      responseMode: "sse",
      transport: { method: "POST", path: "/v1/images" },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.url" }] },
    });
    const body = [
      'data: {"url":"https://cdn/1.png"}',
      "",
      'data: {"url":"https://cdn/1.png"}',
      "",
      'data: {"url":"https://cdn/2.png"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.items).toEqual([
      { kind: "url", value: "https://cdn/1.png" },
      { kind: "url", value: "https://cdn/2.png" },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("new primitives", () => {
  it("$firstPresent takes the first path that resolves", () => {
    expect(applyMapping({ $firstPresent: ["$.a.b", "$.a.c", "$.d"] }, { a: { c: 7 } })).toBe(7);
    expect(applyMapping({ $firstPresent: ["$.a", "$.b"] }, {})).toBeUndefined();
  });

  it("$toString coerces a number for vendors that want a string", () => {
    expect(applyMapping({ $toString: "$.n" }, { n: 4 })).toBe("4");
    expect(applyMapping({ $toString: "$.missing" }, {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("validation surface", () => {
  it("rejects a version it does not speak, and says why", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
      capability: "image.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("version 2");
  });

  it("rejects an unknown top-level field", () => {
    const parsed = parseMediaSpec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
      reponse: {},
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("reponse: unknown spec field");
  });

  it("rejects a timeout beyond the serverless ceiling", () => {
    const parsed = parseMediaSpec({
      specVersion: 2,
      capability: "music.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
      response: { items: [] },
      limits: { timeoutMs: 600_000 },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("serverless ceiling");
  });

  it("warns when an item-producing capability maps no items", () => {
    const parsed = parseMediaSpec({
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
      response: { status: "$.status" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.join(" ")).toContain("neither `items` nor `text`");
  });

  it("rejects a media capability with no items and no allowEmpty", () => {
    const result = validateMediaSpecs([
      {
        specVersion: 2,
        capability: "image.generate",
        transport: { method: "POST", path: "/x" },
        auth: { type: "bearer" },
        response: { status: "$.status" },
      },
    ]);
    expect(result.errors.join(" ")).toContain("must map `items`");
  });
});
