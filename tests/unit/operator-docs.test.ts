/**
 * tests/unit/operator-docs.test.ts
 *
 * The operator's own documentation, filed *inside* the document.
 *
 * Four things have to hold at once, and each has a way of quietly failing:
 *
 *  - a page belongs to a **chapter**, and appears at the end of it, because an
 *    appendix nobody finds is the same as not writing it;
 *  - the fallback chapter is **absent** until something lands in it, so a
 *    deployment with no custom pages looks exactly like one that never heard of
 *    the feature;
 *  - the body is **markdown through the same escaping path** as the built-in
 *    pages, because an admin writing prose is not an admin writing markup;
 *  - the outline must never be **served from a cache that predates the save**,
 *    because a page that appears on one visit and is gone on the next is worse
 *    than a page that never appeared.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  validatePage,
  sortDocPages,
  visibleDocPages,
  hasVisibleDocPages,
  pageSection,
  pagesBySection,
  pagesForSection,
  sectionsWithPages,
  userDocOutline,
  NOTES_SECTION,
} from "@/lib/docs/custom";
import { markdownToHtml } from "@/lib/markdown";

const SECTIONS = readFileSync(join(process.cwd(), "src", "lib", "docs", "sections.ts"), "utf-8");
const CUSTOM = readFileSync(join(process.cwd(), "src", "lib", "docs", "custom.ts"), "utf-8");
const SHELL = readFileSync(join(process.cwd(), "src", "components", "docs", "DocsShell.tsx"), "utf-8");
const NEXT_CONFIG = readFileSync(join(process.cwd(), "next.config.mjs"), "utf-8");
const NOTES = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "docs", "DocsNotes.tsx"),
  "utf-8",
);
const INTEGRATION = readFileSync(
  join(process.cwd(), "src", "components", "docs", "IntegrationDocs.tsx"),
  "utf-8",
);
const FORM = readFileSync(
  join(process.cwd(), "src", "app", "(admin)", "admin", "settings", "DocsSettingsForm.tsx"),
  "utf-8",
);
const API = readFileSync(join(process.cwd(), "src", "app", "api", "admin", "settings", "route.ts"), "utf-8");

/** The outline only ever needs to know labels, not real translations. */
const t = (key: string) => key;

const ROOT = process.cwd();

/** Every source file under `dir`, as repo-relative posix paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out;
}

describe("where a page goes", () => {
  const pages = [
    { id: "limits", title: "限流", body: "…", section: "endpoints" },
    { id: "pick", title: "选型建议", body: "…", section: "models" },
    { id: "loose", title: "杂记", body: "…" },
    { id: "draft", title: "草稿", body: "…", section: "openai", hidden: true },
  ];

  it("is the chapter the operator filed it under", () => {
    expect(pageSection(pages[0])).toBe("endpoints");
  });

  it("and a page filed under nothing falls back to the last chapter", () => {
    expect(pageSection(pages[2])).toBe(NOTES_SECTION);
    expect(NOTES_SECTION).toBe("notes");
  });

  it("a chapter that does not exist falls back too, rather than rendering nowhere", () => {
    // A chapter can be renamed out from under a stored page. Rendering it in the
    // fallback is wrong; not rendering it at all, while the operator believes it
    // is published, is worse.
    expect(pageSection({ id: "x", title: "X", body: "", section: "gone" })).toBe(NOTES_SECTION);
  });

  it("drafts are not in any chapter's list", () => {
    expect(pagesForSection(pages, "openai")).toEqual([]);
  });

  it("pages group under the chapter they were filed under", () => {
    const grouped = pagesBySection(pages);
    expect(grouped.get("endpoints")?.map((p) => p.id)).toEqual(["limits"]);
    expect(grouped.get("models")?.map((p) => p.id)).toEqual(["pick"]);
    expect(grouped.get(NOTES_SECTION)?.map((p) => p.id)).toEqual(["loose"]);
    expect(grouped.has("openai")).toBe(false);
  });

  it("and only chapters with something in them are reported", () => {
    expect(sectionsWithPages(pages).sort()).toEqual(["endpoints", "models", "notes"].sort());
  });

  it("a deployment with nothing written has no chapter at all", () => {
    expect(pagesBySection(undefined).size).toBe(0);
    expect(pagesBySection([{ id: "x", title: "X", body: "…", hidden: true }]).size).toBe(0);
    expect(sectionsWithPages([{ id: "x", title: "X", body: "…" }])).toEqual([NOTES_SECTION]);
  });
});

describe("the outline", () => {
  const pages = [
    { id: "limits", title: "限流", body: "…", section: "endpoints" },
    { id: "loose", title: "杂记", body: "…" },
  ];

  it("carries a page as an indented child of its chapter, not a chapter of its own", () => {
    const outline = userDocOutline(t, pages);
    const endpoints = outline.find((s) => s.id === "endpoints");
    expect(endpoints?.children?.map((c) => c.id)).toEqual(["limits"]);
    // The thing being fixed: a note about rate limits is not its own chapter.
    expect(outline.filter((s) => s.id === "limits")).toEqual([]);
  });

  it("the chapter it is filed under keeps its position among the built-ins", () => {
    const ids = userDocOutline(t, pages).map((s) => s.id);
    expect(ids).toEqual([
      "start",
      "endpoints",
      "openai",
      "anthropic",
      "responses",
      "models",
      "sdks",
      "media",
      "notes",
    ]);
  });

  it("the fallback chapter disappears when nothing is filed in it", () => {
    const onlyFiled = userDocOutline(t, [{ id: "limits", title: "限流", body: "…", section: "endpoints" }]);
    expect(onlyFiled.map((s) => s.id)).not.toContain(NOTES_SECTION);
    expect(onlyFiled.find((s) => s.id === "endpoints")?.children).toHaveLength(1);
  });

  it("and a deployment with nothing written is exactly the built-in outline", () => {
    for (const nothing of [undefined, [], [{ id: "x", title: "X", body: "…", hidden: true }]]) {
      const outline = userDocOutline(t, nothing as never);
      expect(outline.every((s) => !s.children)).toBe(true);
      expect(outline.map((s) => s.id)).not.toContain(NOTES_SECTION);
    }
  });

  it("it is drawn from the document's own chapter list, not a second one", () => {
    // The outline has to be built with the answer already in hand; a reader that
    // discovers the page afterwards is a reader who saw it vanish.
    expect(CUSTOM).toMatch(/for \(const section of userDocSections\(t\)\)/);
    expect(INTEGRATION).toMatch(/sections=\{userDocOutline\(t, docPages\)\}/);
  });

  it("and the page renders at the end of its own chapter", () => {
    expect(INTEGRATION).toMatch(/const here = pagesForSection\(docPages, section\)/);
    expect(INTEGRATION).toMatch(/\{here\.length > 0 && <DocsNotes pages=\{here\} \/>\}/);
  });
});

describe("the outline is never stale", () => {
  /**
   * The bug this pins: a page saved in the admin form vanished when the reader
   * moved between documentation pages. The outline is rendered from the
   * settings table, and `next.config.mjs` keeps a 30-second Client Router Cache
   * for the app — so a payload fetched *before* the save was served after it,
   * and the page the operator had just published was gone.
   */
  it("the docs links do not prefetch, so no payload is cached ahead of a save", () => {
    const links = [...SHELL.matchAll(/<Link\b[\s\S]*?>/g)].map((m) => m[0]);
    expect(links.length, "no docs links found to check").toBeGreaterThan(0);
    for (const link of links) {
      expect(link, "a docs link can still be prefetched").toMatch(/prefetch=\{false\}/);
    }
  });

  it("and the sub-entries are plain anchors, which the browser cannot cache stale", () => {
    // They point into the page you are already on, so there is no navigation to
    // serve from a cache at all.
    expect(SHELL).toMatch(/<a\s+href=\{`\$\{hrefOf\(section\.id\)\}#\$\{child\.id\}`\}/);
  });

  it("the save invalidates the docs trees on the server as well", () => {
    // The other half: prefetch off stops the client from holding a stale
    // payload; this stops anything else from doing the same.
    expect(API).toMatch(/revalidatePath/);
    for (const path of ["/docs", "/dashboard/docs", "/admin/docs"]) {
      expect(API, `${path} is not invalidated`).toContain(`"${path}"`);
    }
  });

  it("and the cache window the bug came from is still there, deliberately", () => {
    // If this is ever set to 0 the two guards above stop being load-bearing and
    // should be revisited; the assertion is here so the change is a decision.
    expect(NEXT_CONFIG).toMatch(/dynamic: 30/);
  });
});

describe("the body is prose, not markup", () => {
  it("goes through the same renderer the built-in pages use", () => {
    // The behaviour is pinned by the two tests below; what matters here is only
    // that the operator's page and the built-in ones share a path. A second
    // renderer would be a second set of escaping rules to get wrong.
    expect(NOTES).toContain("markdownToHtml");
    expect(NOTES).not.toMatch(/__html: page\.body/);
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

  it("filed under a chapter it is set off by a rule, not boxed like another document", () => {
    // A box announces "a different document starts here", which is the opposite
    // of what filing it under this chapter is for.
    expect(NOTES).toMatch(/border-l-2/);
  });
});

describe("what a page may be called, and where it may go", () => {
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

  it("a chapter that exists, or none at all", () => {
    expect(validatePage({ id: "ok", title: "x", section: "endpoints" })).toBeNull();
    expect(validatePage({ id: "ok", title: "x", section: NOTES_SECTION })).toBeNull();
    expect(validatePage({ id: "ok", title: "x", section: "nope" })).toMatch(/chapter/);
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
    // Two entries at one anchor means the second is unreachable, silently.
    expect(API).toMatch(/seen\.has\(page\.id\)/);
    expect(API).toMatch(/重复/);
  });

  it("and the server re-checks the id shape and the chapter, not just the editor", () => {
    // The editor refusing is a convenience; the endpoint is the boundary. A
    // caller that is not the editor form — a script, an older tab — must be
    // stopped here too.
    expect(API).toMatch(/\.regex\(\/\^\[a-z0-9\]/);
    expect(API).toMatch(/DocPageIdSchema/);
    expect(API).toMatch(/refine\(isUserDocId/);
  });
});

describe("editing it", () => {
  it("offers a body, a title, a slug, a chapter, a draft flag and an order", () => {
    for (const field of ["pageBody", "pageTitle", "pageId", "pageSection", "pageHidden"]) {
      expect(FORM, `no ${field}`).toContain(`admin.docsSettings.${field}`);
    }
    expect(FORM).toContain("movePage");
  });

  it("the chapter choices come from the document's own outline", () => {
    // A second hand-written list would drift from the docs the first time a
    // chapter is renamed, and would offer a page that renders nowhere.
    expect(FORM).toMatch(/userDocSections\(t\)\.filter\(\(s\) => s\.id !== NOTES_SECTION\)/);
  });

  it("and the chosen chapter is sent with the page", () => {
    expect(FORM).toMatch(/\.\.\.\(f\.section \? \{ section: f\.section \} : \{\}\)/);
  });

  it("locks the slug once published, because readers link to it", () => {
    expect(FORM).toMatch(/readOnly=\{!p\.hidden\}/);
  });

  it("sends the pages to the same endpoint as everything else", () => {
    expect(FORM).toMatch(/docPages: pages/);
  });
});

describe("a client hook needs a client component", () => {
  /**
   * Found the hard way: `DocsNotes` lost its `"use client"` while gaining a
   * `useT()` call, and every documentation chapter that had an operator page
   * answered 500. Nothing fails at build time, nothing fails in review, and the
   * page still *looks* fine in any test that reads the html — the outline's own
   * json is in the flight payload, so a string search finds the page's title
   * whether or not the page rendered.
   */
  it("every file that calls useT declares \"use client\"", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const src = readFileSync(join(ROOT, file), "utf-8");
      if (!/\buseT\b/.test(src)) continue;
      if (!/^\s*["']use client["']/m.test(src)) offenders.push(file);
    }
    expect(offenders, "a server component calling a client hook throws at render time").toEqual([]);
  });

  it("and DocsNotes specifically renders on a server, as its siblings do", () => {
    expect(NOTES).toMatch(/^\s*["']use client["']/m);
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
    expect(hasVisibleDocPages(withDraft)).toBe(true);
    expect(hasVisibleDocPages([{ id: "d", title: "D", body: "", hidden: true }])).toBe(false);
  });

  it("the fallback chapter is last, after every built-in", () => {
    // The behaviour is pinned by the outline test above; this pins the source of
    // that order, so a chapter added to the array cannot land in the wrong place
    // without turning something red.
    const body = SECTIONS.slice(SECTIONS.indexOf("const USER_LABEL_KEYS"));
    // Quoted, because `admin.docs.nav.media` contains `docs.nav.media`.
    expect(body.lastIndexOf('"docs.nav.media"')).toBeGreaterThan(-1);
    expect(body.lastIndexOf('"docs.nav.media"')).toBeLessThan(body.lastIndexOf('"docs.nav.notes"'));
  });
});
