/**
 * tests/unit/assistant-settings-choose-a-model.test.ts
 *
 * The assistant's settings choose a model *and* let you state that model's
 * parameters. Both halves are required, and the second half was once removed.
 *
 * What happened: the parameters were added, then taken out again on the
 * reasoning that the assistant runs on the caller's own upstream, so asking for
 * a context window meant inventing a parameter for a model this system does not
 * own. That reasoning was applied to a *defaulted* value when the code has never
 * defaulted one — `null` has always meant "not sent", and the window is a number
 * the person filling the form types from their own vendor's documentation.
 *
 * So the form asks, and the answer is stored and sent, and nothing is filled in
 * behind the caller's back. The parts of the removal that were right stay here:
 * a turn still needs a model, and the history is still bounded.
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
const SQLITE = read("src", "lib", "db", "sqlite.ts");

describe("the settings offer the model's parameters, and only the caller's", () => {
  it("all four are on the form, as real inputs, in a visible group", () => {
    for (const field of [
      "contextLength",
      "maxOutputTokens",
      "temperature",
      "topP",
    ]) {
      expect(PANEL, `the form still does not ask for ${field}`).toContain(field);
    }
    // Not a bare mention. A name can survive while the control around it is
    // gone — removed from the JSX, or wrapped in something hidden — and every
    // other assertion here still passes. So: each id must be attached to a
    // number input that is bound to its state, and the group must not be
    // hidden. `htmlFor` falls back to `name`, so an input with neither renders
    // a label that labels nothing; both are given.
    for (const id of [
      "assistant-context-length",
      "assistant-max-output",
      "assistant-temperature",
      "assistant-top-p",
    ]) {
      expect(PANEL, `${id} has no input`).toMatch(new RegExp(`id="${id}"`));
      expect(PANEL, `${id} is not a number input`).toMatch(
        new RegExp(`id="${id}"[\\s\\S]{0,400}?type="number"`),
      );
      expect(PANEL, `${id} is not bound to state`).toMatch(
        new RegExp(`id="${id}"[\\s\\S]{0,600}?value=\\{\\w+ === null \\? "" : String\\(\\w+\\)\\}`),
      );
    }
    expect(PANEL, "the parameter group is hidden").not.toMatch(/<fieldset[^>]*\bhidden\b/);
    expect(PANEL, "the group is not labelled").toMatch(
      /<legend[^>]*>[\s\S]{0,160}?assistant\.settings\.modelParams/,
    );
  });

  it("and the columns exist on an existing deployment, not only in a fresh schema", () => {
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

  it("nothing here is filled in for the caller", () => {
    // The whole argument for having the fields and the argument against
    // inventing values are compatible only while this holds. A default
    // temperature makes a model answer differently after a deploy; a default
    // output cap silently shortens long answers.
    for (const [name, src] of [
      ["schema", read("src", "lib", "assistant", "schema.ts")],
      ["assistant client", read("src", "lib", "assistant", "client.ts")],
    ] as const) {
      expect(src, `${name} defaults a model parameter`).not.toMatch(
        /temperature[^\n]*(\?\?|=)\s*0\.\d/,
      );
    }
    // The history still has a fallback budget rather than no budget at all.
    expect(CHAT).toMatch(/const HISTORY_BUDGET_TOKENS = \d[\d_]*;/);
  });
});

describe("what the removal got right, and kept", () => {
  it("the history is still bounded, by whole turns from the front", () => {
    // A message *count* is not a bound, and forty messages of a long
    // conversation plus an image plus a documentation page is already past a 32k
    // window. The failure was an upstream 400 on somebody's turn.
    expect(CHAT, "the history is no longer trimmed at all").toMatch(
      /toWireMessages\(fitToWindow\(history, settings\?\.contextLength\)/,
    );
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
    // let you. Adding four parameter boxes must not reopen this.
    const chat = read("src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");
    expect(chat).toMatch(/const missingModel = !modelLabel\.trim\(\);/);
    expect(chat).toMatch(/const canSend =[\s\S]{0,90}!missingModel/);
  });

  it("and the model still saves, and is still named where the answer comes from", () => {
    // The other three reports from the same sitting: the chosen model did not
    // persist, a turn went out without one, and nothing said which model was
    // answering.
    expect(PANEL).toMatch(/model: model\.trim\(\),/);
    const chat = read("src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");
    expect(chat).toContain("modelLabel");
  });
});
