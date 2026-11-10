/**
 * tests/unit/media-test-result.test.ts
 *
 * The reader that made one media test show two different answers depending on
 * which credential it spent.
 *
 * The account path answers `{ ok, data: { urls, images, text } }`; the public
 * endpoints answer `{ data: [{ url | b64_json }] }`. The page read both with the
 * public-shape reader, so a successful 26-second account-path image came back as
 * "（没有产物）" and a transcription printed its own JSON envelope.
 *
 * These tests pin both shapes, and pin the base64 artifact travelling as a data
 * URL rather than as a count.
 */
import { describe, it, expect } from "vitest";
import {
  buildMediaTestPayload,
  imageDataUrl,
  readMediaTestResult,
} from "@/lib/media/test-result";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("imageDataUrl", () => {
  it("names the type from the bytes instead of trusting a default", () => {
    expect(imageDataUrl(PNG_B64)).toMatch(/^data:image\/png;base64,/);
    expect(imageDataUrl("/9j/4AAQSkZJRg==")).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageDataUrl("UklGRiQAAABXRUJQ")).toMatch(/^data:image\/webp;base64,/);
    expect(imageDataUrl("R0lGODlhAQABAA==")).toMatch(/^data:image\/gif;base64,/);
  });

  it("falls back to png for bytes it does not recognise", () => {
    expect(imageDataUrl("AAAA")).toMatch(/^data:image\/png;base64,/);
  });
});

describe("buildMediaTestPayload", () => {
  it("carries links and inline artifacts separately, both displayable", () => {
    const payload = buildMediaTestPayload(
      [
        { kind: "url", value: "https://cdn.example/a.png" },
        { kind: "base64", value: PNG_B64 },
      ],
      { ms: 1234 },
    );
    expect(payload.via).toBe("account");
    expect(payload.ms).toBe(1234);
    expect(payload.urls).toEqual(["https://cdn.example/a.png"]);
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("only mentions text and id when the capability produced them", () => {
    expect(buildMediaTestPayload([], { ms: 5 })).not.toHaveProperty("text");
    expect(buildMediaTestPayload([], { ms: 5 })).not.toHaveProperty("id");
    const stt = buildMediaTestPayload([{ kind: "text", value: "你好" }], { ms: 5, text: "你好", id: "task-1" });
    expect(stt.text).toBe("你好");
    expect(stt.id).toBe("task-1");
  });
});

describe("readMediaTestResult", () => {
  it("reads the account shape — the one the page used to throw away", () => {
    const payload = buildMediaTestPayload(
      [{ kind: "url", value: "https://cdn.example/a.png" }, { kind: "base64", value: PNG_B64 }],
      { ms: 26337 },
    );
    const result = readMediaTestResult({ ok: true, data: payload });
    expect(result.urls).toEqual(["https://cdn.example/a.png"]);
    expect(result.images).toHaveLength(1);
  });

  it("reads the public OpenAI shape, links and inline alike", () => {
    const result = readMediaTestResult({
      data: [{ url: "https://cdn.example/b.png" }, { b64_json: PNG_B64 }, { revised_prompt: "x" }],
    });
    expect(result.urls).toEqual(["https://cdn.example/b.png"]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("reads a transcription through the account envelope", () => {
    const result = readMediaTestResult({
      ok: true,
      data: { via: "account", ms: 900, text: "这是一段转写", urls: [], images: [] },
    });
    expect(result.text).toBe("这是一段转写");
  });

  it("reads a bare { text } answer too", () => {
    expect(readMediaTestResult({ text: "hello" }).text).toBe("hello");
  });

  it("reads an unknown shape as empty rather than throwing", () => {
    for (const payload of [null, undefined, 42, "nope", {}, { data: null }, { data: [1, 2] }]) {
      expect(readMediaTestResult(payload)).toEqual({ urls: [], images: [], text: "" });
    }
  });

  it("drops non-string entries instead of rendering [object Object]", () => {
    const result = readMediaTestResult({ data: { urls: ["https://ok.example/x.png", 7, null], images: [{}] } });
    expect(result.urls).toEqual(["https://ok.example/x.png"]);
    expect(result.images).toEqual([]);
  });
});
