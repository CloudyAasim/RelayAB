/**
 * tests/unit/routing-copy-is-current.test.ts
 *
 * The words a product teaches with.
 *
 * ## Why this exists
 *
 * A provider's routing used to be described by a handful of columns and two
 * "protocol faces". It is now a **route table**: one row per client
 * interface, three answers each. The engine changed first and the words
 * followed — and they did not all follow at once:
 *
 *  - the admin docs still told the operator to pick an "upstream format" and
 *    a face switch, which no longer decide anything;
 *  - the assistant's prompt still taught "open both faces" and "the gateway
 *    does no chat→responses conversion" — the second of which stopped being
 *    true the day the table could route a surface to a dialect;
 *  - the tool descriptions still named the retired concepts.
 *
 * None of that breaks a build, and none of it fails a test — a stale
 * explanation is not an exception. So this guard reads the prose and refuses
 * the retired vocabulary, and the false claim along with it.
 *
 * **The prose surfaces only.** The code still has `upstreamFormat` and
 * `anthropicMode` — they are the table's summary, derived on write, and the
 * assistant's tools still submit in that vocabulary. A word is only wrong
 * where a reader meets it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DICTS } from "@/lib/i18n/dict";
import { ADMIN_SYSTEM_PROMPT } from "@/lib/assistant/prompts";
import { EN_ADMIN_TIER } from "@/lib/assistant/prompts.en";
import { TOOL_DESCRIPTIONS, TOOL_REFUSALS } from "@/lib/assistant/tool-text";

const ROOT = process.cwd();

/**
 * The retired concept, in both languages.
 *
 * "协议面" was the two-face model. It is not a word the interface uses any
 * more: what an operator configures is one row per client interface.
 */
const RETIRED = ["协议面", "protocol surface", "protocol face", "protocol faces"];

/**
 * The claim that stopped being true.
 *
 * A Chat client **can** be served by a Responses vendor now: the route table
 * can route a surface to a dialect. What is still true is narrower — a row
 * written before the table keeps its Chat surface on the vendor's
 * `/chat/completions`.
 */
const FALSE_CLAIMS = [
  /没有\s*chat→responses/i,
  /no chat-to-responses/i,
  /does not do a chat→responses/i,
  /网关没有 chat→responses/,
];

function docsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...docsFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("the interface copy", () => {
  it("does not teach the retired two-face model", () => {
    const offenders: string[] = [];
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict as Record<string, string>)) {
        if (typeof value !== "string") continue;
        for (const word of RETIRED) {
          if (value.includes(word)) offenders.push(`${locale} ${key}: ${value}`);
        }
      }
    }
    expect(
      offenders,
      "these strings still teach the two protocol faces:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("does not claim chat→responses cannot be converted", () => {
    const offenders: string[] = [];
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict as Record<string, string>)) {
        if (typeof value !== "string") continue;
        for (const claim of FALSE_CLAIMS) {
          if (claim.test(value)) offenders.push(`${locale} ${key}: ${value}`);
        }
      }
    }
    expect(offenders, "these strings say a conversion that now exists does not:\n" + offenders.join("\n")).toEqual(
      [],
    );
  });
});

describe("the assistant's own words", () => {
  it("the prompt does not teach the retired model", () => {
    for (const [name, prompt] of [
      ["zh", ADMIN_SYSTEM_PROMPT],
      ["en", EN_ADMIN_TIER],
    ] as const) {
      for (const word of RETIRED) {
        expect(prompt.includes(word), `the ${name} prompt still says "${word}"`).toBe(false);
      }
    }
  });

  it("the prompt does not deny a conversion that exists", () => {
    for (const [name, prompt] of [
      ["zh", ADMIN_SYSTEM_PROMPT],
      ["en", EN_ADMIN_TIER],
    ] as const) {
      for (const claim of FALSE_CLAIMS) {
        expect(claim.test(prompt), `the ${name} prompt says: ${prompt.match(claim)?.[0]}`).toBe(false);
      }
    }
  });

  it("the tool descriptions do not teach the retired model", () => {
    const offenders: string[] = [];
    for (const [key, entry] of Object.entries({ ...TOOL_DESCRIPTIONS, ...TOOL_REFUSALS })) {
      for (const locale of ["zh-CN", "en"] as const) {
        const value = (entry as unknown as Record<string, string>)[locale];
        if (typeof value !== "string") continue;
        for (const word of RETIRED) {
          if (value.includes(word)) offenders.push(`${locale} ${key}: ${value}`);
        }
      }
    }
    expect(offenders, "these tool descriptions still say it:\n" + offenders.join("\n")).toEqual([]);
  });
});

describe("the repository documentation", () => {
  const files = docsFiles(join(ROOT, "docs")).concat([
    join(ROOT, "README.md"),
    join(ROOT, "README.en.md"),
  ]);

  it("does not teach the retired two-face model", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const word of RETIRED) {
        if (text.includes(word)) offenders.push(`${file.replace(ROOT, "")}: ${word}`);
      }
    }
    expect(offenders, "these documents still say it:\n" + offenders.join("\n")).toEqual([]);
  });

  it("does not deny a conversion that exists", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const claim of FALSE_CLAIMS) {
        const hit = text.match(claim);
        if (hit) offenders.push(`${file.replace(ROOT, "")}: ${hit[0]}`);
      }
    }
    expect(offenders, "these documents say it:\n" + offenders.join("\n")).toEqual([]);
  });
});
