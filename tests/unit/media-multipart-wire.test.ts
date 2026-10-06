/**
 * tests/unit/media-multipart-wire.test.ts
 *
 * What actually goes on the wire when an upload is forwarded to a vendor.
 *
 * `asr-1.0` came back saying `invalid params, missing required form field: file`,
 * with a file attached the whole time. The request was built correctly as far as
 * any JavaScript object was concerned — the part was there, named `file`, carrying
 * the right bytes. It stopped being readable one layer lower, in the header that
 * tells a parser how to read the part.
 *
 * Both halves of that are invisible to any test that inspects a `File` or a
 * `FormData`: both looked right. Only the serialised body shows it, so these
 * tests read the bytes.
 */
import { describe, it, expect } from "vitest";

import { MINIMAX_STT_SPEC } from "@/lib/media/seeds";
import { executeMedia } from "@/lib/media/engine";
import { buildScope } from "@/lib/media/handler";
import type { MediaProvider } from "@/lib/media/spec";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "p",
  name: "MiniMax",
  baseUrl: "https://api.minimax.cn",
  encryptedApiKey: encryptSecret("k"),
  enabled: true,
  priority: 1,
  models: {},
  specs: [],
  createdAt: "",
  updatedAt: "",
};

const dataUrl = `data:audio/mpeg;base64,${Buffer.alloc(64, 7).toString("base64")}`;

/** Run the real spec against the real scope, and return the serialised body. */
async function wireBodyFor(filename: string): Promise<{ wire: string; headers: Headers }> {
  let headers!: Headers;
  let body: unknown;
  const outcome = await executeMedia({
    spec: MINIMAX_STT_SPEC,
    provider,
    input: buildScope({
      model: "asr-1.0",
      image: dataUrl,
      extra: { audio: dataUrl, filename, language: "zh" },
    }),
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Headers;
      body = init?.body;
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  expect(outcome.ok, "the engine rejected the request before it was sent").toBe(true);
  return { wire: await new Response(body as FormData).text(), headers };
}

describe("a multipart part a vendor's parser can read", () => {
  it("carries an ASCII filename, whatever the upload was called", async () => {
    // The quoted-string form of `Content-Disposition` is printable ASCII and
    // nothing else. Non-ASCII has to travel as RFC 2047 or RFC 5987/2231, and
    // the FormData `fetch` serialises does neither — it writes the bytes as they
    // are. A Go `mime.ParseMediaType` rejects the header, the part is dropped, and
    // the only thing the caller can be told is that the field is missing.
    const { wire } = await wireBodyFor("1 无处安放.mp3");

    expect(wire).toContain('name="file"');
    // The `file` part's own header, not the first one — the `model` part is
    // Content-Disposition too and carries no filename at all.
    const disposition =
      wire.split("\r\n").find((l) => l.startsWith("Content-Disposition") && l.includes('name="file"')) ?? "";
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] ?? "";
    // eslint-disable-next-line no-control-regex
    expect(filename, "a quoted filename may not carry non-ASCII").toMatch(/^[\x20-\x7e]*$/);
    expect(filename).not.toBe("");
    // The extension is the part a vendor may still read, so it survives.
    expect(filename.endsWith(".mp3")).toBe(true);
  });

  it("declares a real media type, without the data URL's encoding marker", async () => {
    // `data:audio/mpeg;base64,…` says `audio/mpeg`. The `;base64` is the
    // encoding marker, a parameter, and reading the slice verbatim put it into
    // the part's own Content-Type — which is then not a media type at all.
    const { wire } = await wireBodyFor("clip.mp3");
    expect(wire).toContain("Content-Type: audio/mpeg\r\n");
    expect(wire).not.toContain("audio/mpeg;base64");
  });

  it("and still sends the part MiniMax says is required, with the bytes", async () => {
    // The failure said `file` was missing. It is the field's presence and its
    // contents that matter, so both are checked here rather than the mapping.
    const { wire, headers } = await wireBodyFor("无处安放.mp3");
    expect(wire).toContain('name="file"');
    expect(wire).toContain("asr-1.0");
    // The data URL's own label is the part's type; the multipart boundary comes
    // from fetch, and the engine must not have pre-empted it.
    expect(headers.get("content-type")).toBeNull();
    // The bytes are raw in the body, not base64 — the data URL was decoded on the
    // way in. A file part whose payload had been left encoded would still parse
    // and still transcribe as noise, so the check is the decoded bytes.
    const afterHeader = wire.slice(
      wire.indexOf("Content-Type: audio/mpeg\r\n\r\n") + "Content-Type: audio/mpeg\r\n\r\n".length,
    );
    expect(afterHeader.startsWith("".repeat(64))).toBe(true);
  });
});

describe("a filename that was already safe", () => {
  it("is passed through untouched", async () => {
    // Sanitising must not be a renaming policy: a name with nothing wrong with
    // it is the one the caller chose, and a vendor that does use it should get it.
    const { wire } = await wireBodyFor("meeting-2026-09.mp3");
    expect(wire).toContain('filename="meeting-2026-09.mp3"');
  });

  it("and a name with no usable characters left still produces a part", async () => {
    // Not an empty filename: an empty one is a header the parser can reject for a
    // different reason, which is the same failure wearing another hat.
    const { wire } = await wireBodyFor("录音.mp3");
    expect(wire).toContain('name="file"; filename="');
    expect(wire).not.toContain('filename=""');
  });
});
