/**
 * tests/unit/assistant-voice-file.test.ts
 *
 * Dictation is a file, not a microphone.
 *
 * There was a recording button. It needed a browser permission, and the page
 * could not tell a refusal from a block from a device another program was
 * holding — so across three versions it either said nothing when something was
 * wrong, or said something confidently wrong, the worst of which told an
 * operator who had just set the microphone to Allow that the browser had
 * remembered a refusal.
 *
 * The transcription endpoint does not care where the audio came from, and a
 * file removes every one of those cases: no permission, no device, nothing for
 * the browser to remember.
 *
 * The endpoint is unchanged and still the one thing both the file path and any
 * future client go through, so the shape of the request is pinned here rather
 * than only the button.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const BUTTON = read("src", "app", "(user)", "dashboard", "assistant", "VoiceFileButton.tsx");
const CHAT = read("src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");
const ROUTE = read("src", "app", "api", "assistant", "transcribe", "route.ts");
const DICT = read("src", "lib", "i18n", "dict.ts");

describe("no microphone is requested anywhere", () => {
  it("the button asks for a file, not a device", () => {
    // `getUserMedia` was the whole of it. Asserted on the call, not the word,
    // so the comment that explains the removal cannot satisfy this.
    expect(BUTTON).not.toMatch(/getUserMedia/);
    expect(BUTTON).not.toMatch(/MediaRecorder/);
    expect(BUTTON).not.toMatch(/navigator\.permissions/);
    expect(BUTTON).toMatch(/type="file"/);
    expect(BUTTON).toMatch(/accept="audio\/\*/);
  });

  it("and the chat screen has no microphone in it", () => {
    expect(CHAT).toMatch(/<VoiceFileButton/);
    expect(CHAT).not.toMatch(/MicButton/);
  });

  it("no string promises a recording it does not make", () => {
    // A label left behind after the button it belonged to is how an operator
    // ends up looking for something that is not there.
    for (const gone of ["start", "stop", "asking", "waiting", "refused", "busy", "noDevice"]) {
      expect(DICT, `assistant.voice.${gone} survived`).not.toMatch(
        new RegExp(`"assistant\\.voice\\.${gone}":`),
      );
    }
  });
});

describe("a voice file is transcribed into the input box", () => {
  it("goes to the same OpenAI-compatible endpoint", () => {
    expect(BUTTON).toMatch(/fetch\("\/api\/assistant\/transcribe", \{ method: "POST", body: form \}\)/);
    expect(BUTTON).toMatch(/form\.append\("file", file, file\.name\)/);
    // And that route is the media engine's `audio.stt`, so the operator's spec
    // decides what a model name means here too.
    expect(ROUTE).toMatch(/capability: "audio\.stt"/);
    expect(ROUTE).toMatch(/executeMediaRequest\(/);
  });

  it("appends to what was already typed, not over it", () => {
    // A half-written thought followed by a dictated one is still one message.
    expect(CHAT).toMatch(/prev \? `\$\{prev\.replace\(\/\\s\*\$\/, ""\)\} \$\{text\}` : text/);
  });

  it("refuses a file it will not carry before asking the server", () => {
    expect(BUTTON).toMatch(/const MAX_BYTES = \d+ \* 1024 \* 1024/);
    expect(BUTTON).toMatch(/if \(file\.size > MAX_BYTES\)/);
    expect(DICT).toMatch(/assistant\.voice\.tooLarge/);
  });

  it("each remaining string exists in both languages", () => {
    for (const key of ["pickFile", "working", "tooLarge", "failed", "empty"]) {
      const hits = DICT.match(new RegExp(`"assistant\\.voice\\.${key}":`, "g")) ?? [];
      expect(hits.length, key).toBe(2);
    }
  });
});
