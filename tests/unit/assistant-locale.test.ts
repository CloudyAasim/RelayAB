/**
 * tests/unit/assistant-locale.test.ts
 *
 * The assistant speaks the reader's language.
 *
 * The mechanism was already half there: the route resolved the reader's locale
 * and put it in the tool context, because a documentation tool that answered
 * in the wrong language would be worse than none. What was missing was that
 * nothing else used it — the prompt was Chinese whatever the reader chose, and
 * so was every refusal the route and the turn produced.
 *
 * So the locale now decides:
 *
 *  - **which prompt** the model is given (there are two, one per language);
 *  - **what the assistant says in its own voice** — the summary frame, the
 *    upstream-failure notice, the stop reasons, the notes about attachments;
 *  - **what the route refuses with**, since those refusals are read on screen.
 *
 * The deployment's *own* data stays in the deployment's language — a model's
 * name, a provider's row, a documentation page — and the prompt tells the
 * model to relay those in the reader's language.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DICTS } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const ROUTE = readFileSync(
  join(ROOT, "src", "app", "api", "assistant", "chat", "route.ts"),
  "utf-8",
);
const CHAT = readFileSync(join(ROOT, "src", "lib", "assistant", "chat.ts"), "utf-8");

/** The code, without the comments. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
}

describe("the assistant's language follows the reader's", () => {
  it("the route resolves the reader's locale before it refuses anything", () => {
    // The refusals are read on screen, so the locale has to be in hand before
    // the first one — not read afterwards, when it is too late.
    const localeAt = ROUTE.indexOf("const locale = await getServerLocale()");
    expect(localeAt, "the route never resolves the locale").toBeGreaterThan(-1);
    const firstRefusal = ROUTE.indexOf("assistant.error.rateLimited");
    expect(firstRefusal, "the route never refuses in the reader's language").toBeGreaterThan(-1);
    expect(localeAt).toBeLessThan(firstRefusal);
  });

  it("and the turn is given it", () => {
    expect(ROUTE).toMatch(/runChat\(\{[\s\S]{0,2000}?locale,/);
    expect(CHAT).toMatch(/systemPrompt\(isAdmin, \{ webSearch \}, opts\.locale\)/);
  });

  it("and everything the assistant says in its own voice is in the dictionary", () => {
    // The assistant's own words — the summary frame, the upstream-failure
    // notice, the stop reasons, the attachment notes, the route's refusals —
    // were Chinese in the source, so an English reader got an English
    // interface with a Chinese assistant inside it.
    for (const [name, source] of [
      ["route.ts", ROUTE],
      ["chat.ts", CHAT],
    ] as const) {
      const offenders = codeOnly(source)
        .split("\n")
        .filter((line) => /[\u4e00-\u9fff]/.test(line));
      expect(
        offenders,
        `${name} writes Chinese into the code instead of the dictionary:\n${offenders.join("\n")}`,
      ).toEqual([]);
    }
  });

  it("and the dictionary has both languages for every one of them", () => {
    // The i18n parity guard already checks the key sets; this checks the ones
    // the assistant reads, so a missing English string is named here rather
    // than in a guard about dictionaries.
    const keys = Object.keys(DICTS["zh-CN"]).filter((key) =>
      key.startsWith("assistant.message.") || key.startsWith("assistant.error."),
    );
    expect(keys.length, "the assistant has no messages in the dictionary").toBeGreaterThan(10);
    for (const key of keys) {
      expect(DICTS.en[key], `${key} has no English`).toBeTruthy();
    }
  });
});
