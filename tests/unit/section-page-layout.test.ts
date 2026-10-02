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
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionPageLayout } from "@/components/layouts/SectionPageLayout";

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

/**
 * A page with no title used to get an empty heading and its bottom padding
 * anyway. On the assistant page that was ~40px of dead height on a screen whose
 * whole argument is how much of it the conversation gets, so the header block
 * is now conditional.
 */
describe("SectionPageLayout header row", () => {
  const render = (...children: ReactNode[]): string =>
    renderToStaticMarkup(h(SectionPageLayout, { scrollContent: false, children }));

  it("renders the row when there is a title", () => {
    const html = render(h(SectionPageLayout.Title, null, "用量"), h(SectionPageLayout.Content, null, "body"));
    expect(html).toContain("<h2");
    expect(html).toContain("用量");
  });

  it("renders nothing but the content when there is no title at all", () => {
    const html = render(h(SectionPageLayout.Content, null, "body"));
    expect(html).not.toContain("<h2");
    // The padding wrapper is the actual cost, so assert on the wrapper rather
    // than on the absence of visible text: an empty div is easy to bring back.
    expect(html).not.toContain("sm:pb-4");
  });

  it("keeps the row when only actions are supplied", () => {
    const html = render(h(SectionPageLayout.Actions, null, "refresh"), h(SectionPageLayout.Content, null, "body"));
    expect(html).toContain("sm:pb-4");
    expect(html).toContain("refresh");
  });

  it("keeps the row when only a breadcrumb is supplied", () => {
    const html = render(h(SectionPageLayout.Breadcrumb, null, "docs"), h(SectionPageLayout.Content, null, "body"));
    expect(html).toContain("sm:pb-4");
    expect(html).toContain("docs");
  });
});
