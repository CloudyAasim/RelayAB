import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DICTS, LOCALE_COOKIE } from "@/lib/i18n/dict";

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
 */
function readTopLevelKeys(literal: string): Set<string> | null {
  const names = new Set<string>();
  let depth = 0;
  let token = "";
  let quote: string | null = null;
  let escaped = false;
  let spread = false;

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

  it("the server-only helper is only imported by the server components that need it", () => {
    const importers = files
      .filter((f) => /from\s+["']@\/lib\/i18n\/server["']/.test(f.source))
      .map((f) => f.rel)
      .sort();
    expect(importers).toEqual([
      "src/app/(admin)/admin/docs/page.tsx",
      "src/app/(admin)/admin/keys/page.tsx",
      "src/app/(admin)/admin/page.tsx",
      "src/app/(admin)/admin/providers/page.tsx",
      "src/app/(admin)/admin/settings/page.tsx",
      "src/app/(admin)/admin/users/page.tsx",
      "src/app/(user)/dashboard/docs/page.tsx",
      "src/app/(user)/dashboard/page.tsx",
      "src/app/(user)/dashboard/settings/page.tsx",
      // Route handlers may import the server-only helper too: they are
      // server-side by construction (they localize flash-banner messages).
      "src/app/api/admin/users/[id]/delete-form/route.ts",
      "src/app/docs/page.tsx",
      "src/app/layout.tsx",
      "src/app/license/page.tsx",
      "src/app/page.tsx",
    ]);
  });
});

describe("i18n: locale cookie", () => {
  it("is exported from the pure dict module so clients can import it", () => {
    expect(LOCALE_COOKIE).toBe("relayab_locale");
  });
});
