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
    specVersion: 1,
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
    specVersion: 1,
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
      specVersion: 1,
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
        specVersion: 1,
        capability: "video.generate",
        transport: { method: "POST", path: "/v1/video_generation" },
        auth: { type: "bearer" },
        response: { items: [] },
      },
      {
        specVersion: 1,
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
        specVersion: 1,
        capability: "video.generate",
        models: ["h3"],
        transport: { method: "POST", path: "/a" },
        auth: { type: "bearer" },
        response: { items: [] },
      },
      {
        specVersion: 1,
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
      specVersion: 1,
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
    specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
    specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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

  it("$firstPresent only reaches for scalars, never for object branches", () => {
    // Documented sharp edge: `{kind, value}` evaluates to `{kind}` (still an
    // object) when the path is absent, so an object branch always "wins" and the
    // later candidates are never tried. Use the $ifPresent array form instead.
    const wrong = applyMapping(
      { $firstPresent: [{ kind: "url", value: "$.url" }, { kind: "base64", value: "$.b64" }] },
      { b64: "QQ==" },
    );
    expect(wrong).toEqual({ kind: "url" });
  });

  it("$toString coerces a number for vendors that want a string", () => {
    expect(applyMapping({ $toString: "$.n" }, { n: 4 })).toBe("4");
    expect(applyMapping({ $toString: "$.missing" }, {})).toBeUndefined();
  });

  it("$ifPresent picks the first branch whose key exists", () => {
    const mapping = {
      $ifPresent: [
        { "$.url": { kind: "url", value: "$.url" } },
        { "$.b64_json": { kind: "base64", value: "$.b64_json" } },
      ],
    };
    expect(applyMapping(mapping, { url: "https://cdn/a.png" })).toEqual({
      kind: "url",
      value: "https://cdn/a.png",
    });
    expect(applyMapping(mapping, { b64_json: "QUJDRA==" })).toEqual({
      kind: "base64",
      value: "QUJDRA==",
    });
    // Neither shape present → the item is dropped rather than half-built.
    expect(applyMapping(mapping, { revised_prompt: "x" })).toBeUndefined();
  });

  it("handles a mixed array where some items are urls and some are base64", async () => {
    // OpenAI's real shape: every entry in `data` is either {url} or {b64_json}.
    const s = spec({
      specVersion: 1,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/images/generations" },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt" },
      response: {
        items: {
          $from: "$.data",
          $to: {
            $ifPresent: [
              { "$.url": { kind: "url", value: "$.url" } },
              { "$.b64_json": { kind: "base64", value: "$.b64_json" } },
            ],
          },
        },
      },
    });
    const out = await executeMedia({
      spec: s,
      provider,
      input: { model: "gpt-image-1", prompt: "cat" },
      fetchImpl: (async () =>
        json({
          data: [
            { url: "https://cdn/1.png" },
            { b64_json: "QUJDRA==" },
            { url: "https://cdn/2.png" },
            { revised_prompt: "ignored" },
          ],
        })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.items).toEqual([
      { kind: "url", value: "https://cdn/1.png" },
      { kind: "base64", value: "QUJDRA==" },
      { kind: "url", value: "https://cdn/2.png" },
    ]);
  });

  it("rejects an $ifPresent branch that is not a single-key object", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
      capability: "image.generate",
      transport: { method: "POST", path: "/x" },
      auth: { type: "bearer" },
      request: { a: { $ifPresent: [{ "$.url": "x", "$.b64": "y" }] } },
      response: { items: [] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("exactly one path key");
  });
});

// ---------------------------------------------------------------------------

describe("validation surface", () => {
  it("refuses two unscoped specs of *different* capabilities", () => {
    // Scoping is per provider, not per capability. With two unscoped specs the
    // model catalog cannot choose: `specServingModel` falls back to the first
    // unscoped spec, so `asr-1.0` gets advertised as `audio.tts` — with the wrong
    // modes and no async flag. Calls still work (resolution is capability-first),
    // so nothing errors and the catalog is simply wrong. Observed while
    // configuring MiniMax: four capabilities, four specs, none of them scoped.
    const image = {
      specVersion: 1 as const,
      capability: "image.generate" as const,
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" as const },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { items: [{ kind: "url" as const, value: "$.url" }] },
    };
    const tts = { ...image, capability: "audio.tts" as const };

    // One unscoped spec per provider is fine — it is the documented wildcard.
    expect(validateMediaSpecs([image]).errors).toHaveLength(0);
    // Scoping both is fine.
    expect(
      validateMediaSpecs([
        { ...image, models: ["image-01"] },
        { ...tts, models: ["speech-2.8-hd"] },
      ]).errors,
    ).toHaveLength(0);
    // Two unscoped specs are not, whatever their capabilities.
    expect(validateMediaSpecs([image, tts]).errors.join(" ")).toContain("do not list `models`");
  });

  it("refuses `$file` outside multipart, counting an unset contentType as JSON", () => {
    // `$file` resolves to a File. Only a multipart form field has anywhere to put
    // one; anywhere else the mapping serializes the File *object* into the body and
    // the upstream receives a stringified blob. The engine defaults an absent
    // contentType to application/json, so "unset" has to be judged too.
    const withFile = {
      specVersion: 1 as const,
      capability: "audio.stt" as const,
      transport: { method: "POST", path: "/v1/stt" },
      auth: { type: "bearer" as const },
      request: { model: "$.model", file: { $file: { path: "$.image" } } },
      response: { text: "$.text" },
    };
    const withCt = (contentType: string) => ({
      ...withFile,
      transport: { ...withFile.transport, contentType },
    });

    expect(parseMediaSpec(withFile).ok).toBe(false);
    expect(parseMediaSpec(withCt("application/json")).ok).toBe(false);
    expect(parseMediaSpec(withCt("application/x-www-form-urlencoded")).ok).toBe(false);
    // The two shapes that can actually carry it.
    expect(parseMediaSpec(withCt("multipart/form-data")).ok).toBe(true);
    expect(
      parseMediaSpec({
        ...withFile,
        request: { $file: { path: "$.image" } },
        transport: { ...withFile.transport, contentType: "audio/mpeg" },
      }).ok,
    ).toBe(true);
  });

  it("rejects wildcard paths — they resolve to undefined, not to a match", () => {
    // The quietest failure in the protocol: `getPath` understands numeric indices
    // only, so `$.data[*].url` parses fine and yields `undefined`. The symptom
    // arrives much later as `upstream_contract_mismatch` and reads like a vendor
    // schema change. Worth catching at save time.
    const withText = (path: string) => ({
      specVersion: 1 as const,
      capability: "audio.stt" as const,
      transport: { method: "POST", path: "/v1/stt" },
      auth: { type: "bearer" as const },
      request: { model: "$.model" },
      response: { text: path },
    });

    expect(parseMediaSpec(withText("$.text")).ok).toBe(true);
    // Fixed indices, however deep, are fine.
    expect(parseMediaSpec(withText("$.utter[0].words[1].word")).ok).toBe(true);

    for (const path of ["$.data[*].url", "$.utter[*].words[*].word"]) {
      const parsed = parseMediaSpec(withText(path));
      expect(parsed.ok, path).toBe(false);
      if (parsed.ok) continue;
      // The suggested fix must itself be a valid path.
      const suggestion = /如 (\$\.[^）]+)/.exec(parsed.errors.join(" "))?.[1];
      expect(suggestion, path).toBeDefined();
      expect(suggestion, path).not.toContain("[*]");
      expect(parseMediaSpec(withText(suggestion!)).ok, suggestion).toBe(true);
    }
  });

  it("accepts exactly version 1 and rejects anything else", () => {
    // There is no version history: 1 is the first and only version, so the only
    // message is a plain "must be 1".
    for (const specVersion of [2, "1", 0]) {
      const parsed = parseMediaSpec({
        specVersion,
        capability: "image.generate",
        transport: { method: "POST", path: "/x" },
        auth: { type: "bearer" },
      });
      expect(parsed.ok, String(specVersion)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.join(" ")).toContain("specVersion: must be 1");
    }
  });

  it("rejects an unknown top-level field", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
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
      specVersion: 1,
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
      specVersion: 1,
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
        specVersion: 1,
        capability: "image.generate",
        transport: { method: "POST", path: "/x" },
        auth: { type: "bearer" },
        response: { status: "$.status" },
      },
    ]);
    expect(result.errors.join(" ")).toContain("must map `items`");
  });
});

describe("byModel — one spec, per-model enum/size tables", () => {
  // MiniMax ships two tiers behind one endpoint: `MiniMax-H3` accepts `2K`,
  // `MiniMax-H3-Max` explicitly does not. Splitting into two specs would mean two
  // copies to keep in step, and the judge cannot compare them.
  const V2_VIDEO: Record<string, unknown> = {
    specVersion: 1,
    capability: "video.generate",
    models: ["minimax-h3", "minimax-h3-max"],
    transport: { method: "POST", path: "/v2/video_generation" },
    auth: { type: "bearer" },
    request: {
      model: "$.model",
      content: [{ type: "text", text: "$.prompt" }],
      resolution: {
        $mapSize: {
          path: "$.size",
          table: { "1280x720": "768P", "1920x1080": "2K" },
          default: "768P",
          byModel: { "MiniMax-H3-Max": { "1920x1080": "768P" } },
        },
      },
    },
    response: { taskId: "$.task_id", status: "$.task.status", items: [{ kind: "url", value: "$.task.content.url" }] },
    async: { submitTaskId: "$.task_id", poll: { method: "GET", path: "/v2/query/video_generation/{{taskId}}", statusMap: { succeeded: "ok", "": "wait" } } },
  };

  it("lets one spec serve model tiers with different capabilities", () => {
    const parsed = parseMediaSpec(V2_VIDEO);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const send = (model: string, size: string) =>
      (applyMapping(parsed.spec.request, { model, prompt: "p", size }) as Record<string, unknown>).resolution;

    expect(send("MiniMax-H3", "1920x1080")).toBe("2K");
    expect(send("MiniMax-H3-Max", "1920x1080")).toBe("768P");
    // Keys the model does not override still come from the shared table.
    expect(send("MiniMax-H3", "1280x720")).toBe("768P");
    expect(send("MiniMax-H3-Max", "1280x720")).toBe("768P");
  });

  it("works on $enum too", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/images" },
      auth: { type: "bearer" },
      request: {
        model: "$.model",
        response_format: {
          $enum: {
            path: "$.responseFormat",
            map: { b64_json: "base64", url: "url" },
            default: "url",
            byModel: { "image-01-live": { b64_json: "url" } },
          },
        },
      },
      response: { items: [{ kind: "url", value: "$.url" }] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const send = (model: string) =>
      (applyMapping(parsed.spec.request, { model, responseFormat: "b64_json" }) as Record<string, unknown>)
        .response_format;
    expect(send("image-01")).toBe("base64");
    expect(send("image-01-live")).toBe("url");
  });

  it("is inert when no model matches", () => {
    const parsed = parseMediaSpec(V2_VIDEO);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const body = applyMapping(parsed.spec.request, {
      model: "Some-Other-Model",
      prompt: "p",
      size: "1920x1080",
    }) as Record<string, unknown>;
    expect(body.resolution).toBe("2K");
  });

  it("rejects an override key the shared table does not have", () => {
    const parsed = parseMediaSpec({
      ...V2_VIDEO,
      request: {
        model: "$.model",
        resolution: {
          $mapSize: {
            path: "$.size",
            table: { "1280x720": "768P" },
            default: "768P",
            byModel: { "MiniMax-H3-Max": { "3840x2160": "8K" } },
          },
        },
      },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("override keys must exist there");
  });

  it("rejects a malformed byModel", () => {
    for (const byModel of ["nope", { "MiniMax-H3-Max": "nope" }, { "": { a: 1 } }]) {
      const parsed = parseMediaSpec({
        ...V2_VIDEO,
        request: {
          model: "$.model",
          resolution: { $mapSize: { path: "$.size", table: { a: "b" }, byModel } },
        },
      });
      expect(parsed.ok, JSON.stringify(byModel)).toBe(false);
    }
  });
});

describe("errorCode / errorMessage are full mappings", () => {
  // A vendor can put errors in two places: an OpenAI-shaped envelope for 4xx/5xx,
  // and a task-shaped object when a poll comes back `failed`. There is room for
  // both, but only if the operator knows these two slots take a mapping.
  const spec = {
    specVersion: 1,
    capability: "video.generate",
    transport: { method: "POST", path: "/v2/video_generation" },
    auth: { type: "bearer" },
    request: { model: "$.model" },
    response: {
      taskId: "$.task_id",
      status: "$.task.status",
      items: [{ kind: "url", value: "$.task.content.url" }],
      successCount: { $const: 1 },
      errorCode: { $firstPresent: ["$.error.type", "$.task.error.code"] },
      errorMessage: { $firstPresent: ["$.error.message", "$.task.error.message"] },
    },
    errors: [{ httpStatus: 402, status: 402, code: "upstream_credit_exhausted" }],
    async: {
      submitTaskId: "$.task_id",
      poll: {
        method: "GET",
        path: "/v2/query/video_generation/{{taskId}}",
        intervalMs: 1,
        timeoutMs: 2000,
        statusPath: "$.task.status",
        statusMap: { succeeded: "ok", failed: "fail", "": "wait" },
      },
    },
  };

  it("surfaces the submit-phase message", async () => {
    const parsed = parseMediaSpec(spec);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = await executeMedia({
      spec: parsed.spec,
      provider,
      input: { model: "MiniMax-H3", prompt: "p" },
      fetchImpl: (async () =>
        json({ error: { type: "insufficient_balance_error", message: "insufficient balance (1008)" } }, 402)) as never,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatchObject({ status: 402, code: "upstream_credit_exhausted" });
    expect(out.error.message).toBe("insufficient balance (1008)");
  });

  it("surfaces the poll-phase message too, instead of trading it away", async () => {
    const parsed = parseMediaSpec(spec);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = await executeMedia({
      spec: parsed.spec,
      provider,
      input: { model: "MiniMax-H3", prompt: "p" },
      fetchImpl: (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.endsWith("/v2/video_generation")) return json({ task_id: "t1" });
        return json({ task: { status: "failed", error: { code: "1026", message: "contains sensitive content" } } });
      }) as never,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("upstream_task_failed");
    expect(out.error.message).toBe("contains sensitive content");
  });
});

describe("error rule precedence: vendor code before HTTP status", () => {
  /**
   * The two routinely overlap. Zhipu answers HTTP 429 for both rate limiting and
   * an exhausted account, and HTTP 400 for both bad parameters and a content
   * block. If the generic `httpStatus` rule were checked first, the specific
   * `when` rule could never fire — an operator's only workaround used to be to
   * *omit* the generic rule, which then lost the fallback for unlisted codes.
   */
  const ZHIPU_SHAPED = {
    specVersion: 1,
    capability: "image.generate",
    transport: { method: "POST", path: "/paas/v4/images/generations" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: {
      items: [{ kind: "url", value: "$.data[0].url" }],
      errorCode: "$.error.code",
      errorMessage: "$.error.message",
    },
    errors: [
      { httpStatus: 400, status: 400, code: "bad_request" },
      { httpStatus: 429, status: 429, code: "rate_limited" },
      { when: { $eq: ["$.error.code", "1301"] }, status: 400, code: "content_filter" },
      { when: { $eq: ["$.error.code", "1113"] }, status: 402, code: "upstream_credit_exhausted" },
    ],
  };

  const call = async (httpStatus: number, body: unknown) => {
    const parsed = parseMediaSpec(ZHIPU_SHAPED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unparseable");
    const out = await executeMedia({
      spec: parsed.spec,
      provider,
      input: { model: "glm-image", prompt: "p" },
      fetchImpl: (async () => json(body, httpStatus)) as never,
    });
    return out.ok ? null : { status: out.error.status, code: out.error.code };
  };

  it("lets a specific business code beat a generic HTTP status", async () => {
    // 429 normally means rate limiting …
    expect(await call(429, { error: { code: "1302" } })).toEqual({ status: 429, code: "rate_limited" });
    // … but not when the body says the account is empty.
    expect(await call(429, { error: { code: "1113" } })).toEqual({
      status: 402,
      code: "upstream_credit_exhausted",
    });
    expect(await call(400, { error: { code: "1301" } })).toEqual({ status: 400, code: "content_filter" });
  });

  it("keeps the generic rule as the fallback for unlisted codes", async () => {
    // This is what the "just omit httpStatus" workaround gave up.
    expect(await call(429, { error: { code: "1321" } })).toEqual({ status: 429, code: "rate_limited" });
    expect(await call(400, { error: { code: "1214" } })).toEqual({ status: 400, code: "bad_request" });
  });

  it("still reports an unmapped 5xx", async () => {
    expect(await call(500, { error: { code: "1230" } })).toEqual({ status: 502, code: "upstream_error" });
  });

  it("uses the same precedence while polling", async () => {
    const parsed = parseMediaSpec({
      ...ZHIPU_SHAPED,
      capability: "video.generate",
      response: { taskId: "$.id", status: "$.task_status", items: [{ kind: "url", value: "$.video_result[0].url" }] },
      errors: [
        { httpStatus: 429, status: 429, code: "rate_limited" },
        { when: { $eq: ["$.error.code", "1113"] }, status: 402, code: "upstream_credit_exhausted" },
      ],
      async: {
        submitTaskId: "$.id",
        poll: {
          method: "GET",
          path: "/api/paas/v4/async-result/{{taskId}}",
          intervalMs: 1,
          timeoutMs: 2000,
          statusPath: "$.task_status",
          statusMap: { PROCESSING: "wait", SUCCESS: "ok", FAIL: "fail", "": "wait" },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = await executeMedia({
      spec: parsed.spec,
      provider,
      input: { model: "cogvideox-3", prompt: "p" },
      fetchImpl: (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.endsWith("/videos/generations")) return json({ id: "t1", task_status: "PROCESSING" });
        return json({ error: { code: "1113", message: "余额不足" } }, 429);
      }) as never,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatchObject({ status: 402, code: "upstream_credit_exhausted" });
  });
});
