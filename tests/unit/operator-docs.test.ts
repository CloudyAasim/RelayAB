/**
 * tests/unit/operator-docs.test.ts
 *
 * The operator's own documentation: a chapter that is theirs, not bolted on.
 *
 * Three things have to hold at once, and each of them has a way of quietly
 * failing:
 *
 *  - the chapter is **absent** from the outline until there is something in it,
 *    so a deployment with no custom pages looks exactly like one that never
 *    heard of the feature;
 *  - a page is **markdown, rendered through the same escaping path** as the
 *    built-in pages, because an admin writing prose is not an admin writing
 *    markup;
 *  - an id is **fixed once published**, because it is the anchor every shared
 *    link points at.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validatePage,
  sortDocPages,
  visibleDocPages,
  hasVisibleDocPages,
  NOTES_SECTION,
} from "@/lib/docs/custom";
import { markdownToHtml } from "@/lib/markdown";

const SECTIONS = readFileSync(join(process.cwd(), "src", "lib", "docs", "sections.ts"), "utf-8");
const NOTES = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "docs", "DocsNotes.tsx"),
  "utf-8",
);
const FRAME = readFileSync(join(process.cwd(), "src", "components", "docs", "PublicDocsFrame.tsx"), "utf-8");
const INTEGRATION = readFileSync(
  join(process.cwd(), "src", "components", "docs", "IntegrationDocs.tsx"),
  "utf-8",
);
const FORM = readFileSync(
  join(process.cwd(), "src", "app", "(admin)", "admin", "settings", "DocsSettingsForm.tsx"),
  "utf-8",
);
const API = readFileSync(join(process.cwd(), "src", "app", "api", "admin", "settings", "route.ts"), "utf-8");

describe("the chapter is in the outline, last", () => {
  it("has a slug of its own", () => {
    expect(NOTES_SECTION).toBe("notes");
    expect(SECTIONS).toContain('"notes"');
  });

  it("is the last entry, after every built-in page", () => {
    // First would read as a section of the protocol; last reads as an appendix
    // the operator added, which is what it is.
    const body = SECTIONS.slice(SECTIONS.indexOf("export function userDocSections"));
    expect(body.lastIndexOf('id: "notes"')).toBeGreaterThan(body.indexOf('id: "media"'));
  });

  it("is optional, and the outline is told so", () => {
    expect(SECTIONS).toMatch(/OPTIONAL_USER_SECTION_IDS = \["notes"\]/);
    // Rendered conditionally, and only when the caller says it has something.
    expect(SECTIONS).toMatch(/\.\.\.\(has\("notes"\) \? \[/);
  });
});

describe("a deployment with nothing written looks untouched", () => {
  it("reports no chapter", () => {
    expect(hasVisibleDocPages(undefined)).toBe(false);
    expect(hasVisibleDocPages([])).toBe(false);
    expect(hasVisibleDocPages([{ id: "x", title: "X", body: "…", hidden: true }])).toBe(false);
  });

  it("reports a chapter as soon as one page is published", () => {
    expect(hasVisibleDocPages([{ id: "x", title: "X", body: "…" }])).toBe(true);
  });

  it("the frame passes what exists rather than the reader deciding", () => {
    // The outline has to be built with the answer already in hand; a reader
    // that discovers the chapter afterwards is a reader who saw it vanish.
    expect(INTEGRATION).toMatch(/userDocSections\(t, withNotes \? \[NOTES_SECTION\] : \[\]\)/);
    expect(INTEGRATION).toMatch(/const withNotes = hasVisibleDocPages\(docPages\)/);
  });

  it("and the custom page is only rendered when it has something", () => {
    expect(INTEGRATION).toMatch(/section === NOTES_SECTION && withNotes/);
  });
});

describe("the body is prose, not markup", () => {
  it("goes through the same renderer the built-in pages use", () => {
    // The behaviour is pinned by the two tests below; what matters here is only
    // that the operator's page and the built-in ones share a path. A second
    // renderer would be a second set of escaping rules to get wrong.
    expect(NOTES).toContain("markdownToHtml");
    expect(NOTES).not.toMatch(/dangerouslySetInnerHTML=\{\{ __html: page\.body \}\}/);
  });

  it("so a script tag in an admin's page is text", () => {
    expect(markdownToHtml("<script>alert(1)</script>")).not.toContain("<script>");
  });

  it("and markdown still works, which is the point of offering it", () => {
    const html = markdownToHtml("## 限流\n\n每分钟 **30** 次。\n\n- 单账号\n- 全站");
    expect(html).toContain("<h2>");
    expect(html).toContain("<strong>30</strong>");
    expect(html).toContain("<li>");
  });
});

describe("what a page may be called", () => {
  it("a bare, routable slug", () => {
    expect(validatePage({ id: "rate-limits", title: "限流", body: "" })).toBeNull();
    expect(validatePage({ id: "a1", title: "x" })).toBeNull();
  });

  it("nothing a reader could mistake for a route", () => {
    for (const id of ["Rate Limits", "../etc", "a/b", "a_b", "-lead", "trail-", ""]) {
      expect(validatePage({ id, title: "x" }), `accepted ${JSON.stringify(id)}`).not.toBeNull();
    }
  });

  it("and a title, because a page with no title is a bare link", () => {
    expect(validatePage({ id: "ok", title: "", body: "…" })).toMatch(/title/);
  });

  it("the editor refuses to save while a page is unusable", () => {
    // Refusing the whole save, rather than dropping the broken page, so a
    // half-typed page cannot vanish on the way past.
    expect(FORM).toMatch(/if \(!pagesOk\)/);
    expect(FORM).toMatch(/pageProblems\.every/);
  });

  it("an abandoned row is not published as an unlinkable entry", () => {
    expect(FORM).toMatch(/\.filter\(\(p\) => p\.id && p\.title\)/);
  });

  it("the server refuses two pages with one id", () => {
    // Two chapters at one anchor means the second is unreachable, silently.
    expect(API).toMatch(/seen\.has\(page\.id\)/);
    expect(API).toMatch(/重复/);
  });

  it("and the server re-checks the id shape, not just the editor", () => {
    // The editor refusing is a convenience; the endpoint is the boundary. A
    // caller that is not the editor form — a script, an older tab — must be
    // stopped here too.
    expect(API).toMatch(/\.regex\(\/\^\[a-z0-9\]/);
    expect(API).toMatch(/DocPageIdSchema/);
  });
});

describe("editing it", () => {
  it("offers a body, a title, a slug, a draft flag and an order", () => {
    for (const field of ["pageBody", "pageTitle", "pageId", "pageHidden"]) {
      expect(FORM, `no ${field}`).toContain(`admin.docsSettings.${field}`);
    }
    expect(FORM).toContain("movePage");
  });

  it("locks the slug once published, because readers link to it", () => {
    expect(FORM).toMatch(/readOnly=\{!p\.hidden\}/);
  });

  it("sends the pages to the same endpoint as everything else", () => {
    expect(FORM).toMatch(/docPages: pages/);
  });
});

describe("reading order", () => {
  const pages = [
    { id: "b", title: "B", body: "", order: 1 },
    { id: "a", title: "A", body: "", order: 5 },
    { id: "c", title: "C", body: "" },
  ];

  it("follows the order the operator set, and sorts the rest by title", () => {
    // Every page saved through the form carries an order — `movePage` renumbers
    // the whole list. The fallback is for a hand-edited settings row, and
    // title is the only thing left to order by.
    expect(sortDocPages(pages).map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(sortDocPages([{ id: "z", title: "Z", body: "" }, { id: "a", title: "A", body: "" }]).map((p) => p.id)).toEqual(["a", "z"]);
  });

  it("and a draft is not in the list a reader sees", () => {
    const withDraft = [...pages, { id: "d", title: "D", body: "", hidden: true }];
    expect(visibleDocPages(withDraft).map((p) => p.id)).not.toContain("d");
  });
});
