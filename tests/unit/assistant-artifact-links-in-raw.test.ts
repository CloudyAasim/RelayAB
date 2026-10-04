/**
 * tests/unit/assistant-artifact-links-in-raw.test.ts
 *
 * The raw tool output named a generated image that was in it nowhere.
 *
 * `toolContentForDisplay` dropped the `artifacts` key and left the card above
 * as the only route to the picture. That is fine for a screenshot and useless
 * for a transcript: copying the raw tool output, or reading it back next week,
 * gave a record that something had been made and no way to reach it.
 *
 * The addresses stay in the text, in the place the artefact objects were. The
 * card still renders above it — the URLs are there for the transcript, not to
 * replace the picture.
 */
import { describe, it, expect } from "vitest";
import { toolContentForDisplay } from "@/app/(user)/dashboard/assistant/MediaArtifacts";

const withArtifacts = JSON.stringify({
  ok: true,
  text: "done",
  artifacts: [
    { id: "a1", kind: "image", url: "https://cdn.example/a1.png", contentType: "image/png" },
    { id: "a2", kind: "audio", url: "https://cdn.example/a2.mp3", contentType: "audio/mpeg" },
  ],
});

describe("the raw tool output carries the links", () => {
  it("and keeps the rest of what the tool said", () => {
    const out = JSON.parse(toolContentForDisplay(withArtifacts));
    expect(out.ok).toBe(true);
    expect(out.text).toBe("done");
  });

  it("with every address, for pictures and audio alike", () => {
    const out = JSON.parse(toolContentForDisplay(withArtifacts));
    expect(out.urls).toEqual(["https://cdn.example/a1.png", "https://cdn.example/a2.mp3"]);
  });

  it("and no longer carries the record that a card exists above it", () => {
    // On the parsed object, not the string: the artefact route is
    // `/api/assistant/artifacts/…`, so the addresses contain the word.
    expect(JSON.parse(toolContentForDisplay(withArtifacts))).not.toHaveProperty("artifacts");
  });

  it("a plain string artefact is handled too", () => {
    const out = JSON.parse(
      toolContentForDisplay(JSON.stringify({ ok: true, artifacts: ["https://cdn.example/x.png"] })),
    );
    expect(out.urls).toEqual(["https://cdn.example/x.png"]);
  });

  it("output with no artefacts is left exactly as it was", () => {
    const plain = JSON.stringify({ ok: true, text: "nothing to see" });
    expect(toolContentForDisplay(plain)).toBe(plain);
  });

  it("and a refusal, which is prose rather than JSON, is still shown as it is", () => {
    expect(toolContentForDisplay("工具执行失败：上游超时")).toBe("工具执行失败：上游超时");
  });
});
