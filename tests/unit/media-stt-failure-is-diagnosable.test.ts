/**
 * tests/unit/media-stt-failure-is-diagnosable.test.ts
 *
 * A failed media call has to say why, and the branch that builds the error for a
 * plain non-2xx threw the reason away.
 *
 * The engine reads the upstream body, runs the spec's error rules, runs the spec's
 * `httpStatus` fallback, and then — for an error the spec could not name — reported
 * `upstream returned HTTP 400` and dropped the body it had already read. The async
 * branch right below it deliberately does the opposite and says why: "upstream did
 * not return a task id" on its own is a dead end, and carrying the body turns it
 * into something the caller can act on.
 *
 * The gap is not cosmetic. A vendor that refuses to parse a request answers at the
 * HTTP layer, with no `base_resp` in the body — so the spec maps nothing, the
 * fallback fires, and the one piece of evidence is discarded. `asr-1.0` through the
 * media test came back as exactly that, and nothing in the message said what
 * MiniMax objected to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseMediaSpec, type MediaProvider, type MediaSpec } from "@/lib/media/spec";
import { executeMedia } from "@/lib/media/engine";
import { MINIMAX_STT_SPEC } from "@/lib/media/seeds";
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

const spec = (raw: unknown): MediaSpec => {
  const parsed = parseMediaSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
};

describe("a media failure the spec cannot name still says why", () => {
  const minimal = spec({
    specVersion: 1,
    capability: "image.generate",
    displayName: "bare",
    models: ["m"],
    transport: { method: "POST", path: "/v1/x" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: { items: [{ kind: "url", value: "$.url" }] },
  });

  it("carries the upstream's own words into the message", async () => {
    // A gateway-level refusal: a real status, a body in no shape this spec maps.
    const outcome = await executeMedia({
      spec: minimal,
      provider,
      input: { model: "m", prompt: "hi" },
      fetchImpl: (async () =>
        new Response("invalid file type: expected audio, got text/plain", {
          status: 400,
          headers: { "content-type": "text/plain" },
        })) as never,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("upstream_error");
    expect(outcome.error.message).toContain("upstream returned HTTP 400");
    // The part that was being thrown away.
    expect(outcome.error.message).toContain("invalid file type");
  });

  it("still prefers the spec's mapped vendor message when there is one", async () => {
    // Carrying the body must not crowd out the better message MiniMax's own
    // `base_resp.status_msg` gives on an in-body error.
    const withVendorMessage = spec({
      ...minimal,
      response: {
        items: [{ kind: "url", value: "$.url" }],
        errorMessage: "$.base_resp.status_msg",
        errorCode: "$.base_resp.status_code",
      },
    });
    const outcome = await executeMedia({
      spec: withVendorMessage,
      provider,
      input: { model: "m", prompt: "hi" },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 2013, status_msg: "输入格式信息不正常" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as never,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toBe("输入格式信息不正常");
  });

  it("says nothing extra when the upstream had no body to give", async () => {
    const outcome = await executeMedia({
      spec: minimal,
      provider,
      input: { model: "m", prompt: "hi" },
      fetchImpl: (async () => new Response("", { status: 502 })) as never,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toBe("upstream returned HTTP 502");
  });

  it("keeps a vendor HTML error page to one readable line", async () => {
    // Real gateways answer with an HTML document. This string is shown to a
    // person, and an uncollapsed page is neither.
    const html = `<html>\n  <body>\n    <h1>400 Bad Request</h1>\n    ${"padding ".repeat(80)}\n  </body>\n</html>`;
    const outcome = await executeMedia({
      spec: minimal,
      provider,
      input: { model: "m", prompt: "hi" },
      fetchImpl: (async () => new Response(html, { status: 400 })) as never,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).not.toContain("\n");
    expect(outcome.error.message.length).toBeLessThan(400);
  });
});

describe("the speech-to-text spec describes the file it was given", () => {
  it("does not call every upload an mp3", () => {
    // MiniMax's ASR takes wav / aiff / flac / m4a / mp3 / aac / opus / ogg. A
    // hardcoded `audio/mpeg` labels every m4a and wav as an mp3, and a vendor
    // reading the part's own type is entitled to refuse. Omitting the field lets
    // `$file` report the type the bytes actually declare.
    const request = (MINIMAX_STT_SPEC.request ?? {}) as Record<string, unknown>;
    const file = (request.file ?? {}) as { $file?: Record<string, unknown> };
    expect(file?.$file).toBeDefined();
    expect(file?.$file?.contentType).toBeUndefined();
    // The two things it does declare still have to be there.
    expect(file?.$file?.path).toBe("$.image");
    expect(file?.$file?.filename).toBe("$.filename");
  });

  it("and the engine sniffs a type when the spec does not name one", () => {
    // Without this the previous line would pass while every non-mp3 upload
    // arrives labelled `application/octet-stream`, which is the same class of
    // mislabelling one layer down.
    const engine = readFileSync(
      join(process.cwd(), "src", "lib", "media", "engine.ts"),
      "utf8",
    );
    expect(engine).toMatch(/contentType:\s*params\.contentType\s*\n?\s*\? String\(params\.contentType\)\s*\n?\s*: String\(headerType\)/);
    expect(engine).toContain("const headerType = isDataUrl");
  });
});
