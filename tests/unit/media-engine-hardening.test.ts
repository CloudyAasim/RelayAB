/**
 * tests/unit/media-engine-hardening.test.ts
 *
 * Regression cover for four engine-level defects that only surface under
 * conditions a single happy-path call never creates. Each one is a real
 * behaviour bug, not a spec-authoring mistake — the point of the exercise data
 * was to find these, and these are what it found.
 */
import { describe, it, expect } from "vitest";
import { parseMediaSpec, type MediaProvider, type MediaSpec } from "@/lib/media/spec";
import { executeMedia } from "@/lib/media/engine";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "p",
  name: "probe",
  baseUrl: "https://api.example.test",
  encryptedApiKey: encryptSecret("k"),
  enabled: true,
  priority: 1,
  models: {},
  specs: [],
  createdAt: "",
  updatedAt: "",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spec = (raw: unknown): MediaSpec => {
  const parsed = parseMediaSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
};

// ---------------------------------------------------------------------------

describe("$fetch budget is per call, not per mapping", () => {
  /**
   * `resolveFetches` used to default to a fresh `{left: 8}` on every invocation.
   * Because the poll loop invokes it once per round, an operator's single request
   * could turn into 8 × rounds upstream GETs — an amplification bug that looks
   * fine in every single-shot test.
   */
  const ASYNC_FETCH = {
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
        path: "/v1/query?task_id={{taskId}}",
        intervalMs: 1,
        timeoutMs: 3000,
        statusPath: "$.status",
        statusMap: { Processing: "wait", Success: "ok", "": "wait" },
      },
    },
  };

  it("caps the total follow-up GETs across the whole poll loop", async () => {
    const calls: string[] = [];
    let polls = 0;
    const out = await executeMedia({
      spec: spec(ASYNC_FETCH),
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        if (target.endsWith("/v1/video_generation")) return json({ task_id: "t1" });
        if (target.includes("/v1/query")) {
          polls += 1;
          // Many rounds that each expose a `file_id`, so every round would like
          // its own allowance; the last one settles the task.
          return polls < 12
            ? json({ status: "Processing", file_id: `f${polls}` })
            : json({ status: "Success", file_id: `f${polls}` });
        }
        return json({ file: { download_url: "https://cdn/out.mp4" } });
      }) as unknown as typeof fetch,
    });

    const retrieves = calls.filter((u) => u.includes("/v1/files/retrieve"));
    expect(polls).toBeGreaterThanOrEqual(12);
    expect(out.ok, out.ok ? "" : `${out.error.code}: ${out.error.message}`).toBe(true);
    // Only the terminal round needs the artefact. Fetching during `Processing`
    // wasted a request per round and drained the budget before the round that
    // mattered, turning a long task into `upstream_contract_mismatch`.
    expect(retrieves).toEqual([expect.stringContaining("file_id=f12")]);
  });

  it("does not fire a follow-up request when the source path is absent", async () => {
    // The marker used to be emitted unconditionally, so a response with no
    // `file_id` still produced GET /files/retrieve?file_id= — an empty lookup
    // that burns the budget and can never succeed.
    let retrieves = 0;
    const out = await executeMedia({
      spec: spec(ASYNC_FETCH),
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes("/v1/files/retrieve")) {
          retrieves += 1;
          return json({ file: { download_url: "https://cdn/out.mp4" } });
        }
        if (target.endsWith("/v1/video_generation")) return json({ task_id: "t1" });
        // Terminal, but with nothing to exchange yet.
        return json({ status: "Success" });
      }) as unknown as typeof fetch,
    });
    expect(retrieves).toBe(0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("upstream_contract_mismatch");
  });

  it("caps the total follow-up GETs across an SSE stream", async () => {
    const sseSpec = spec({
      specVersion: 1,
      capability: "image.generate",
      responseMode: "sse",
      transport: { method: "POST", path: "/v1/images" },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt" },
      response: {
        items: [
          {
            kind: "url",
            value: { $fetch: { path: "$.id", url: "/v1/files/retrieve?id={{ $.id }}", pick: "$.url" } },
          },
        ],
      },
    });

    const body = Array.from({ length: 20 }, (_, i) => `data: {"id":"id-${i}"}`).join("\n\n") + "\n\n";
    let retrieves = 0;
    const out = await executeMedia({
      spec: sseSpec,
      provider,
      input: { prompt: "p" },
      fetchImpl: (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes("/v1/files/retrieve")) {
          retrieves += 1;
          return json({ url: `https://cdn/${retrieves}.png` });
        }
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    });
    expect(out.ok, out.ok ? "" : `${out.error.code}`).toBe(true);
    // 20 events would each like their own allowance; the cap is per call.
    expect(retrieves).toBeLessThanOrEqual(8);
    expect(retrieves).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------------------

describe("an opted-in empty result is not billed", () => {
  /**
   * `allowEmpty` exists so a spec can accept "2xx but nothing produced" (a
   * content-filtered image, a vendor placeholder). `countOf` then fell back to
   * 1, which meant the relay charged full price for producing nothing — the
   * exact outcome `allowEmpty` was introduced to describe honestly.
   */
  const EMPTY_OK = {
    specVersion: 1,
    capability: "image.generate",
    transport: { method: "POST", path: "/v1/image_generation" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: { items: { $from: "$.data.image_urls", $to: { kind: "url", value: "$" } } },
    allowEmpty: true,
  };

  it("reports successCount 0 when the mapping produced nothing", async () => {
    const out = await executeMedia({
      spec: spec(EMPTY_OK),
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () => json({ data: {} })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.items).toEqual([]);
    expect(out.result.successCount).toBe(0);
  });

  it("still counts real items normally", async () => {
    const out = await executeMedia({
      spec: spec(EMPTY_OK),
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async () =>
        json({ data: { image_urls: ["https://cdn/1.png", "https://cdn/2.png"] } })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.successCount).toBe(2);
  });

  it("still counts a transcription, which has no items by design", async () => {
    const out = await executeMedia({
      spec: spec({
        specVersion: 1,
        capability: "audio.stt",
        transport: { method: "POST", path: "/v1/speech_to_text" },
        auth: { type: "bearer" },
        request: { model: "$.model" },
        response: { text: "$.text" },
      }),
      provider,
      input: { model: "asr" },
      fetchImpl: (async () => json({ text: "hello" })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.successCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("an error inside an SSE stream aborts the call", () => {
  /**
   * The merge loop returned the partial payload when a rule fired, so the
   * vendor's complaint turned into `upstream_contract_mismatch` — a different
   * error, with the real reason discarded.
   */
  const SSE_WITH_ERROR = {
    specVersion: 1,
    capability: "image.generate",
    responseMode: "sse",
    transport: { method: "POST", path: "/v1/images" },
    auth: { type: "bearer" },
    request: { prompt: "$.prompt" },
    response: {
      items: [{ kind: "url", value: "$.url" }],
      errorCode: "$.error.code",
      errorMessage: "$.error.message",
    },
    errors: [{ when: { $eq: ["$.error.code", "1026"] }, status: 400, code: "content_filter" }],
  };

  it("surfaces the vendor error instead of a contract mismatch", async () => {
    const body = [
      'data: {"url":"https://cdn/1.png"}',
      "",
      'data: {"error":{"code":"1026","message":"sensitive prompt"}}',
      "",
    ].join("\n");
    const out = await executeMedia({
      spec: spec(SSE_WITH_ERROR),
      provider,
      input: { prompt: "p" },
      fetchImpl: (async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("content_filter");
    expect(out.error.status).toBe(400);
    expect(out.error.message).toBe("sensitive prompt");
  });
});

// ---------------------------------------------------------------------------

describe("async.poll.intervalMs must be positive", () => {
  /**
   * `0` (or a negative) turns the poll loop into a busy loop that hammers the
   * vendor for the entire timeout. It saves fine, so it has to be caught at
   * validation time.
   */
  const base = {
    specVersion: 1,
    capability: "video.generate",
    transport: { method: "POST", path: "/v1/video_generation" },
    auth: { type: "bearer" },
    request: { model: "$.model" },
    response: {
      taskId: "$.task_id",
      status: "$.status",
      items: [{ kind: "url", value: "$.url" }],
    },
    async: {
      submitTaskId: "$.task_id",
      poll: { method: "GET", path: "/q?task_id={{taskId}}", statusMap: { Success: "ok", "": "wait" } },
    },
  };

  it.each([[0], [-1], [Number.NaN], ["5"]])("rejects intervalMs=%s", (intervalMs) => {
    const parsed = parseMediaSpec({
      ...base,
      async: { ...base.async, poll: { ...base.async.poll, intervalMs } },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("async.poll.intervalMs");
  });

  it("accepts a sane interval", () => {
    const parsed = parseMediaSpec({
      ...base,
      async: { ...base.async, poll: { ...base.async.poll, intervalMs: 3000 } },
    });
    expect(parsed.ok).toBe(true);
  });
});
