/**
 * tests/unit/assistant-provider-config.test.ts
 *
 * The assistant can propose configuring a provider, and every one of those
 * proposals lands in front of a human before anything is written.
 *
 * The proposals added with the text protocol have three ways to go wrong, and
 * none of them is visible in a diff the admin reads casually:
 *
 *  - an invalid spec proposed as valid, so the admin approves something the
 *    endpoint will then reject — the approval becomes a dead end;
 *  - a whole-list replacement that quietly drops pages the model did not
 *    mention, which are the operator's own writing;
 *  - a per-model patch that resets a context window somebody corrected by hand.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDocPagesDiff } from "@/lib/assistant/diff";

const ROOT = process.cwd();
const TOOLS = readFileSync(join(ROOT, "src", "lib", "assistant", "tools.ts"), "utf-8");
const SCHEMA = readFileSync(join(ROOT, "src", "lib", "assistant", "schema.ts"), "utf-8");
const APPLY = readFileSync(join(ROOT, "src", "app", "api", "assistant", "actions", "[id]", "route.ts"), "utf-8");

describe("the assistant can see and set the protocol", () => {
  it("list_providers reports the current one", () => {
    // A model that cannot see what is configured will re-derive it, and get it
    // wrong in a way nobody notices.
    expect(TOOLS).toMatch(/textSpec: readTextSpec\(p\)/);
  });

  it("propose_provider_update accepts one", () => {
    expect(TOOLS).toMatch(/textSpec: \{[\s\S]*?specVersion/);
  });

  it("and validates it at proposal time, not at apply time", () => {
    // The proposal is the thing the admin reads. A spec that would be rejected
    // on apply must never get that far, or the admin approves a change and then
    // nothing happens.
    expect(TOOLS).toMatch(/const parsed = parseTextSpec\(args\.textSpec\);[\s\S]*?if \(!parsed\.ok\)/);
  });

  it("and it can be cleared, to put a provider back to forwarding as sent", () => {
    expect(TOOLS).toMatch(/if \(args\.textSpec === null\)[\s\S]*?patch\.textSpec = null;/);
  });

  it("there is a tool that says which four protocols exist and when to use each", () => {
    // A choice made from a tool description is a choice made from whichever
    // example was nearest. The presets are the answer for ninety percent of
    // vendors, so they have to be fetchable, not described.
    expect(TOOLS).toContain("list_text_protocols");
    expect(TOOLS).toMatch(/protocols: Object\.entries\(TEXT_PROTOCOL_LABELS\)/);
    expect(TOOLS).toContain("preset:");
  });
});

describe("a proposal can never write anything itself", () => {
  it("every new capability is a proposal, and the kinds are proposals too", () => {
    for (const name of [
      "propose_provider_update",
      "propose_model_config_update",
      "propose_doc_pages",
    ]) {
      expect(TOOLS, `${name} is missing`).toContain(name);
    }
    // The enum in the schema, not a string in the tools file: a kind the
    // endpoint does not know is a proposal that can never be applied.
    expect(SCHEMA).toMatch(/AssistantActionKindSchema = z\.enum\(\[[\s\S]*"doc_pages\.update"/);
    expect(APPLY).toMatch(/claimed\.kind === "doc_pages\.update"/);
  });

  it("and the apply endpoint re-validates the pages, because approval is not the same moment as proposing", () => {
    expect(APPLY).toMatch(/claimed\.kind === "doc_pages\.update"/);
    expect(APPLY).toMatch(/validatePage\(page\)/);
    expect(APPLY).toMatch(/重复了/);
  });
});

describe("the pages diff does not hide what it removes", () => {
  const before = [
    { id: "limits", title: "限流", body: "每分钟 30 次" },
    { id: "pick", title: "选型", body: "长文本用 M3" },
  ];

  it("names a page that is being deleted", () => {
    const diff = renderDocPagesDiff(before, [{ id: "limits", title: "限流", body: "每分钟 30 次" }]);
    expect(diff).toContain("- 删除 pick");
  });

  it("and says plainly that it is gone for good", () => {
    // These are the operator's own sentences. A diff that shows "新增 x" while
    // dropping four pages has lied by omission, and the admin is being asked to
    // trust it.
    const diff = renderDocPagesDiff(before, [{ id: "limits", title: "限流", body: "每分钟 30 次" }]);
    expect(diff).toMatch(/会真的删掉/);
  });

  it("says so even for a single removal", () => {
    const diff = renderDocPagesDiff(before, [before[0]]);
    expect(diff).toMatch(/会真的删掉/);
  });

  it("marks an addition, a change and a removal apart", () => {
    const diff = renderDocPagesDiff(before, [
      { id: "limits", title: "限流", body: "改成每分钟 60 次" },
      { id: "new", title: "新增", body: "x" },
    ]);
    expect(diff).toContain("~ 修改 limits");
    expect(diff).toContain("+ 新增 new");
    expect(diff).toContain("- 删除 pick");
  });

  it("reminds about the id, which is a bookmark", () => {
    expect(renderDocPagesDiff(before, before)).toMatch(/锚点/);
  });

  it("and a draft is marked as invisible rather than looking like a normal page", () => {
    const diff = renderDocPagesDiff([], [{ id: "d", title: "草稿", body: "x", hidden: true }]);
    expect(diff).toMatch(/草稿/);
  });
});

describe("the model tool edits one model and leaves the rest alone", () => {
  it("it says the parameter is a full replacement, as the mapping one does", () => {
    // Same trap, twice in a row, is enough to write it down.
    expect(TOOLS).toContain("不是增量");
  });

  it("it refuses a model the provider does not have, and lists what it does have", () => {
    expect(TOOLS).toMatch(/里没有名为[\s\S]*?现有的：/);
  });

  it("it validates numbers before proposing, not after", () => {
    expect(TOOLS).toMatch(/非负数字/);
    expect(TOOLS).toMatch(/必须是整数/);
  });
});
