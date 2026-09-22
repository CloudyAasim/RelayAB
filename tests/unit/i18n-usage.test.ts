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
