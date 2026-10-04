/**
 * tests/unit/assistant-settings-choose-a-model.test.ts
 *
 * The assistant's settings answer "which model", not "tune it".
 *
 * Four per-model parameters — a context window, an output cap, a temperature and
 * a top_p — were added, and then removed. They were removed because they asked
 * for numbers about a model this gateway does not own: it lives on the caller's
 * own upstream, which has its own defaults, its own context window and its own
 * idea of what a turn costs them. And a form that can lose the thing it is
 * picking is not a picker.
 *
 * This file exists so the removal is a decision rather than an oversight. The
 * columns are gone, the form is gone, and the history bound that motivated all
 * of it is now one number in one place — the history is still trimmed, because
 * a long thread becoming an upstream 400 on somebody's turn is still a bug, but
 * it is a system valve rather than a parameter invented for somebody's model.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PANEL = read(
  "src",
  "app",
  "(user)",
  "dashboard",
  "assistant",
  "AssistantSettingsPanel.tsx",
);
const CHAT = read("src", "lib", "assistant", "chat.ts");
const CLIENT = read("src", "lib", "assistant", "client.ts");
const SCHEMA = read("src", "lib", "assistant", "schema.ts");
const DB = read("src", "lib", "db", "assistant.ts");
const API = read("src", "app", "api", "assistant", "settings", "route.ts");
const SQLITE = read("src", "lib", "db", "sqlite.ts");
const DICT = read("src", "lib", "i18n", "dict.ts");

const GONE = [
  "contextLength",
  "maxOutputTokens",
  "temperature",
  "topP",
] as const;

describe("the assistant's settings choose a model and stop there", () => {
  it("the form offers no per-model parameter", () => {
    for (const field of GONE) {
      expect(PANEL, `the form still asks for ${field}`).not.toContain(field);
    }
    expect(DICT, "the dictionary still carries the parameter labels").not.toContain(
      "assistant.settings.modelParams",
    );
  });

  it("nothing stores them, so nothing can send them", () => {
    for (const [name, src] of [
      ["schema", SCHEMA],
      ["settings API", API],
      ["save path", DB],
      ["assistant client", CLIENT],
    ] as const) {
      for (const field of GONE) {
        expect(src, `${name} still carries ${field}`).not.toContain(field);
      }
    }
  });

  it("and the columns are gone rather than left behind unused", () => {
    // Nullable columns nothing reads are how the next person decides a field
    // means something.
    for (const column of [
      "context_length",
      "max_output_tokens",
      "temperature",
      "top_p",
    ]) {
      expect(SQLITE, `${column} is still in the schema`).not.toContain(column);
    }
  });

  it("the history is still bounded, by one number in one place", () => {
    // Removing the settings did not remove the problem that motivated them: a
    // message *count* is not a bound, and forty messages of a long conversation
    // plus an image plus a documentation page is already past a 32k window. The
    // failure was an upstream 400 on somebody's turn.
    expect(CHAT, "the history is no longer trimmed at all").toMatch(
      /toWireMessages\(fitToWindow\(history\)/,
    );
    expect(CHAT).toMatch(/const HISTORY_BUDGET_TOKENS = \d[\d_]*;/);
    // Whole turns from the front, never half a turn.
    expect(CHAT).toMatch(/kept\.unshift\(recent\[i\]\)/);
    expect(CHAT, "a history message is truncated by content").not.toMatch(
      /content:\s*[^,\n]*\.slice\(/,
    );
    // …and the newest turn always survives, even alone over budget.
    expect(CHAT).toMatch(/if \(kept\.length === 0 && recent\.length > 0\)/);
  });

  it("and a turn still needs a model on both paths", () => {
    // A stored row with a blank model used to look configured; the send went
    // out and was refused mid-conversation instead of by a field that would not
    // let you.
    const chat = read("src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");
    expect(chat).toMatch(/const missingModel = !modelLabel\.trim\(\);/);
    expect(chat).toMatch(/const canSend =[\s\S]{0,90}!missingModel/);
  });
});
