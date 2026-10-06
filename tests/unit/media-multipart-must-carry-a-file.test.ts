/**
 * tests/unit/media-multipart-must-carry-a-file.test.ts
 *
 * A multipart request that carries no file should be caught here, not by the
 * vendor four seconds later.
 *
 * `asr-1.0` returned `missing required form field: file` with a file attached,
 * repeatedly and identically across deployments. The engine can name that cause
 * in milliseconds, so it does — and the check has to be proved against the shape
 * it exists for, which is a spec that maps the upload with `$dataUrl` and so
 * produces a text field where a server calling `FormFile` looks for a file.
 */
import { describe, expect, it } from "vitest";

import { parseMediaSpec, type MediaProvider, type MediaSpec } from "@/lib/media/spec";
import { executeMedia } from "@/lib/media/engine";
import { MINIMAX_STT_SPEC } from "@/lib/media/seeds";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "p",
  name: "MiniMax",
  baseUrl: "https://api.example.test",
  encryptedApiKey: encryptSecret("k"),
  enabled: true,
  priority: 1,
  models: {},
  specs: [],
  createdAt: "",
  updatedAt: "",
};

const dataUrl = `data:audio/mpeg;base64,${Buffer.alloc(32, 3).toString("base64")}`;

const spec = (raw: unknown): MediaSpec => {
  const parsed = parseMediaSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
};

/** `file` mapped with `$dataUrl` — a text field, not a multipart file part. */
const dataUrlSpec = spec({
  specVersion: 1,
  capability: "audio.stt",
  displayName: "Mapped with $dataUrl",
  models: ["asr-1.0"],
  transport: { method: "POST", path: "/v1/speech_to_text", contentType: "multipart/form-data" },
  auth: { type: "bearer" },
  request: { model: "$.model", file: { $dataUrl: "$.image" } },
  response: { text: "$.text" },
});

/** `file` mapped with nothing at all. */
const unmappedSpec = spec({
  specVersion: 1,
  capability: "audio.stt",
  displayName: "No mapping for the upload",
  models: ["asr-1.0"],
  transport: { method: "POST", path: "/v1/speech_to_text", contentType: "multipart/form-data" },
  auth: { type: "bearer" },
  request: { model: "$.model" },
  response: { text: "$.text" },
});

async function run(s: MediaSpec): Promise<{ outcome: Awaited<ReturnType<typeof executeMedia>>; calls: number }> {
  let calls = 0;
  const outcome = await executeMedia({
    spec: s,
    provider,
    input: { model: "asr-1.0", image: dataUrl, extra: { audio: dataUrl, filename: "a.mp3" } },
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  return { outcome, calls };
}

describe("a multipart spec that would send no file", () => {
  it("is refused here, with the reason, before the round trip", async () => {
    const { outcome, calls } = await run(dataUrlSpec);
    expect(calls).toBe(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("spec_produces_no_file");
  });

  it("and the message says what to write, not just what went wrong", async () => {
    // A diagnosis the reader cannot act on is the same as no diagnosis. The two
    // ways a spec gets here are named, because guessing between them is what
    // this whole failure was.
    const { outcome } = await run(unmappedSpec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("$file");
    expect(outcome.error.message).toContain("$dataUrl");
    expect(outcome.error.message).toMatch(/multipart/);
  });

  it("and the same spec mapped with `$file` is allowed through", async () => {
    // The check must not fire on a spec that is doing the right thing, or it is
    // just a way of refusing every upload.
    const { outcome, calls } = await run(MINIMAX_STT_SPEC);
    expect(calls).toBe(1);
    expect(outcome.ok).toBe(true);
  });

  it("a multipart spec with no upload is left to the caller that owns it", async () => {
    // Nothing was uploaded, so this is not a spec problem and saying so would be
    // a guess. The routes already refuse an empty upload with their own message.
    let calls = 0;
    const outcome = await executeMedia({
      spec: unmappedSpec,
      provider,
      input: { model: "asr-1.0" },
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });
    expect(calls).toBe(1);
    expect(outcome.ok).toBe(true);
  });

  it("a JSON spec is not affected", async () => {
    // The check is scoped to multipart by construction; this pins that a
    // non-multipart spec with no file is still just a normal call.
    const jsonSpec = spec({
      specVersion: 1,
      capability: "image.generate",
      displayName: "plain",
      models: ["m"],
      transport: { method: "POST", path: "/v1/i" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.url" }] },
    });
    let calls = 0;
    const outcome = await executeMedia({
      spec: jsonSpec,
      provider,
      input: { model: "m", prompt: "hi", image: dataUrl },
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ url: "u" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });
    expect(calls).toBe(1);
    expect(outcome.ok).toBe(true);
  });
});
