/**
 * tests/unit/client-bundle-safety.test.ts
 *
 * A client component must not drag the server's modules into the browser.
 *
 * It type-checks, it passes the whole unit suite — vitest runs in node, where
 * `node:crypto` and `node:fs` are perfectly ordinary — and it fails
 * `next build` with "Reading from node:crypto is not handled by plugins", because
 * a browser bundle cannot have node builtins.
 *
 * That is exactly what happened when the admin key row's action menu (a client
 * component) imported the helper that translates the assistant credential's
 * stored label: the helper sat next to the constant in the database layer, and
 * that module reaches for `node:crypto` and `node:fs`. The helper now has a
 * module of its own, and this file makes that structural rather than a thing
 * somebody has to remember.
 *
 * The rule is narrow on purpose:
 *
 *  - a **type-only** import is erased at compile time and costs nothing, so it
 *    is allowed — a client component may know what a row looks like;
 *  - the check is on the **reachable** graph, not on the first import, because
 *    the bundler follows the whole graph and so must this: the database layer
 *    reaches `node:fs` through two relative hops (`./sqlite`), and it re-exports
 *    through `export … from`, so following only the first import and only the
 *    `@/` alias would miss the whole thing;
 *  - a `"use server"` module is where the walk stops, because that is where the
 *    browser stops too: the client gets an RPC proxy for the exports, not the
 *    module, so the server-only code behind a server action never enters the
 *    browser bundle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/**
 * Node builtins a browser bundle cannot have.
 *
 * Deliberately not the full list: Next.js shims `path`, `buffer`, `events`,
 * `util`, `url` and `assert` for the browser, so importing one of those is
 * not what breaks a build. `node:`-prefixed imports are caught separately and
 * always, because the scheme is what the bundler refuses.
 */
const NODE_BUILTINS = new Set([
  "fs",
  "crypto",
  "child_process",
  "sqlite",
  "worker_threads",
  "vm",
  "zlib",
  "dgram",
  "cluster",
  "tls",
  "dns",
  "inspector",
  "async_hooks",
  "module",
  "net",
  "http",
  "https",
  "perf_hooks",
  "repl",
  "signal",
  "secrets",
]);

/** Every source file under `src`. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * The module specifiers one file names, with the type-only ones left out.
 *
 * `import type …` and `export type …` are erased at compile time, so they cost
 * nothing in the browser bundle — a client component may know what a row looks
 * like without pulling the database in with it.
 *
 * The clause between the keyword and `from` may not contain a quote or a
 * semicolon, which is what keeps `export const x = "a"` from being mistaken
 * for a re-export. The `import`/`export` keyword has to start a line, so a
 * commented-out import does not count.
 */
function moduleSpecifiers(source: string): string[] {
  // Block comments only: a line comment cannot fool the line-anchored match.
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: string[] = [];

  for (const match of cleaned.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"`]*?\sfrom\s*["']([^"']+)["']/g)) {
    if (match[1]) continue; // `import type …` / `export type …` — erased.
    out.push(match[2]);
  }
  // Side-effect imports: `import "node:fs";`
  for (const match of cleaned.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
    out.push(match[1]);
  }
  // Dynamic imports.
  for (const match of cleaned.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push(match[1]);
  }
  return out;
}

/** Resolve a specifier to a file under `src`, or null when it is not ours. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null; // a package, not ours to follow.
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The directive at the very top of a module, if any. */
function topDirective(source: string): string | null {
  const withoutComments = source.replace(/^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*\s*/, "");
  const match = withoutComments.match(/^["'](use client|use server)["']/);
  return match ? match[1] : null;
}

/** Is this specifier a node builtin the browser bundle cannot have? */
function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  const bare = specifier.split("/")[0];
  return NODE_BUILTINS.has(bare);
}

/**
 * Does this module reach a node builtin, however indirectly?
 *
 * A `"use server"` module is an RPC boundary: the browser gets a proxy for its
 * exports, not the module, so the bundler never follows its imports into the
 * browser bundle. That is what makes `import { logoutAction } from
 * "…/logout-action"` safe in a client component even though the action itself
 * writes to the database — so the walk stops there.
 */
function reachesNodeBuiltin(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = readFileSync(file, "utf-8");
  if (topDirective(source) === "use server") return false;
  for (const specifier of moduleSpecifiers(source)) {
    if (isNodeBuiltin(specifier)) return true;
    const local = resolveLocal(specifier, file);
    if (local && reachesNodeBuiltin(local, seen)) return true;
  }
  return false;
}

describe("the browser bundle stays browser-safe", () => {
  it("no client component reaches a node builtin", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf-8");
      if (topDirective(source) !== "use client") continue;
      if (reachesNodeBuiltin(file)) {
        offenders.push(file.replace(ROOT, ""));
      }
    }
    expect(
      offenders,
      "these client components pull node builtins into the browser bundle — " +
        "next build refuses it, and the unit suite cannot see it:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("and the assistant's label helper is not in the database layer", () => {
    // The rule and the marker belong together, but the browser reads them and
    // the database layer opens connections — so they get a module of their own.
    const helper = join(SRC, "lib", "assistant-key-label.ts");
    expect(existsSync(helper)).toBe(true);
    expect(reachesNodeBuiltin(helper)).toBe(false);

    // And the database layer really does reach a node builtin, so the check
    // above is looking at something real rather than passing vacuously.
    const database = join(SRC, "lib", "db", "assistant-keys.ts");
    expect(reachesNodeBuiltin(database)).toBe(true);
  });
});
