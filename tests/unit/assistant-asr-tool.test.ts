/**
 * tests/unit/assistant-asr-tool.test.ts
 *
 * The assistant could not read the audio file it had been handed.
 *
 * It could generate images, speech and video, and it had a transcription
 * endpoint — but no tool for it. Asked to read an .mp3 attached to its own
 * message, it explained `/v1/audio/transcriptions` to the user and told them to
 * post it themselves, while the gateway already had an `audio.stt` spec and the
 * file sat in the message it was reading.
 *
 * Two things are pinned here. The tool exists and takes the same `attachment`
 * shorthand the image tool already uses, so "read the audio the user just sent"
 * is expressible. And the briefing tells the model to use it instead of writing
 * a curl for the user — because the briefing is what it was reading when it
 * said it had no ASR tool, and a tool that is not in the briefing is a tool the
 * model does not know it has.
 *
 * The documentation carries the endpoint paths for the same reason: the media
 * page used to group the endpoints into three headings and omit the paths, and
 * the assistant filled the gap by guessing. A document that cannot answer a
 * question gets a wrong answer, not no answer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const TOOLS = read("src", "lib", "assistant", "tools.ts");
const PROMPTS = read("src", "lib", "assistant", "prompts.ts");
const DICT = read("src", "lib", "i18n", "dict.ts");

describe("the assistant can read an audio file it was given", () => {
  it("there is a tool for it", () => {
    expect(TOOLS).toMatch(/name: "transcribe_audio"/);
    expect(TOOLS).toMatch(/case "transcribe_audio"/);
  });

  it("it takes the same `attachment` shorthand as the image tool", () => {
    // Otherwise the only way to use it is to paste a megabyte of base64 into a
    // tool call, which is the thing the shorthand exists to avoid.
    expect(TOOLS).toMatch(/audio: \{[\s\S]{0,400}attachment/);
    expect(TOOLS).toMatch(/resolveReferenceAudio/);
    expect(TOOLS).toMatch(/kind === "audio"/);
  });

  it("and it goes through the same engine and the same slot as the public route", () => {
    // One spec resolves this identically whichever door it came through, which
    // is the whole reason the public route and the assistant agree.
    expect(TOOLS).toMatch(/capability: "audio\.stt"/);
    expect(TOOLS).toMatch(/image: resolved\.dataUrl/);
    expect(TOOLS).toMatch(/extra: \{ audio: resolved\.dataUrl, filename: resolved\.name/);
  });

  it("and a missing model is answered from this deployment, not from upstream", () => {
    // A 400 from the vendor about a model name is a question with an answer in
    // the media providers this gateway already has.
    expect(TOOLS).toMatch(/listSttModels/);
    expect(TOOLS).toMatch(/请指定语音识别模型/);
  });

  it("and it returns the text so the model can put it in a message", () => {
    expect(TOOLS).toMatch(/message: text \|\| "没有识别到内容。"/);
  });
});

describe("the briefing says it, because a tool nobody mentions does not exist", () => {
  it("lists transcription beside the other media tools", () => {
    expect(PROMPTS).toMatch(/transcribe_audio/);
    // And says not to hand the user a curl for it.
    expect(PROMPTS).toMatch(/不要/);
    expect(PROMPTS).toMatch(/audio\/transcriptions/);
  });

  it("the media documentation carries the paths, not just the groupings", () => {
    // The assistant said this page grouped the endpoints without expanding the
    // paths, and then guessed. A path in the string is a path the assistant
    // reads, because the docs index is generated from these keys.
    for (const path of [
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/videos/generations",
      "/v1/audio/speech",
      "/v1/audio/transcriptions",
      "/v1/audio/music",
    ]) {
      // At least once: a path may also appear in an example further down, and
      // that is fine — what must not happen is it being absent.
      const hits = DICT.split(`"docs.media.`).filter((l) => l.includes(path));
      expect(hits.length, `${path} appears in a media doc string`).toBeGreaterThanOrEqual(1);
    }
  });
});
