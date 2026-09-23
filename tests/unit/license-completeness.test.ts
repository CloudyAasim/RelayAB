/**
 * License page completeness invariants.
 *
 * Verifies the License page contains every section needed for a complete
 * open-source notice, and that every dependency listed in package.json
 * is also represented on the License page.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");
const PAGE = readFileSync(join(ROOT, "src/app/license/page.tsx"), "utf-8");
const PKG = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf-8"),
);

/** License-key to section-name mapping used by the page. */
const requiredSections = [
  "license.mit.title", // MIT license full text
  "license.runtime.title", // Runtime dependencies
  "license.dev.title", // Dev dependencies
  "license.assets.title", // Third-party assets
  "license.source.title", // Source code
  "license.trademark.title", // Trademark notice
  "license.privacy.title", // Data handling
  "license.compat.note", // Compatibility summary
  "license.warranty.title", // Disclaimer
];

describe("License page: section coverage", () => {
  for (const key of requiredSections) {
    it(`renders section ${key}`, () => {
      expect(PAGE).toContain(`t("${key}")`);
    });
  }
});

describe("License page: dependency coverage", () => {
  function findDeps(name: string): string[] {
    const re = new RegExp(`const ${name}[\\s\\S]+?\\];`, "m");
    const match = PAGE.match(re);
    if (!match) return [];
    const block = match[0];
    return Array.from(block.matchAll(/name:\s*"([^"]+)"/g)).map((m) => m[1]);
  }

  it("every package.json dependency is listed as a runtime dep", () => {
    const listed = new Set(findDeps("RUNTIME_DEPS"));
    for (const dep of Object.keys(PKG.dependencies)) {
      expect(listed.has(dep), `runtime dep ${dep} should be listed`).toBe(true);
    }
  });

  it("every package.json devDependency is listed as a dev dep", () => {
    const listed = new Set(findDeps("DEV_DEPS"));
    for (const dep of Object.keys(PKG.devDependencies)) {
      expect(listed.has(dep), `dev dep ${dep} should be listed`).toBe(true);
    }
  });

  it("every dependency entry has version and license", () => {
    // Matches both RUNTIME_DEPS and DEV_DEPS entries.
    const entries = PAGE.match(/name:\s*"[^"]+"/g) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(
      Object.keys(PKG.dependencies).length +
        Object.keys(PKG.devDependencies).length,
    );

    // Spot-check: every entry must be followed by version and license
    // within the same record (the literal "name:" / "version:" / "license:" pattern).
    for (const nameMatch of entries) {
      // Find the enclosing object literal.
      const idx = PAGE.indexOf(nameMatch);
      const chunk = PAGE.slice(idx, idx + 400);
      expect(chunk, `entry ${nameMatch} missing version`).toMatch(/version:/);
      expect(chunk, `entry ${nameMatch} missing license`).toMatch(/license:/);
    }
  });
});

describe("License page: MIT text", () => {
  it("contains all required MIT clauses", () => {
    expect(PAGE).toContain("Permission is hereby granted");
    expect(PAGE).toContain("THE SOFTWARE IS PROVIDED");
    expect(PAGE).toContain("AUTHORS OR COPYRIGHT HOLDERS BE LIABLE");
  });

  it("uses dynamic year, not a hardcoded one", () => {
    expect(PAGE).toContain("new Date().getFullYear()");
    expect(PAGE).not.toMatch(/Copyright \(c\) 20[12]\d/);
  });

  it("names CloudyAasim as copyright holder", () => {
    expect(PAGE).toContain("CloudyAasim");
  });
});

describe("License page: versions match what actually ships", () => {
  interface Entry {
    name: string;
    version: string;
  }

  function entries(name: string): Entry[] {
    const re = new RegExp(`const ${name}[\\s\\S]+?\\];`, "m");
    const match = PAGE.match(re);
    if (!match) return [];
    return Array.from(
      match[0].matchAll(/name:\s*"([^"]+)",\s*version:\s*"([^"]+)"/g),
    ).map((m) => ({ name: m[1], version: m[2] }));
  }

  /** Resolved version of an installed package, or undefined if not installed. */
  function installedVersion(dep: string): string | undefined {
    const manifest = join(ROOT, "node_modules", dep, "package.json");
    if (!existsSync(manifest)) return undefined;
    return JSON.parse(readFileSync(manifest, "utf-8")).version as string;
  }

  const all = [...entries("RUNTIME_DEPS"), ...entries("DEV_DEPS")];

  it("found version for every listed dependency", () => {
    expect(all.length).toBeGreaterThanOrEqual(
      Object.keys(PKG.dependencies).length +
        Object.keys(PKG.devDependencies).length,
    );
    for (const entry of all) {
      expect(entry.version, `${entry.name} needs a version`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("lists the installed version, not a stale one", () => {
    const drift = all
      .map((entry) => ({
        name: entry.name,
        listed: entry.version,
        installed: installedVersion(entry.name),
      }))
      .filter((row) => row.installed !== undefined && row.installed !== row.listed);

    expect(
      drift,
      `License page versions drifted from node_modules:\n${drift
        .map((d) => `  ${d.name}: page=${d.listed} installed=${d.installed}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
