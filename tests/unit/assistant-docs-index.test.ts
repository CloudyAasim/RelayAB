/**
 * tests/unit/assistant-docs-index.test.ts
 *
 * The generated documentation index, and the guard that keeps it true.
 *
 * The docs pages are React components whose prose is i18n text. Neither the
 * components nor `docs/` is shipped inside the runtime image, so the
 * section → key grouping is extracted at build time into
 * `docs-index.generated.ts`. The failure mode of a generated file is that it
 * goes stale and nobody notices: a doc page gains a paragraph, the assistant
 * keeps answering from the old text, and nothing anywhere turns red.
 *
 * So the first test here re-runs the generator and compares. If the two
 * components move, the build fails.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_DOC_SECTIONS } from "@/lib/assistant/docs-index.generated";
import { createDocReader } from "@/lib/assistant/docs-reader";

/** The reader over a deployment with no operator pages. */
const reader = () => createDocReader(undefined);

// In the repository, not in a scratch directory: this test has to run on CI
// too, and a generator that only exists on the machine that wrote the file is
// a guard that is not there when it is needed.
const GENERATOR = join(process.cwd(), "scripts", "gen-docs-index.cjs");
const GENERATED = join(process.cwd(), "src", "lib", "assistant", "docs-index.generated.ts");
const SECTIONS = readFileSync(join(process.cwd(), "src", "lib", "docs", "sections.ts"), "utf-8");

describe("the index is not stale", () => {
  it("matches what the generator produces from the components right now", () => {
    // Before, not after: the generator overwrites the file, so reading it
    // afterwards compares the new text with itself and proves nothing.
    const committed = readFileSync(GENERATED, "utf-8");
    execFileSync("node", [GENERATOR], { stdio: "pipe" });
    expect(
      readFileSync(GENERATED, "utf-8"),
      "docs-index.generated.ts is out of date — re-run scripts/gen-docs-index.cjs",
    ).toBe(committed);
  });

  it("and the generator is in the repository, not a scratch directory", () => {
    // A guard that only exists on the machine that wrote the file is not a
    // guard: it is absent on CI, which is where the drift is caught.
    expect(existsSync(GENERATOR), `${GENERATOR} is missing`).toBe(true);
  });

  it("every section id in the outline is in the index", () => {
    const idsOf = (name: string) =>
      [...((SECTIONS.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`)) ?? [])[1] ?? "").matchAll(
        /"([a-z0-9-]+)"/g,
      )].map((m) => m[1]);

    for (const id of idsOf("USER_SECTION_IDS")) {
      expect(WEB_DOC_SECTIONS.some((s) => s.surface === "user" && s.id === id), id).toBe(true);
    }
    for (const id of idsOf("ADMIN_SECTION_IDS")) {
      expect(WEB_DOC_SECTIONS.some((s) => s.surface === "admin" && s.id === id), id).toBe(true);
    }
  });
});

describe("the index is usable", () => {
  it("covers every section, and no section is silently empty", () => {
    // An empty page reads as "the documentation says nothing", which is a lie
    // the model would repeat.
    for (const s of WEB_DOC_SECTIONS) {
      const empty = s.keys.length === 0 && !s.note;
      expect(empty, `${s.surface}:${s.id} has neither keys nor a note`).toBe(false);
    }
  });

  it("gives every page a summary, because that is what the model chooses on", () => {
    for (const s of WEB_DOC_SECTIONS) {
      expect(s.summary.length, `${s.surface}:${s.id}`).toBeGreaterThan(4);
    }
  });

  it("names the admin `ops` page for what it is", () => {
    const ops = WEB_DOC_SECTIONS.find((s) => s.surface === "admin" && s.id === "ops");
    expect(ops?.note, "the ops page renders reference files, not prose").toBeTruthy();
  });

  it("lists both surfaces", () => {
    const topics = reader().index.map((e) => e.topic);
    expect(topics).toContain("user:openai");
    expect(topics).toContain("admin:providers");
  });
});

describe("the operator's own chapter, which is written at runtime", () => {
  const pages = [
    { id: "rate-limits", title: "限流", body: "每分钟 30 次。", order: 0 },
    { id: "draft", title: "草稿", body: "还没写完。", hidden: true },
  ];
  const custom = createDocReader(pages);

  it("appears in the index only when there is something to read", () => {
    expect(custom.index.some((e) => e.topic === "user:notes")).toBe(true);
    expect(reader().index.some((e) => e.topic === "user:notes")).toBe(false);
  });

  it("lists each published page, and not the drafts", () => {
    const topics = custom.index.map((e) => e.topic);
    expect(topics).toContain("user:notes#rate-limits");
    expect(topics.some((t) => t.includes("draft"))).toBe(false);
  });

  it("reads a page by its slug", () => {
    const result = custom.read("user:notes#rate-limits", "zh-CN", "user");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("每分钟 30 次。");
  });

  it("a draft is not readable through a link either", () => {
    const result = custom.read("user:notes#draft", "zh-CN", "user");
    expect(result.ok).toBe(false);
  });

  it("a deployment with only drafts has no chapter at all", () => {
    const allDrafts = createDocReader([{ id: "x", title: "X", body: "…", hidden: true }]);
    expect(allDrafts.index.some((e) => e.topic === "user:notes")).toBe(false);
  });
});

describe("reading a page", () => {
  it("returns real prose, in the reader's language", () => {
    const zh = reader().read("openai", "zh-CN", "user");
    expect(zh.ok).toBe(true);
    if (!zh.ok) return;
    expect(zh.text.length).toBeGreaterThan(40);
    expect(/[一-鿿]/.test(zh.text), "Chinese reader got English").toBe(true);

    const en = reader().read("openai", "en", "user");
    expect(en.ok).toBe(true);
    if (!en.ok) return;
    expect(en.text).not.toBe(zh.text);
  });

  it("works with a bare id and with a surface-qualified one", () => {
    // `media` is the one page id that exists on both surfaces, so it is the one
    // that can legitimately be reached either way.
    const r = reader();
    const bare = r.read("media", "zh-CN", "user");
    const qualified = r.read("admin:media", "zh-CN", "admin");
    expect(bare.ok && qualified.ok).toBe(true);
    if (bare.ok && qualified.ok) {
      // Same id, different pages — the surface is not decoration.
      expect(bare.text).not.toBe(qualified.text);
    }
  });

  it("says a page has no readable text rather than returning silence", () => {
    const ops = reader().read("admin:ops", "zh-CN", "admin");
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;
    // The note, not an empty body the model would read as "nothing to say".
    expect(ops.text.length).toBeGreaterThan(20);
  });

  it("lists what there is when asked for a page that does not exist", () => {
    const result = reader().read("nope", "zh-CN", "user");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/user:openai|可用|没有这一页/);
    expect(result.available?.length).toBeGreaterThan(0);
  });

  it("lists the pages too, when asked with no topic at all", () => {
    const result = reader().read("", "zh-CN", "user");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.available?.length).toBeGreaterThan(3);
  });

  it("tells a regular user the admin docs are not theirs", () => {
    // The surface check is the tool's job, but the reader must be able to say
    // why, so the distinction has to survive into the message.
    const result = reader().read("providers", "zh-CN", "user");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/管理员/);
  });

  it("shows a missing translation rather than a blank line", () => {
    const zh = reader().read("openai", "zh-CN", "user");
    expect(zh.ok).toBe(true);
    if (!zh.ok) return;
    // A key that resolves to itself is the fallback identity; seeing it in the
    // output is how a broken dictionary entry becomes visible.
    expect(zh.text).not.toContain("[missing: ");
  });
});
