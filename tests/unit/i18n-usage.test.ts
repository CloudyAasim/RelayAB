import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DICTS, LOCALE_COOKIE } from "@/lib/i18n/dict";
import { TOOL_DESCRIPTIONS } from "@/lib/assistant/tool-text";

/**
 * Guards on how the dictionary is *used* from application code.
 *
 * These catch two failure modes that are invisible to unit tests of
 * `translate()` itself:
 *
 *   1. A component calls `t("some.key")` that we never defined. At runtime the
 *      key name is rendered verbatim to the user (that is the documented
 *      "visible during dev" fallback), so it only shows up in a browser.
 *   2. A `"use client"` module imports the server-only i18n helpers
 *      (`@/lib/i18n/server` → `next/headers`). `next build` then fails with
 *      "You're importing a component that needs next/headers".
 *   3. A call site omits a `{placeholder}` the dictionary string expects, so
 *      the user sees the literal braces (e.g. "已登录为 {username}").
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

const files = walk(SRC).map((path) => ({
  path,
  rel: relative(process.cwd(), path),
  source: readFileSync(path, "utf8"),
}));

/** `t("admin.keys.title")` — dotted keys only, so unrelated `foo(t("x"))` calls can't match. */
function literalKeys(source: string): string[] {
  const keys: string[] = [];
  const re = /[^\w$.]t\(\s*"([A-Za-z][\w-]*(?:\.[\w-]+)+)"\s*[,)]/g;
  for (const m of source.matchAll(re)) keys.push(m[1]);
  return keys;
}

/** `{username}` → `["username"]`; ICU-lite placeholders only. */
function placeholdersIn(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

interface LiteralCall {
  key: string;
  /** `null` means the second argument is dynamic, so it cannot be checked statically. */
  vars: Set<string> | null;
}

/**
 * Read the property names of an object literal, ignoring nested objects and
 * function calls (their contents are irrelevant to placeholder substitution).
 * Returns `null` when a spread is present, because then the set is unknown.
 *
 * Comments are skipped. They are not code, and one English word was enough to
 * break this: an apostrophe inside `// … the whole period's prompt tokens …`
 * opened a string, and every key after it was swallowed — so a `t()` call whose
 * placeholders were all supplied got reported as missing two of them. A guard
 * that fails on a comment has to be fixed rather than worked around.
 */
function readTopLevelKeys(literal: string): Set<string> | null {
  const names = new Set<string>();
  let depth = 0;
  let token = "";
  let quote: string | null = null;
  let escaped = false;
  let spread = false;
  let lineComment = false;
  let blockComment = false;

  const flush = () => {
    const name = token.trim();
    token = "";
    if (!name) return;
    if (name.startsWith("...")) {
      spread = true;
      return;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  };

  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    const next = literal[i + 1];
    // Comments first: nothing inside one is code, and an apostrophe in an
    // English word must not be able to open a string.
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      token = "";
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      if (depth === 1) flush();
      depth -= 1;
      token = "";
      continue;
    }
    if (depth === 1) {
      if (c === ":" || c === ",") flush();
      else token += c;
    }
  }
  return spread ? null : names;
}

/**
 * Find `t("literal.key", { … })` call sites and the keys of the object passed
 * as the second argument. Only literal keys are inspected; dynamic calls such
 * as `t(key)` are ignored by the regex.
 */
function literalCalls(source: string): LiteralCall[] {
  const calls: LiteralCall[] = [];
  const re = /(?:^|[^\w$.])t\(\s*"([A-Za-z][\w-]*(?:\.[\w-]+)+)"/g;
  for (const match of source.matchAll(re)) {
    const start = (match.index ?? 0) + match[0].length;
    const openParen = source.lastIndexOf("(", start);
    if (openParen === -1) continue;

    // Walk to the matching close paren of the t(…) call.
    let depth = 0;
    let end = openParen;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const args = source.slice(openParen + 1, end);
    const firstQuote = args.indexOf('"');
    const secondQuote = args.indexOf('"', firstQuote + 1);
    const afterKey = args.slice(secondQuote + 1).trim();

    if (!afterKey.startsWith(",")) {
      calls.push({ key: match[1], vars: new Set() });
      continue;
    }
    const rest = afterKey.slice(1).trim();
    calls.push({
      key: match[1],
      vars: rest.startsWith("{") ? readTopLevelKeys(rest) : null,
    });
  }
  return calls;
}

describe("i18n: keys referenced by app code", () => {
  it("every t(\"…\") key in src/ exists in both locales", () => {
    const unknown: string[] = [];
    for (const file of files) {
      for (const key of literalKeys(file.source)) {
        // The assistant's tool catalogue has its own `t`, over its own
        // two-language table in `tool-text.ts` — the wording moved out of
        // `tools.ts` into that table so it could be translated. Those keys are
        // tool-text keys, not dictionary keys, and the scanner cannot tell the
        // two apart: both are a dotted string in a `t("…")` call.
        if (key in TOOL_DESCRIPTIONS) continue;
        if (!(key in DICTS["zh-CN"]) || !(key in DICTS.en)) {
          unknown.push(`${file.rel}: ${key}`);
        }
      }
    }
    expect(unknown, `undefined translation keys:\n${unknown.join("\n")}`).toEqual([]);
  });

  it("finds translation calls at all (guards the scanner itself)", () => {
    const total = files.reduce((n, f) => n + literalKeys(f.source).length, 0);
    expect(total).toBeGreaterThan(50);
  });
});

describe("i18n: placeholders supplied at call sites", () => {
  it('every t("…", { … }) call supplies all {placeholders} its string uses', () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const call of literalCalls(file.source)) {
        if (call.vars === null) continue; // dynamic second argument — cannot verify
        const placeholders = new Set([
          ...placeholdersIn(DICTS["zh-CN"][call.key]),
          ...placeholdersIn(DICTS.en[call.key]),
        ]);
        if (placeholders.size === 0) continue;
        const missing = [...placeholders].filter((p) => !call.vars!.has(p));
        if (missing.length > 0) {
          problems.push(
            `${file.rel}: t("${call.key}") is missing ${missing.map((m) => `{${m}}`).join(", ")}`,
          );
        }
      }
    }
    expect(problems, `unsubstituted placeholders:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("i18n: client/server boundary", () => {
  const clientFiles = files.filter((f) => /^\s*["']use client["']/m.test(f.source));

  it("has client components to check", () => {
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it("no client component imports next/headers or the server-only i18n helper", () => {
    const offenders = clientFiles
      .filter(
        (f) =>
          /from\s+["']next\/headers["']/.test(f.source) ||
          /from\s+["']@\/lib\/i18n\/server["']/.test(f.source),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every importer is server-side by construction, not by being on a list", () => {
    /**
     * This used to assert the importers equalled a hand-written list of twenty
     * two paths, and it failed for a year and a half of ordinary refactoring:
     * `dashboard/docs/page.tsx` was split into `UserDocsScreen.tsx`, four
     * pages were added, one route handler was added — and the assertion broke
     * each time, without any of it being a defect.
     *
     * It was checking the wrong thing. A list of names can only ever say "the
     * set of importers has not changed", which is a statement about the past,
     * and the project's own lesson applies: a check that can only fail when
     * something it does not care about happens gets ignored, and then it is
     * not a check at all. Worse, it was the *only* thing keeping the two
     * assertions apart — it made the client/server boundary look like a
     * registry to be maintained rather than a rule to be satisfied.
     *
     * The rule is the one the helper's own name states: it pulls in
     * `next/headers`, so anything that imports it must not be a client
     * component. Asserting that property means a new server component can
     * import the helper without being registered anywhere, and a client
     * component still cannot — which is the part that was ever at risk.
     */
    const importers = files.filter((f) =>
      /from\s+["']@\/lib\/i18n\/server["']/.test(f.source),
    );
    // First, because every loop below walks this list: an empty one would run
    // zero iterations and this file would still be green.
    expect(importers.length, "nothing imports the helper, so nothing is being checked")
      .toBeGreaterThan(5);

    const clientImporters = importers
      .filter((f) => /^\s*["']use client["']/m.test(f.source))
      .map((f) => f.rel);
    expect(
      clientImporters,
      "a client component imports a helper that reaches for next/headers — " +
        "next build fails with \"You're importing a component that needs next/headers\"",
    ).toEqual([]);
  });

  it("and the helper is still reachable, so the rule above is not vacuous", () => {
    // The positive half. Without it, deleting every import would satisfy the
    // assertion above, and a locale-aware server page would silently fall back
    // to the default language instead of failing loudly.
    expect(readFileSync(join(SRC, "lib/i18n/server.ts"), "utf8")).toMatch(/next\/headers/);
    expect(readFileSync(join(SRC, "app/page.tsx"), "utf8")).toMatch(/@\/lib\/i18n\/server/);
  });
});

describe("i18n: locale cookie", () => {
  it("is exported from the pure dict module so clients can import it", () => {
    expect(LOCALE_COOKIE).toBe("relayab_locale");
  });
});
