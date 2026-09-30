/**
 * tests/unit/media-engine-iterator.test.ts
 *
 * Findings from auditing the engine against real vendor documentation
 * (Deepgram, Stability AI, Replicate, Google-style APIs) rather than against
 * hand-written specs. Each one is a case the protocol could not express, or
 * expressed while silently doing the wrong thing.
 */
import { describe, it, expect } from "vitest";
import { parseMediaSpec, STRUCTURED_CONTENT_TYPES, type MediaProvider } from "@/lib/media/spec";
import { applyMapping, executeMedia } from "@/lib/media/engine";
import { imageItemsResponse, resultItems, mediaItemsResponse } from "@/lib/media/handler";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "p",
  name: "vendor",
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

const spec = (raw: unknown) => {
  const parsed = parseMediaSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
};

// ---------------------------------------------------------------------------

describe("raw binary request body (Deepgram-style)", () => {
  /**
   * `Content-Type: audio/wav` with the file bytes as the whole body. No amount of
   * JSON or multipart encoding expresses this, so the three structural content
   * types used to be the only option and such vendors were unreachable.
   */
  const DEEPGRAM = {
    specVersion: 1,
    capability: "audio.stt",
    transport: { method: "POST", path: "/v1/listen", contentType: "audio/wav" },
    auth: { type: "header", name: "Authorization", prefix: "Token " },
    request: { $file: { path: "$.image", filename: "$.filename" } },
    response: { text: "$.results.channels[0].alternatives[0].transcript" },
  };

  it("sends the bytes with the declared media type", async () => {
    let contentType = "";
    let body: unknown;
    const out = await executeMedia({
      spec: spec(DEEPGRAM),
      provider,
      input: { image: "data:audio/wav;base64,QUJDRA==", filename: "a.wav" },
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        contentType = (init.headers as Headers).get("content-type") ?? "";
        body = init.body;
        return json({ results: { channels: [{ alternatives: [{ transcript: "hi" }] }] } });
      }) as never,
    });
    expect(out.ok, out.ok ? "" : out.error.code).toBe(true);
    expect(contentType).toBe("audio/wav");
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body as Uint8Array)).toEqual([65, 66, 67, 68]);
    expect(out.ok && out.result.text).toBe("hi");
  });

  it("requires `request` to be a single $file node", () => {
    const parsed = parseMediaSpec({
      specVersion: 1,
      capability: "audio.stt",
      transport: { method: "POST", path: "/v1/listen", contentType: "audio/wav" },
      auth: { type: "bearer" },
      request: { model: "$.model" },
      response: { text: "$.text" },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("must be a single `$file` node");
  });

  it("still treats the three structural types normally", () => {
    expect(STRUCTURED_CONTENT_TYPES).toContain("multipart/form-data");
    for (const contentType of ["application/json", "application/x-www-form-urlencoded"]) {
      const parsed = parseMediaSpec({
        specVersion: 1,
        capability: "image.generate",
        transport: { method: "POST", path: "/v1/x", contentType },
        auth: { type: "bearer" },
        request: { prompt: "$.prompt" },
        response: { items: [{ kind: "url", value: "$.url" }] },
      });
      expect(parsed.ok, contentType).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe("a binary image result reaches the client as b64_json", () => {
  /**
   * Stability answers `Accept: image/*` with image bytes. The images endpoint
   * used to drop `result.binary` and answer `{"data":[]}` while still charging
   * for one item.
   */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

  const stability = {
    specVersion: 1,
    capability: "image.generate",
    transport: {
      method: "POST",
      path: "/v2beta/stable-image/generate/core",
      contentType: "multipart/form-data",
      headers: { Accept: "image/*" },
    },
    auth: { type: "header", name: "authorization", prefix: "Bearer " },
    request: { prompt: "$.prompt", output_format: { $const: "png" } },
    responseMode: "binary",
  };

  it("converts the bytes into one b64_json item", async () => {
    const out = await executeMedia({
      spec: spec(stability),
      provider,
      input: { prompt: "lighthouse" },
      fetchImpl: (async () =>
        new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })) as never,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.items).toEqual([]);
    const items = await resultItems(out.result);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("base64");
    const body = imageItemsResponse(items);
    expect(body.data).toHaveLength(1);
    expect((body.data as { b64_json: string }[])[0].b64_json).toBe("iVBORwECAwQ=");
    // The charge and what the client received now agree.
    expect(out.result.successCount).toBe(items.length);
  });

  it("still passes raw bytes through for the endpoints whose shape is bytes", async () => {
    const out = await executeMedia({
      spec: spec({
        specVersion: 1,
        capability: "audio.tts",
        responseMode: "binary",
        transport: { method: "POST", path: "/audio/speech" },
        auth: { type: "bearer" },
        request: { model: "$.model", input: "$.input" },
      }),
      provider,
      input: { input: "hi" },
      fetchImpl: (async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } })) as never,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // /v1/audio/speech returns `result.binary` directly, so items stay empty.
    expect(out.result.items).toEqual([]);
    expect(out.result.binary?.body.byteLength).toBe(3);
  });

  it("keeps JSON image results untouched", async () => {
    const items = await resultItems({
      items: [{ kind: "url", value: "https://cdn/a.png" }],
      successCount: 1,
      durationMs: 0,
    });
    expect(items).toEqual([{ kind: "url", value: "https://cdn/a.png" }]);
    expect((mediaItemsResponse(items, "t1").data as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("POST polling with a request body", () => {
  /**
   * Some vendors' query endpoints take the task id in the body. `async.poll` had
   * no `request`, and a spec that invented the field parsed fine and was then
   * ignored — every poll sent an empty POST.
   */
  const POST_POLL = {
    specVersion: 1,
    capability: "video.generate",
    transport: { method: "POST", path: "/v1/create" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: { taskId: "$.id", status: "$.status", items: [{ kind: "url", value: "$.url" }] },
    async: {
      submitTaskId: "$.id",
      poll: {
        method: "POST",
        path: "/v1/query",
        contentType: "application/json",
        request: { task_ids: ["$.taskId"] },
        statusMap: { done: "ok", "": "wait" },
      },
    },
  };

  it("maps the task id into the poll body", async () => {
    const bodies: string[] = [];
    const out = await executeMedia({
      spec: spec(POST_POLL),
      provider,
      input: { model: "m", prompt: "p" },
      fetchImpl: (async (u: string | URL | Request, init: RequestInit) => {
        const target = String(u);
        if (target.endsWith("/v1/create")) return json({ id: "task-42" });
        bodies.push(String(init.body ?? ""));
        return json({ status: "done", url: "https://cdn/v.mp4" });
      }) as never,
    });
    expect(out.ok, out.ok ? "" : `${out.error.code}`).toBe(true);
    expect(bodies).toEqual(['{"task_ids":["task-42"]}']);
    expect(out.ok && out.result.items[0]?.value).toBe("https://cdn/v.mp4");
  });

  it("rejects an unknown key inside poll instead of ignoring it", () => {
    const parsed = parseMediaSpec({
      ...POST_POLL,
      async: { ...POST_POLL.async, poll: { ...POST_POLL.async.poll, body: { a: 1 } } },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("async.poll.body: unknown field");
  });
});

// ---------------------------------------------------------------------------

describe("decodeJson tolerates transport decorations", () => {
  const base = {
    specVersion: 1,
    capability: "image.generate",
    transport: { method: "POST", path: "/v1/images" },
    auth: { type: "bearer" },
    request: { prompt: "$.prompt" },
    response: { items: [{ kind: "url", value: "$.url" }] },
  };

  it.each([
    ["plain JSON", (body: string) => body],
    ["a UTF-8 BOM", (body: string) => `\uFEFF${body}`],
    // Google-style XSSI guard. A JSON parser rejects the whole body, which used
    // to be misreported as "2xx but the mapping produced no items".
    ["an XSSI guard", (body: string) => `)]}'\n${body}`],
    ["trailing whitespace", (body: string) => `${body}\n\n`],
  ])("parses %s", async (_label, wrap) => {
    const out = await executeMedia({
      spec: spec(base),
      provider,
      input: { prompt: "x" },
      fetchImpl: (async () =>
        new Response(wrap(JSON.stringify({ url: "https://cdn/a.png" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as never,
    });
    expect(out.ok, out.ok ? "" : out.error.code).toBe(true);
    expect(out.ok && out.result.items[0]?.value).toBe("https://cdn/a.png");
  });
});

// ---------------------------------------------------------------------------

describe("unknown keys are rejected at every level, not just the top", () => {
  const base = {
    specVersion: 1,
    capability: "image.generate",
    transport: { method: "POST", path: "/v1/x" },
    auth: { type: "bearer" },
    request: { prompt: "$.prompt" },
    response: { items: [{ kind: "url", value: "$.url" }] },
  };

  /**
   * Before this, only the top level rejected unknown fields. A misspelled
   * `transport.contenttype` silently used JSON; `limits.max_n` silently did
   * nothing. Silent acceptance is the failure mode this protocol exists to
   * eliminate, so every level now answers "which key did you mean?".
   */
  it.each([
    ["transport.contenttype", { ...base, transport: { method: "POST", path: "/v1/x", contenttype: "application/json" } }],
    ["limits.max_n", { ...base, limits: { max_n: 9 } }],
    ["auth.nam", { ...base, auth: { type: "header", nam: "X-Key" } }],
    ["response.itemz", { ...base, response: { itemz: [{ kind: "url", value: "$.url" }] } }],
    ["errors[0].httpStatuses", { ...base, errors: [{ httpStatuses: 400, status: 400, code: "x" }] }],
    ["async.submitTaskID", { ...base, async: { submitTaskID: "$.id", poll: { method: "GET", path: "/q", statusMap: { ok: "ok", "": "wait" } } } }],
  ])("rejects %s", (_label, raw) => {
    const parsed = parseMediaSpec(raw);
    expect(parsed.ok, _label).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("unknown field");
  });

  it("does not touch legitimate fields (control)", () => {
    const parsed = parseMediaSpec({
      ...base,
      transport: {
        method: "POST",
        path: "/v1/x",
        contentType: "application/json",
        headers: { A: "b" },
        query: { c: "d" },
      },
      auth: { type: "header", name: "X-Key", prefix: "Bearer " },
      limits: { maxN: 9, timeoutMs: 1000 },
      errors: [{ httpStatus: 400, status: 400, code: "x", message: "y" }],
    });
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
  });

  it("allows `response` to be a transform node", () => {
    const parsed = parseMediaSpec({
      ...base,
      response: { $merge: [{ items: [{ kind: "url", value: "$.a" }] }, { successCount: { $const: 1 } }] },
    });
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("$ifPresent treats an empty string as absent", () => {
  /**
   * Verified against a real vendor: an OpenAI-compatible image endpoint answers
   * with BOTH keys of a mutually-exclusive pair, blanking the one that does not
   * apply.
   *
   *   {"data":[{"url":"https://…","b64_json":""}]}       // url requested
   *   {"data":[{"url":"","b64_json":"iVBORw0KGgo…"}]}     // b64_json requested
   *
   * Treating `""` as present made `$ifPresent` pick the blank branch, whose value
   * the item collector then dropped — the client's image vanished into
   * `upstream_contract_mismatch` with nothing to debug.
   */
  const OPENAI_SHAPE = {
    specVersion: 1,
    capability: "image.generate",
    transport: { method: "POST", path: "/v1/images/generations" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
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
  };

  const run = async (body: unknown) => {
    const out = await executeMedia({
      spec: spec(OPENAI_SHAPE),
      provider,
      input: { model: "agnes-image-2.1-flash", prompt: "x" },
      fetchImpl: (async () => json(body)) as never,
    });
    return out.ok ? out.result.items : null;
  };

  it("takes the populated branch when url is set and b64_json is blank", async () => {
    const items = await run({
      data: [{ url: "https://cdn/real.png", b64_json: "", revised_prompt: "" }],
    });
    expect(items).toEqual([{ kind: "url", value: "https://cdn/real.png" }]);
  });

  it("takes the base64 branch when url is blank and b64_json is set", async () => {
    const items = await run({ data: [{ url: "", b64_json: "iVBORw0KGgoAAAANSUhEUg==", revised_prompt: "" }] });
    expect(items).toEqual([{ kind: "base64", value: "iVBORw0KGgoAAAANSUhEUg==" }]);
  });

  it("still treats 0 and false as present", async () => {
    // Only `""` is a placeholder; a real 0/false must not be skipped.
    const mapping = {
      zero: { $ifPresent: { "$.n": "$.n" } },
      no: { $ifPresent: { "$.off": "$.off" } },
      blank: { $ifPresent: { "$.empty": "$.empty" } },
    };
    const out = applyMapping(mapping, { n: 0, off: false, empty: "" }) as Record<string, unknown>;
    expect(out.zero).toBe(0);
    expect(out.no).toBe(false);
    expect(out.blank).toBeUndefined();
  });

  it("applies to the single-branch form too", () => {
    expect(applyMapping({ $ifPresent: { "$.voice": "$.voice" } }, { voice: "" })).toBeUndefined();
    expect(applyMapping({ $ifPresent: { "$.voice": "$.voice" } }, { voice: "tongtong" })).toBe("tongtong");
  });
});

// ---------------------------------------------------------------------------

describe("$dataUrl labels an upload with its actual type", () => {
  /**
   * Verified against a real vendor: Zhipu's CogVideoX image-to-video accepted a
   * 1024×1024 JPEG whose bytes were labelled `image/png` — but it should not have
   * to. A vendor that trusts the declared type (or forwards it to a renderer)
   * would see a lie, so the engine now reads the type off the bytes.
   */
  const MAGIC: [string, string][] = [
    ["PNG", "iVBORw0KGgoAAAANSUhEUg=="],
    ["JPEG", "/9j/4AAQSkZJRgABAQAAAQ=="],
    ["GIF", "R0lGODlhAQABAAAAACw="],
    ["WEBP", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"],
    ["WAV", "UklGRiQAAABXQVZFZm10IBAAAAA="],
    ["MP3", "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4"],
    ["FLAC", "ZkxhQwAAACAIAAAAAABggAAAABgAAAAQAAA="],
  ];

  it.each(MAGIC)("reads %s from the bytes", (label, base64) => {
    const wrapped = applyMapping({ $dataUrl: "$.image" }, { image: base64 }) as string;
    const expected: Record<string, string> = {
      PNG: "image/png",
      JPEG: "image/jpeg",
      GIF: "image/gif",
      WEBP: "image/webp",
      WAV: "audio/wav",
      MP3: "audio/mpeg",
      FLAC: "audio/flac",
    };
    expect(wrapped.startsWith(`data:${expected[label]};base64,`), wrapped.slice(0, 40)).toBe(true);
  });

  it("keeps passing through data URLs and http URLs untouched", () => {
    expect(applyMapping({ $dataUrl: "$.image" }, { image: "data:image/webp;base64,QQ==" })).toBe(
      "data:image/webp;base64,QQ==",
    );
    expect(applyMapping({ $dataUrl: "$.image" }, { image: "https://cdn/a.png" })).toBe(
      "https://cdn/a.png",
    );
  });

  it("falls back to image/png when the bytes are unrecognisable", () => {
    // Backward compatible: an unknown payload keeps the old behaviour.
    expect(applyMapping({ $dataUrl: "$.image" }, { image: "QUJDRA==" })).toBe(
      "data:image/png;base64,QUJDRA==",
    );
  });
});
