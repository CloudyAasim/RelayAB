/**
 * tests/unit/assistant-model-params.test.ts
 *
 * The assistant's model had a name and nothing else.
 *
 * It is the caller's own upstream rather than one of the operator's provider
 * rows, so nothing forced the fields to exist, and the consequences were real:
 * the history was bounded by a *message count* with no idea what it weighed, and
 * the upstream chose the answer length.
 *
 * The trap this file exists for is the quiet one. Four columns, four form boxes,
 * and a save that writes them all is a feature that looks complete and changes
 * nothing — the model answers exactly as before with no way to tell. So the
 * assertions are on the request body, not on the storage.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const SQLITE = read("src", "lib", "db", "sqlite.ts");
const SCHEMA = read("src", "lib", "assistant", "schema.ts");
const DB = read("src", "lib", "db", "assistant.ts");
const API = read("src", "app", "api", "assistant", "settings", "route.ts");
const CLIENT = read("src", "lib", "assistant", "client.ts");
const CHAT = read("src", "lib", "assistant", "chat.ts");
const PANEL = read(
  "src",
  "app",
  "(user)",
  "dashboard",
  "assistant",
  "AssistantSettingsPanel.tsx",
);

const PARAMS = [
  "contextLength",
  "maxOutputTokens",
  "temperature",
  "topP",
] as const;

describe("a configured parameter reaches the request", () => {
  it("three of them are sent as request fields", () => {
    // Each conditional rather than `temperature: opts.temperature`: an explicit
    // undefined is still a key in the JSON body, and "I did not choose a
    // temperature" must not arrive as one.
    expect(CLIENT).toMatch(
      /\.\.\.\(opts\.maxTokens !== undefined \? \{ max_tokens: opts\.maxTokens \} : \{\}\)/,
    );
    expect(CLIENT).toMatch(
      /\.\.\.\(opts\.temperature !== undefined \? \{ temperature: opts\.temperature \} : \{\}\)/,
    );
    expect(CLIENT).toMatch(/\.\.\.\(opts\.topP !== undefined \? \{ top_p: opts\.topP \} : \{\}\)/);
  });

  it("and `runChat` reads them off the settings rather than a local copy", () => {
    for (const field of ["maxOutputTokens", "temperature", "topP"]) {
      expect(CHAT, `${field} is stored but never read`).toContain(`settings.${field}`);
    }
    // `!= null` rather than a truthiness test: 0 is a legal temperature.
    expect(CHAT).toMatch(/settings\.temperature != null \? \{ temperature: settings\.temperature \}/);
  });

  it("the context window trims the history", () => {
    // The one thing here that was genuinely unbounded: forty messages is a
    // message count, and a long turn plus an image plus a documentation page
    // the model read is already past a 32k window.
    expect(CHAT).toMatch(/function fitToWindow</);
    expect(CHAT).toMatch(/toWireMessages\(fitToWindow\(history, settings\?\.contextLength\)/);
    // Whole turns from the front, never half a message: half a tool result is a
    // fact the model will act on. Pinned by the absence of any content rewrite,
    // stated as two direct shapes rather than a slice of the file, which stops
    // matching the day the surrounding code moves.
    expect(CHAT).toMatch(/kept\.unshift\(recent\[i\]\)/);
    expect(CHAT, "a history message is rewritten in place").not.toMatch(/recent\[i\]\s*=/);
    expect(CHAT, "a history message is truncated by content").not.toMatch(
      /content:\s*[^,\n]*\.slice\(/,
    );
    // …and the newest turn always survives, even alone over budget. Dropping the
    // message somebody just typed is worse than sending something too long.
    expect(CHAT).toMatch(/if \(kept\.length === 0 && recent\.length > 0\)/);
  });

  it("an unset window falls back to the system valve, never to no limit", () => {
    // Two ways this can go wrong and both were shipped at some point. The first
    // is "unset means no budget at all", which is the bug the module valve was
    // added for: forty messages of a long thread is an upstream 400 on somebody's
    // turn. The second is taking the *smaller* of the declared window and the
    // valve, which is worse because it is silent — somebody declares 200k and
    // still gets a 24k conversation with nothing on screen saying so.
    expect(CHAT).toMatch(/function historyBudgetTokens\(contextLength\?: number \| null\): number/);
    expect(CHAT).toMatch(/return Math\.max\(0, contextLength - RESERVED_TOKENS\);/);
    expect(CHAT).toMatch(/return HISTORY_BUDGET_TOKENS;/);
    expect(CHAT, "the declared window is capped by the fallback").not.toMatch(
      /Math\.min\([^)]*contextLength[^)]*HISTORY_BUDGET_TOKENS/,
    );
    expect(CHAT).toMatch(/const recent = history\.slice\(-MAX_HISTORY_MESSAGES\)/);
  });
});

describe("blank is not zero, everywhere on this path", () => {
  it("nothing defaults to a value", () => {
    // A defaulted temperature makes a model answer differently after a deploy.
    // A defaulted output cap silently shortens long answers.
    for (const [file, name] of [
      [SQLITE, "assistant_settings"],
      [SCHEMA, "schema"],
    ] as const) {
      expect(file, `${name} defaults a model parameter`).not.toMatch(
        /context_length[^\n]*DEFAULT|temperature[^\n]*DEFAULT/,
      );
    }
    expect(SCHEMA).toMatch(/contextLength: z\.number\(\)\.int\(\)\.positive\(\)\.nullable\(\)\.optional\(\)/);
  });

  it("clearing a box clears the stored value", () => {
    // The write path distinguishes "leave it" from "clear it". Collapsing them
    // makes a stored temperature outlive the form that set it — and pinning only
    // the *signature* would not notice, so the branch itself is asserted.
    expect(DB).toMatch(
      /return next === undefined \? \(previous \?\? null\) : next;/,
    );
    expect(DB, "an explicit null no longer clears").not.toMatch(
      /return previous \?\? null;/,
    );
    // All four, not just one. Dropping `.nullable()` from a single field makes
    // clearing that box a 400 while the other three keep working, which reads
    // as "the form is broken for temperature" and nothing else.
    for (const field of ["contextLength", "maxOutputTokens", "temperature", "topP"]) {
      expect(API, `${field} can no longer be cleared`).toMatch(
        new RegExp(`${field}: z\\.number\\(\\)[^\\n]*\\.nullable\\(\\)\\.optional\\(\\)`),
      );
    }
    expect(API).toMatch(/contextLength: z\.number\(\)\.int\(\)\.positive\(\)[\s\S]{0,40}?\.nullable\(\)\.optional\(\)/);
  });

  it("and the form sends a blank as null rather than as 0", () => {
    expect(PANEL).toMatch(/function blankToNull\(raw: string\): number \| null/);
    expect(PANEL).toMatch(/if \(trimmed === ""\) return null;/);
    // The save body always carries all four, nulls included. Read from the
    // `payload()` builder rather than the JSX, which is where the values now
    // live after the form was rebuilt as a single column with a mode switch.
    const payload = PANEL.slice(PANEL.indexOf("function payload("));
    for (const field of PARAMS) {
      expect(payload, `${field} is not sent on save`).toMatch(new RegExp(`^\\s+${field},`, "m"));
    }
    // …and the numeric input is bound to the same null, not stringified to "".
    expect(PANEL).toMatch(/value=\{value === null \? "" : String\(value\)\}/);
    expect(PANEL).toMatch(/onChange=\{\(e\) => onChange\(blankToNull\(e\.target\.value\)\)\}/);
  });

  it("and the columns exist on an existing deployment", () => {
    // The table that matters is the one with rows in it; a fresh CREATE TABLE is
    // not enough, which is why every one of these is also in ADDED_COLUMNS.
    for (const column of [
      "context_length",
      "max_output_tokens",
      "temperature",
      "top_p",
    ]) {
      expect(SQLITE, `${column} is only in the fresh schema`).toContain(
        `{ table: "assistant_settings", column: "${column}"`,
      );
    }
  });
});
