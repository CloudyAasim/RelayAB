/**
 * tests/unit/section-page-layout.test.ts
 *
 * `SectionPageLayout` renders four slots and **silently discards every other
 * child**. A page that forgets `<SectionPageLayout.Content>` therefore renders
 * its title and nothing else — no error, no empty-state, no build failure, and
 * an HTTP 200 that looks perfectly healthy to a smoke test.
 *
 * That is exactly what happened to /dashboard/models and /dashboard/assistant:
 * both shipped showing only a heading, and it was found by a person looking at
 * the screen, not by any test. This one fails the build instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) pageFiles(full, out);
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

const pages = pageFiles(join(process.cwd(), "src", "app"));
const usingLayout = pages.filter((p) => readFileSync(p, "utf8").includes("<SectionPageLayout>"));

describe("SectionPageLayout usage", () => {
  it("finds the pages that use it", () => {
    // Without this the assertions below would pass vacuously.
    expect(usingLayout.length).toBeGreaterThan(10);
  });

  it("every page fills the Content slot", () => {
    const offenders = usingLayout
      .filter((p) => !readFileSync(p, "utf8").includes("SectionPageLayout.Content"))
      .map((p) => p.replace(process.cwd() + "\\", ""));

    expect(
      offenders,
      `These pages render only their title because their body is not wrapped in ` +
        `<SectionPageLayout.Content>:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
