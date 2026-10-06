/**
 * tests/unit/assistant-names-only-real-controls.test.ts
 *
 * The assistant talks to the user through the model, so a sentence in a tool
 * message is effectively a UI instruction with no compiler and no reviewer in
 * the loop. That is how a removed microphone button went on being recommended
 * for a while after it stopped existing: the record control next to the
 * paperclip was deleted, and `resolveReferenceAudio` kept telling people to
 * press it. Nothing failed. People just went looking for a button that was
 * never going to appear.
 *
 * The composer is the only thing that knows which controls exist, so the two
 * are pinned together here: the assistant may not name a recording control at
 * all, and whatever it *does* name has to be something the composer renders.
 *
 * Comments are stripped before any of this, and the stripper is string-aware
 * on purpose. A naive `replace(/\/\/.*$/gm)` deletes the rest of any line
 * holding a URL, and a comment is exactly where a future maintainer will
 * document *why* a phrase is banned — so the naive version both misses real
 * hits and turns the explanation into a false alarm. The stripper checks
 * itself below; a guard whose own parser is wrong is worse than no guard.
 *
 * Known limitation: regular-expression literals are not distinguished from
 * division, so a `/` that opens a regex containing `/*` would be misread. No
 * such literal exists in the files scanned here, and the failure mode is a
 * comment surviving, not an error.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/**
 * Remove comments, leaving string and template contents intact.
 *
 * Contents are preserved on purpose: the phrases this file looks for live
 * inside string literals, so blanking them would make the guard vacuous.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const char = src[i];
    const next = src[i + 1];

    if (char === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out += quote;
          i++;
          break;
        }
        out += src[i];
        i++;
      }
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", ".next"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const read = (rel: string): string => stripComments(readFileSync(join(ROOT, rel), "utf8"));

/** Everything the assistant can say to the user, prompts and tool messages alike. */
const ASSISTANT_SOURCES = walk(join(ROOT, "src", "lib", "assistant"))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => relative(ROOT, f).replace(/\\/g, "/"));

/**
 * Recording controls, and the words used to ask for one.
 *
 * `语音` on its own is deliberately absent: the assistant legitimately talks
 * about 语音转写 and 语音合成 all day. What must not survive is telling a user
 * to *press something* to record.
 */
const RECORDING_CONTROL = /麦克风|语音按钮|录音|按住说话|口述/;

const COMPOSER = "src/app/(user)/dashboard/assistant/AssistantChat.tsx";

describe("the composer defines which controls exist", () => {
  it("the stripper removes comments without eating strings", () => {
    // A comment that names the banned phrase must not be read as code.
    expect(stripComments("// 麦克风\nconst a = 1;")).not.toMatch(RECORDING_CONTROL);
    expect(stripComments("/* 录音 */\nconst a = 1;")).not.toMatch(RECORDING_CONTROL);
    // A `//` inside a string is not a comment: stripping it would blind the
    // guard to any string that happens to hold a URL.
    expect(stripComments('const u = "https://example.test";')).toContain("https://example.test");
    // …and string contents survive, or nothing below could ever fire.
    expect(stripComments('const s = "语音按钮";')).toMatch(RECORDING_CONTROL);
  });

  it("offers exactly one way to attach audio: the paperclip", () => {
    const composer = read(COMPOSER);
    expect(composer, "the composer must render the control the assistant names").toMatch(
      /<Paperclip\b/,
    );
    // Named in the assistant's message, so it has to accept audio.
    expect(composer).toMatch(/accept="[^"]*audio\/\*/);
  });

  it("the recording control is genuinely gone, not just unreferenced", () => {
    // No capture API anywhere. The route the button used was removed with it:
    // an endpoint with no caller is not inert — it still authenticates, still
    // spends the caller's credential and still forwards audio upstream, it just
    // has nothing behind it to reach it. If a mic ever comes back, that route
    // is the first thing to rebuild, not the first thing to find.
    const runtime = walk(join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    const capture = runtime.filter((f) =>
      /MediaRecorder|getUserMedia/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(
      capture.map((f) => relative(ROOT, f).replace(/\\/g, "/")),
      "something can record audio, so the wording above is not the whole truth",
    ).toEqual([]);
  });
});

describe("the assistant does not send people looking for controls that are not there", () => {
  it("no assistant prompt or tool message recommends a recording control", () => {
    const offenders = ASSISTANT_SOURCES.filter((f) =>
      RECORDING_CONTROL.test(read(f)),
    );
    expect(
      offenders,
      `these tell the user to use a control the composer does not render:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
