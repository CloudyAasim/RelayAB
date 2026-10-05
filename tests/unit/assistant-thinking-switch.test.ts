/**
 * Whether the model thinks is a different parameter from how hard it thinks.
 *
 * The assistant could set a level and could not set a switch, because there was
 * nowhere to put one: one column, one request field, and on the wire the two are
 * unrelated. A user whose model supports turning thinking off had no way to turn
 * it off and no way to say that was the intent.
 *
 * The chain is checked end to end because every link of it can be missing and
 * the symptom is the same silence: a database column nothing writes, a setting
 * nothing sends, or a request body that carries the value in the wrong place.
 * Each of those was a real possibility while this was being built, and a test
 * that only checked the type would have passed through all three.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelParamsForRequest } from "@/lib/assistant/config";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const BASE_PARAMS = {
  contextLength: null,
  maxOutputTokens: null,
  temperature: null,
  topP: null,
  reasoningEffort: null,
  thinkingType: null,
} as const;

describe("the thinking switch reaches the request", () => {
  it("is a parameter of its own, not another level", () => {
    expect(modelParamsForRequest({ ...BASE_PARAMS, thinkingType: "disabled" })).toEqual({
      thinkingType: "disabled",
    });
    // A level must not be able to stand in for it, or the two merge again the
    // first time somebody types "off" into the wrong box.
    expect(
      modelParamsForRequest({ ...BASE_PARAMS, reasoningEffort: "disabled" }),
    ).toEqual({ reasoningEffort: "disabled" });
  });

  it("carries the vendor's own spelling, untranslated", () => {
    // The names do not agree between vendors, so a closed list here would refuse
    // the value the model in front of it actually wants.
    for (const value of ["adaptive", "disabled", "enabled", "on", "off"]) {
      expect(modelParamsForRequest({ ...BASE_PARAMS, thinkingType: value })).toEqual({
        thinkingType: value,
      });
    }
  });

  it("is absent rather than null when unset", () => {
    // The difference that matters: absent leaves the vendor's own default,
    // which on one of these models is its deepest and most expensive level.
    // Sending an explicit "off" it cannot honour is a 400, not a default.
    expect(modelParamsForRequest({ ...BASE_PARAMS, thinkingType: null })).toEqual({});
    expect(modelParamsForRequest({ ...BASE_PARAMS })).toEqual({});
  });

  it("travels beside a level without replacing it", () => {
    // Both are legitimate at once on a model that offers them, and dropping
    // either one silently is the failure this whole file is about.
    expect(
      modelParamsForRequest({
        ...BASE_PARAMS,
        reasoningEffort: "high",
        thinkingType: "adaptive",
      }),
    ).toEqual({ reasoningEffort: "high", thinkingType: "adaptive" });
  });
});

describe("the switch is stored, saved and sent", () => {
  const SQLITE = read("src", "lib", "db", "sqlite.ts");
  const REPO = read("src", "lib", "db", "assistant.ts");
  const ROUTE = read("src", "app", "api", "assistant", "settings", "route.ts");
  const CLIENT = read("src", "lib", "assistant", "client.ts");

  it("has a column, and a migration that adds it", () => {
    // A column with no migration is a column that exists only on a fresh
    // database, and the assistant on the existing one has no switch.
    expect(SQLITE).toMatch(/thinking_type\s+TEXT/);
    expect(SQLITE).toMatch(
      /\{ table: "assistant_settings", column: "thinking_type", type: "TEXT" \}/,
    );
  });

  it("is written by the insert, not only by the type", () => {
    expect(REPO).toMatch(/thinking_type = excluded\.thinking_type/);
    expect(REPO).toMatch(/row\.thinkingType \?\? null/);
  });

  it("survives the save schema, which strips what it does not name", () => {
    // The failure this guards is silent and total: the form accepts the value,
    // the route drops it, and the user is told their setting saved. Zod removes
    // unknown keys rather than refusing them, so a missing name here is not a
    // validation error — it is a field that cannot be set at all.
    const put = ROUTE.slice(ROUTE.indexOf("const PutSchema"), ROUTE.indexOf("const ProbeSchema"));
    expect(put).toMatch(/thinkingType: z\.string\(\)/);
  });

  it("goes on the wire nested, the way the vendors that accept it spell it", () => {
    // A bare string is a 400 rather than a near miss, so the shape matters more
    // than the name here.
    expect(CLIENT).toMatch(/thinking: \{ type: opts\.thinkingType \}/);
  });

  it("and is off the body entirely when unset", () => {
    // Bounded by the object's own closing brace. The earlier version ended the
    // window at `stream: true`, which sits near the top of the literal — so the
    // assertion passed over an empty string and would have been satisfied by a
    // body that sent nothing at all.
    const start = CLIENT.indexOf("const body");
    const body = CLIENT.slice(start, CLIENT.indexOf("};", start) + 2);
    expect(body).toMatch(/\.\.\.\(opts\.thinkingType !== undefined/);
  });
});

describe("the settings form offers it", () => {
  const PANEL = read(
    "src",
    "app",
    "(user)",
    "dashboard",
    "assistant",
    "AssistantSettingsPanel.tsx",
  );

  it("beside the level, not instead of it", () => {
    // The two answers to two questions. A form with one of them cannot express
    // the other, which is how this was missing for so long.
    expect(PANEL).toMatch(/assistant-reasoning/);
    expect(PANEL).toMatch(/assistant-thinking/);
  });

  it("offers both directions, and says the vendor may refuse one", () => {
    expect(PANEL).toMatch(/<option value="adaptive">/);
    expect(PANEL).toMatch(/<option value="disabled">/);
    expect(PANEL).toContain("thinkingModeHint");
  });
});
