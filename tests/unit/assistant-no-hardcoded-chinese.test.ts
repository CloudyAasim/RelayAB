/**
 * tests/unit/assistant-no-hardcoded-chinese.test.ts
 *
 * The assistant's interface says its words in the dictionary.
 *
 * The interface is the one surface where a hardcoded string is a bug with a
 * *visible* shape: the English screen shows 「类型」 next to "Type" a few pixels
 * away, and a reader sees a word they cannot read in the middle of a form they
 * are filling in. Everything the interface writes — a field's label, a refusal,
 * a term in a table — belongs in the dictionary, where both languages live.
 *
 * The rule is narrow on purpose.
 *
 *  - **Ideographs are never allowed** in the assistant's components. That is
 *    prose, and prose belongs in the dictionary.
 *  - **CJK punctuation is exempt**, because one place uses it as data: the
 *    matcher for a bare URL excludes 「。」 so that a Chinese sentence's full
 *    stop does not end up inside the link. That is a character class, not
 *    something a reader reads.
 *  - **Comments are exempt**, because a comment is for the next person to read
 *    and it says why, in the language the code is written in.
 *
 * The server side is not covered, and deliberately so: the assistant's tool
 * results and its prompts are written in the deployment's language, and that
 * is a product decision rather than a missing translation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DICTS } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const ASSISTANT = join(ROOT, "src", "app", "(user)", "dashboard", "assistant");

/** The ideographs — the prose, as opposed to the punctuation. */
const IDEOGRAPHS = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * The code, without the comments.
 *
 * Block comments go first (`{/* … *\/}` in a component, `/** … *\/` above a
 * function), then the lines that are nothing but a comment. What is left is
 * what the browser runs.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
}

/** Every component in the assistant's folder. */
function components(): string[] {
  return readdirSync(ASSISTANT)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => join(ASSISTANT, name));
}

describe("the assistant's interface speaks through the dictionary", () => {
  it("no component hardcodes Chinese", () => {
    const offenders: string[] = [];
    for (const file of components()) {
      const source = codeOnly(readFileSync(file, "utf-8"));
      source.split("\n").forEach((line, index) => {
        if (IDEOGRAPHS.test(line)) {
          offenders.push(`${file.replace(ROOT, "")}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "these words are written into the interface rather than the dictionary, " +
        "so the English screen shows them in Chinese:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("and every word it does show has a dictionary key", () => {
    // The other half of the same rule: a key that exists but is never read is a
    // sentence nobody approved, and one that is read but does not exist is a
    // screen that prints the key itself.
    const sources = components()
      .map((file) => readFileSync(file, "utf-8"))
      .join("\n");
    const used = new Set<string>();
    for (const match of sources.matchAll(/t\(\s*"([A-Za-z0-9_.]+)"/g)) {
      used.add(match[1]);
    }
    const missing = [...used].filter((key) => !(key in DICTS["zh-CN"]));
    expect(missing, "these keys are used but not defined").toEqual([]);
  });
});
