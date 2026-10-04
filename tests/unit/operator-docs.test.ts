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
  userDocOutline,
  userDocGuides,
  PARAMETERS_SECTION,
} from "@/lib/docs/custom";
import { INTEGRATION_GUIDE } from "@/lib/docs/sections";
import { ASSISTANT_PAGE_READ_LIMIT } from "@/lib/assistant/docs-reader";
import { renderDocPagesDiff } from "@/lib/assistant/diff";
import { docPageAdvice } from "@/lib/assistant/tools";
import { markdownToHtml } from "@/lib/markdown";

const SECTIONS = readFileSync(join(process.cwd(), "src", "lib", "docs", "sections.ts"), "utf-8");
const CUSTOM = readFileSync(join(process.cwd(), "src", "lib", "docs", "custom.ts"), "utf-8");
const SHELL = readFileSync(join(process.cwd(), "src", "components", "docs", "DocsShell.tsx"), "utf-8");
const APP = readFileSync(
  join(process.cwd(), "src", "components", "docs", "UserDocsApp.tsx"),
  "utf-8",
);
const FRAME = readFileSync(
  join(process.cwd(), "src", "components", "docs", "PublicDocsFrame.tsx"),
  "utf-8",
);
const NEXT_CONFIG = readFileSync(join(process.cwd(), "next.config.mjs"), "utf-8");
const NOTES = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "docs", "DocsParameters.tsx"),
  "utf-8",
);
const INTEGRATION = readFileSync(
  join(process.cwd(), "src", "components", "docs", "IntegrationDocs.tsx"),
  "utf-8",
);
const FORM = readFileSync(
  join(process.cwd(), "src", "app", "(admin)", "admin", "settings", "DocsPagesForm.tsx"),
  "utf-8",
);
const CONTENT = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "docs", "DocsContent.tsx"),
  "utf-8",
);
const READER = readFileSync(join(process.cwd(), "src", "lib", "assistant", "docs-reader.ts"), "utf-8");
const DIFF = readFileSync(join(process.cwd(), "src", "lib", "assistant", "diff.ts"), "utf-8");
const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");
const ACTION_ROUTE = readFileSync(
  join(process.cwd(), "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
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
    { id: "limits", title: "限流", body: "…" },
    { id: "pick", title: "选型建议", body: "…" },
    { id: "loose", title: "杂记", body: "…" },
    { id: "draft", title: "草稿", body: "…", hidden: true },
  ];

  it("all of them, in one chapter, in the order they were written", () => {
    // The version that let each page name a built-in chapter scattered the
    // operator's prose through the document. Then a reader looking for the rate
    // limit had to know which chapter somebody had filed it under, and the
    // operator had to decide that on every page. One chapter, one place to look.
    expect(visibleDocPages(pages).map((p) => p.id)).toEqual(["limits", "pick", "loose"]);
  });

  it("a draft is in none of it", () => {
    expect(visibleDocPages(pages).map((p) => p.id)).not.toContain("draft");
  });

  it("and the chapter has a slug of its own, so the outline can carry it", () => {
    expect(PARAMETERS_SECTION).toBe("parameters");
  });

  it("the type has no chapter field, so the decision cannot be re-made by accident", () => {
    // Not a behaviour test: a type that no longer has the field is what stops
    // this coming back. If a page can be filed under a chapter again, the whole
    // argument above starts over.
    const TYPES = readFileSync(join(ROOT, "src", "lib", "db", "settings.ts"), "utf-8");
    const docPage = TYPES.slice(TYPES.indexOf("export interface DocPage"));
    expect(docPage.slice(0, docPage.indexOf("}"))).not.toMatch(/\bsection\??:/);
  });
});

describe("the parameters guide, and what the assistant can do with it", () => {
  it("a page longer than the assistant can read is said out loud on approval", () => {
    // Storage allows 60,000 characters and the reader cuts at 20,000, so the
    // band between them is silent: the page saves, a browser renders it whole,
    // and the assistant gets half of it with a marker at the end. The shape a
    // 327-row voice list takes, and something an admin can approve by accident.
    const long = "x".repeat(ASSISTANT_PAGE_READ_LIMIT + 1);
    const diff = renderDocPagesDiff(
      [],
      [{ id: "voices", title: "音色", body: long }],
      "test",
    );
    expect(diff).toContain("voices");
    expect(diff).toMatch(/助手读它时会被截断/);

    // …and a page that fits says nothing, because a warning on every save is
    // a warning nobody reads.
    const fits = "y".repeat(100);
    expect(renderDocPagesDiff([], [{ id: "limits", title: "限流", body: fits }], "t")).not.toContain(
      "截断",
    );
  });

  it("and the model is told, not only the admin", () => {
    // The person who can fix it is the model: it chose the page. The diff only
    // reaches whoever happens to approve, which may be later and may not be
    // the author.
    const long = "x".repeat(ASSISTANT_PAGE_READ_LIMIT + 1);
    const said = docPageAdvice([{ id: "voices", title: "音色", body: long }]);
    expect(said, "a page past the limit said nothing").toBeDefined();
    expect(said!.tooLongForAssistant).toEqual([
      { id: "voices", chars: ASSISTANT_PAGE_READ_LIMIT + 1, limit: ASSISTANT_PAGE_READ_LIMIT },
    ]);
    expect(said!.advice).toContain("拆成多页");
    // Silence when there is nothing to say: a warning on every save is a warning
    // nobody reads.
    expect(docPageAdvice([{ id: "limits", title: "限流", body: "短" }])).toBeUndefined();
    // …and the propose path actually hands it back.
    expect(TOOLS).toMatch(/\.\.\.\(advice \? \{ advice \} : \{\}\),/);
  });

  it("and the limit it warns about is the reader's, not a second copy", () => {
    // Two copies of 20 000 drift, and the drift is invisible until a page lands
    // in the gap.
    expect(READER).toMatch(/export const ASSISTANT_PAGE_READ_LIMIT = MAX_PAGE_CHARS;/);
    expect(DIFF).toMatch(/import \{ ASSISTANT_PAGE_READ_LIMIT \} from "\.\/docs-reader";/);
    expect(TOOLS).toMatch(/import \{ ASSISTANT_PAGE_READ_LIMIT \} from "\.\/docs-reader";/);
  });

  it("the AI can still read and propose them, and only an admin may", () => {
    // The whole interface, end to end: list what is there, propose a change,
    // and have the apply route re-check it — because a proposal and its
    // approval can be a day apart.
    for (const name of ["list_doc_pages", "propose_doc_pages"]) {
      expect(TOOLS, `${name} is not offered to the model`).toContain(`name: "${name}"`);
      expect(TOOLS, `${name} is not admin-gated`).toMatch(
        new RegExp(`case "${name}":\\s*\\n\\s*if \\(!isAdmin\\) return fail\\("这是管理员功能。\\"\\)`),
      );
    }
    expect(ACTION_ROUTE, "the apply route does not re-validate the pages").toMatch(
      /claimed\.kind === "doc_pages\.update"/,
    );
    expect(ACTION_ROUTE).toMatch(/validatePage\(page\)/);
    // …and it re-renders both reader surfaces, or the change is saved and
    // invisible until somebody reloads hard.
    expect(ACTION_ROUTE).toMatch(/revalidatePath\("\/docs", "layout"\)/);
    expect(ACTION_ROUTE).toMatch(/revalidatePath\("\/dashboard\/docs", "layout"\)/);
  });
});

describe("the integration guide renders what it says it renders", () => {
  it("every chapter is reached by its own name", () => {
    // `media` used to be whatever fell past the last `if`, so any chapter id
    // this component did not recognise came out as the media page — under the
    // media page's heading, with its own examples, looking entirely plausible.
    // Nothing hits that today because the two non-prose ids are routed away
    // above it, but the type that would have caught it is erased at runtime,
    // and the next chapter added without a branch would land there silently.
    for (const id of ["start", "endpoints", "openai", "anthropic", "responses", "models", "sdks", "media"]) {
      expect(CONTENT, `no branch renders the "${id}" chapter`).toMatch(
        new RegExp(`if \\(section === "${id}"\\) \\{`),
      );
    }
    // And the fallthrough says so, rather than rendering something plausible.
    expect(CONTENT).not.toMatch(/^\s*\/\/ media\s*$/m);
    expect(CONTENT).toMatch(/docs\.unknown\.title/);
  });

  it("and the two OpenAI-shaped chapters say they share a base instead of repeating one", () => {
    // They always did share it: both are served under one `/v1` and
    // authenticated the same way. Carried as two props, the reader compared two
    // identical code blocks and found a copy-paste slip. One sentence is both
    // shorter and the actual information.
    expect(CONTENT, "the duplicate base prop is back").not.toMatch(/responsesBase/);
    expect(INTEGRATION, "the duplicate base prop is back").not.toMatch(/responsesBase/);
    expect(APP, "the duplicate base prop is back").not.toMatch(/responsesBase/);
    // The Responses chapter points at the OpenAI one instead of re-printing it.
    expect(CONTENT).toMatch(/t\("docs\.responses\.sameAsOpenai"\)/);
    expect(CONTENT).not.toMatch(/label=\{t\("docs\.responses\.header"\)\}/);
    // …and the OpenAI chapter says which chapter it is shared with, so the
    // claim is findable from either side.
    expect(CONTENT).toMatch(/t\("docs\.openai\.sharesBase"\)/);
  });
});

describe("the outline", () => {
  it("is two guides, and the operator's is absent until there is something in it", () => {
    // The document was ten tabs in a row, with the chapter that explains how to
    // call this sitting next to the chapter holding a 327-row voice table. The
    // two are read for different reasons at different moments, and a reader
    // arriving for either picked from a list where nothing was relevant.
    const withPages = userDocGuides(t, pages);
    expect(withPages.map((g) => g.id)).toEqual([INTEGRATION_GUIDE, PARAMETERS_SECTION]);
    // One half of a guide, never both: a guide carrying chapters *and* pages is
    // the single long list this split exists to end.
    for (const g of withPages) {
      expect(
        g.id === INTEGRATION_GUIDE ? g.pages.length : g.chapters.length,
        `${g.id} carries both halves`,
      ).toBe(0);
    }
    // And a deployment with nothing written reads exactly as it did before
    // custom docs existed: one guide, no switch, nothing saying it is empty.
    for (const nothing of [undefined, [], [{ id: "x", title: "X", body: "…", hidden: true }]]) {
      const guides = userDocGuides(t, nothing as never);
      expect(guides.map((g) => g.id)).toEqual([INTEGRATION_GUIDE]);
    }
  });

  it("the switch is only there when there is something to switch to", () => {
    // With nothing written, there is one guide — and a switch with one option
    // on it is a control that does nothing, which reads as broken rather than
    // as absent.
    expect(APP).toMatch(/\{guides\.length > 1 && \(/);
  });

  it("and the chapter tabs do not render while the parameters guide is open", () => {
    // The whole point of the split. The long list came back the moment the
    // chapters' tabs and the parameters guide's page list shared a screen.
    expect(APP).toMatch(/\{!onParameters && \(/);
    expect(APP).toMatch(/const onParameters = guide === PARAMETERS_SECTION && parameters;/);
  });

  it("and a deep link names a guide, not a chapter inside either one", () => {
    expect(APP).toMatch(/guides\.some\(\(g\) => g\.id === initial\)/);
    // The page within the parameters guide travels in the query, because the
    // route is one segment deep and a second segment would mean a second route.
    expect(APP).toMatch(/\$\{basePath\}\/\$\{PARAMETERS_SECTION\}\?p=\$\{encodeURIComponent\(id\)\}/);
  });
  const pages = [
    { id: "limits", title: "限流", body: "…" },
    { id: "pick", title: "选型建议", body: "…" },
  ];

  it("puts every operator page in one chapter, after the built-ins", () => {
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
      "catalog",
      "parameters",
    ]);
    // One chapter, however many pages. Two pages must not become two chapters.
    expect(ids.filter((id) => id === PARAMETERS_SECTION)).toHaveLength(1);
  });

  it("the chapter disappears when the operator has written nothing", () => {
    // A permanent entry saying "there is nothing here" is what makes a custom
    // section look bolted on, and a deployment with nothing written should look
    // exactly as it did before the feature existed.
    for (const nothing of [undefined, [], [{ id: "x", title: "X", body: "…", hidden: true }]]) {
      const outline = userDocOutline(t, nothing as never);
      expect(outline.map((s) => s.id)).not.toContain(PARAMETERS_SECTION);
      expect(outline.every((s) => !s.children)).toBe(true);
    }
  });

  it("it is drawn from the document's own chapter list, not a second one", () => {
    // The outline has to be built with the answer already in hand; a reader that
    // discovers the page afterwards is a reader who saw it vanish.
    expect(CUSTOM).toMatch(/const built = userDocSections\(t\)\.filter\(\(s\) => s\.id !== PARAMETERS_SECTION\)/);
    expect(INTEGRATION).toMatch(/guides=\{userDocGuides\(t, docPages\)\}/);
  });

  it("and the built-in list is not offered its own notes chapter as well", () => {
    // `notes` is in the id list so `/docs/notes` is a real route, but appending
    // it without stripping it first put two identically-labelled tabs in the
    // outline.
    const ids = userDocOutline(t, [{ id: "x", title: "X", body: "…" }]).map((s) => s.id);
    expect(ids.filter((id) => id === PARAMETERS_SECTION)).toHaveLength(1);
  });

  it("and the pages render only in that chapter, never inside a built-in one", () => {
    // The version that let a page name its own chapter rendered the operator's
    // prose at the bottom of a built-in chapter, which is how it came to look
    // like it had vanished when the reader moved tab. One chapter, or none.
    expect(APP).toMatch(/const pages = onParameters \? parameters\.pages : \[\];/);
    // There is no branch that renders them alongside `<DocsContent>`.
    expect(APP).not.toMatch(/<DocsContent[\s\S]{0,400}<DocsParameters/);
  });
});

describe("the document is one page, not one route per chapter", () => {
  /**
   * The reported bug: chapters were separate routes, so moving between them was
   * a navigation — a server round trip, a loading boundary, and whatever the
   * router had already fetched. The data was never lost; navigating was the
   * defect.
   *
   * So the chapters are tabs over content that is already in memory. There is
   * no request to be stale, nothing to prefetch and nothing to wait for, which
   * removes the whole class rather than one instance of it.
   */
  it("the tab bar contains no links at all, so switching cannot navigate", () => {
    // A `<Link>` or an `<a href>` here would be a route change wearing a tab's
    // clothes, and the whole guarantee would be gone.
    const tablist = APP.slice(APP.indexOf('role="tablist"'), APP.indexOf('role="tabpanel"'));
    expect(tablist, "no tab bar found").not.toMatch(/<Link\b/);
    expect(tablist).not.toMatch(/<a\b/);
    expect(tablist).toMatch(/<button\b/);
  });

  it("switching updates the url without entering it in the history", () => {
    // `pushState` would put every tab in the history and make the back button
    // walk the document instead of leaving it.
    expect(APP).toMatch(/window\.history\.replaceState\(null, "", `\$\{basePath\}\/\$\{id\}`\)/);
    expect(APP).not.toMatch(/window\.history\.pushState/);
  });

  it("a deep link still opens the right chapter, and a stale one lands somewhere real", () => {
    // Against the offered tabs, not the configured ones: a deep link to the
    // catalogue on a deployment that does not publish it has to land somewhere.
    expect(APP).toMatch(
      /chapters\.some\(\(s\) => s\.id === initial\) \? initial : \(chapters\[0\]\?\.id \?\? "start"\)/,
    );
  });

  it("and the back button moves between chapters", () => {
    expect(APP).toMatch(/window\.addEventListener\("popstate"/);
  });

  it("the catalogue is a chapter, not a wall in front of the tabs", () => {
    // Fifteen models of table above the outline meant the first thing every
    // reader saw was a table they had not come for yet, and the first thing
    // they had to scroll past to reach the chapter they wanted.
    expect(APP).toMatch(/chapter === "catalog" \? \(/);
    expect(APP).toMatch(/catalogue \?\? null/);
    // Inside the tab panel, so it is not in the document at all until its own
    // tab is opened — and absent from every other chapter.
    expect(APP.indexOf('chapter === "catalog"')).toBeGreaterThan(APP.indexOf('role="tabpanel"'));
    expect(APP.indexOf('role="tablist"')).toBeLessThan(APP.indexOf('role="tabpanel"'));
  });

  it("and the tab only exists where there is a catalogue to open", () => {
    // A public deployment can switch its vendor list off, deliberately. A tab
    // that opens onto an empty panel is worse than no tab at all, and this was
    // shipped once: the chapter was in the outline unconditionally and the
    // public surface had nothing to put in it.
    expect(APP).toMatch(/integration\.chapters\.filter\(\(s\) => s\.id !== "catalog" \|\| catalogue\)/);
    expect(APP).toMatch(/chapters\.some\(\(s\) => s\.id === initial\)/);
  });

  it("and the chapter slug is still a real route, so old links are not dead", () => {
    expect(APP).toMatch(/basePath: string/);
    expect(FRAME).toMatch(/section: string/);
  });
});

describe("the outline is never stale", () => {
  /**
   * The reader's documentation no longer navigates at all — see the tabbed
   * document above. What is left here is the admin reference, which is still
   * paged, and the server side of both.
   */
  it("the paged shell's links do not prefetch, so no payload is cached ahead of a save", () => {
    const links = [...SHELL.matchAll(/<Link\b[\s\S]*?>/g)].map((m) => m[0]);
    expect(links.length, "no links found to check").toBeGreaterThan(0);
    for (const link of links) {
      expect(link, "a docs link can still be prefetched").toMatch(/prefetch=\{false\}/);
    }
  });

  it("and the paged shell's sub-entries are plain anchors", () => {
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

  it("and it pages: one page on screen, never the whole column", () => {
    // It rendered every page in the chapter as one long column, which is fine
    // for two pages and unusable for twenty-four — a 327-row voice table pushed
    // everything above it off the screen, and a reader looking for the Korean
    // voices had to scroll past the Portuguese ones to learn there were any.
    expect(NOTES).toMatch(/const page = pages\[at\];/);
    // The page list is not a nicety: a 24-page guide navigated only by
    // "previous" is a linear walk with no way to jump to a page you know.
    expect(NOTES).toMatch(/\{pages\.map\(\(p, i\) =>/);
    expect(NOTES).toMatch(/docs\.notes\.prev/);
    expect(NOTES).toMatch(/docs\.notes\.next/);
    expect(NOTES).toMatch(/docs\.notes\.pageLabel/);
    // And the whole guide is not rendered behind the one page: this is the
    // defect, so the guard is its absence.
    expect(NOTES).not.toMatch(/\{visible\.map\(\(page\) =>/);
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

  it("and a body, capped, because an unbounded one is prose nobody finishes", () => {
    expect(validatePage({ id: "ok", title: "x", body: "…".repeat(60_001) })).toMatch(/body/);
    expect(validatePage({ id: "ok", title: "x", body: "…" })).toBeNull();
  });

  it("the editor refuses to save while a page is unusable", () => {
    // Refusing the whole save, rather than dropping the broken page, so a
    // half-typed page cannot vanish on the way past.
    expect(FORM).toMatch(/if \(!pagesOk\)/);
    expect(FORM).toMatch(/pageProblems\.every/);
  });

  it("but a row nobody filled in does not block the other pages", () => {
    // `addPage` opens a blank row. Someone who adds three pages and fills in
    // one has left two blanks, and under the old rule those two made every
    // other page unsaveable — with the offending row scrolled off the top of a
    // long list and the only symptom a save button that does nothing. Which
    // reads as "my page disappeared", not as "there is a problem".
    expect(FORM).toMatch(/function isBlank\(p: DocPageInput\): boolean/);
    expect(FORM).toMatch(/if \(isBlank\(p\)\) return null;/);
  });

  it("and a new page is published unless you say otherwise", () => {
    // It used to default to draft, which meant a page could save correctly and
    // then be invisible — the same thing, from the other end. The object
    // literal, not the comment above it, which explains exactly this.
    const added = FORM.slice(
      FORM.indexOf("const addPage"),
      FORM.indexOf("const removePage"),
    );
    const literal = added.match(/\{[^{}]*id: ""[^{}]*\}/)?.[0] ?? "";
    expect(literal, "the new-page literal was not found").not.toBe("");
    expect(literal).not.toMatch(/hidden/);
  });

  it("an abandoned row is not published as an unlinkable entry", () => {
    expect(FORM).toMatch(/\.filter\(\(p\) => p\.id && p\.title\)/);
  });

  it("the server refuses two pages with one id", () => {
    // Two entries at one anchor means the second is unreachable, silently.
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

  it("and the stored shape has no chapter field, so a stale one is rejected rather than honoured", () => {
    // `.strict()` on the page schema, which is what turns a leftover `section`
    // from an older client into a 400 instead of a silently ignored key. Scoped
    // to the DocPageSchema block: the outer settings object has a `.strict()`
    // too, and a looser search would match that one and pass forever.
    const block = API.slice(API.indexOf("const DocPageSchema"));
    expect(block.slice(0, block.indexOf("const UpdateSchema"))).toMatch(/\.strict\(\)/);
  });
});

describe("editing it", () => {
  it("offers a body, a title, a slug, a draft flag and an order", () => {
    for (const field of ["pageBody", "pageTitle", "pageId", "pageHidden"]) {
      expect(FORM, `no ${field}`).toContain(`admin.docsSettings.${field}`);
    }
    expect(FORM).toContain("movePage");
  });

  it("and offers no chapter, because all the pages are one chapter", () => {
    // The dropdown was here for one round. It scattered the operator's prose
    // through the built-in chapters, and every page had to be assigned a home
    // before it would show up anywhere.
    expect(FORM).not.toContain("admin.docsSettings.pageSection");
    expect(FORM).not.toMatch(/\bsection\b/);
  });

  it("and sends no chapter with the page", () => {
    expect(FORM).not.toMatch(/\.\.\.\(f\.section/);
  });

  it("locks the slug once published, because readers link to it", () => {
    // The intent is unchanged: once a page has an anchor, renaming it would
    // break every link anybody ever shared.
    //
    // It used to be asserted as `readOnly={!p.hidden}`, reading "published" as
    // `!hidden`. That made the two flags mean opposite things — `hidden` is
    // "not shown to readers" everywhere else — and `addPage` creates a
    // published row without the flag, so every new page's slug box came up
    // read-only. The id could not be typed, `docsPagesPayload` drops rows with
    // no id, and the page saved and vanished: zero pages, no error.
    expect(FORM).toMatch(/readOnly=\{idLocked\(p\)\}/);
    expect(FORM).toMatch(/return Boolean\(p\.id\?\.trim\(\)\);/);
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
    expect(body.lastIndexOf('"docs.nav.media"')).toBeLessThan(body.lastIndexOf('"docs.guide.parameters"'));
  });
});
