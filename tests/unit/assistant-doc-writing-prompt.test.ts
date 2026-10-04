/**
 * tests/unit/assistant-doc-writing-prompt.test.ts
 *
 * The prompt used to tell the assistant that whatever it fetched was the
 * official answer and to quote it — which is right about an upstream and wrong
 * about this deployment, because RelayAB is a mapping layer. The client-facing
 * paths are ours; a request is forwarded afterwards to some upstream's endpoint,
 * on some protocol, decided by configuration. A vendor's document describes the
 * other end of that.
 *
 * So the instruction that produced confident, well-formatted, wrong
 * documentation was the instruction to copy. This pins the correction in all
 * three places it can be acted on: the shared prompt both modes see, the admin
 * prompt's "the document wins" line, and the description of the tool that
 * actually writes the pages.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PROMPTS = read("src", "lib", "assistant", "prompts.ts");
const TOOLS = read("src", "lib", "assistant", "tools.ts");

describe("the assistant is told RelayAB maps interfaces", () => {
  it("says so in the shared prompt, which both modes see", () => {
    // Placed in SHARED rather than admin-only: a user asking "why does
    // /v1/chat/completions 404" needs the same correction as an admin writing
    // the page that would have told them.
    expect(PROMPTS).toMatch(/厂商文档不是我们的文档/);
    expect(PROMPTS, "the mapping layer is not named").toMatch(/RelayAB 是一层映射/);
  });

  it("and says the order of authority runs through us, not the vendor", () => {
    // The specific failure being prevented: fetch_page returns the vendor's
    // truth, and the model treats it as the deployment's. The fix is an order,
    // not a warning — read_docs first, list_providers for the routing, and
    // fetch_page only for upstream field names and ranges.
    expect(PROMPTS).toMatch(/read_docs[\s\S]{0,40}读本系统的接入指南/);
    expect(PROMPTS).toMatch(/list_providers[\s\S]{0,20}list_media_providers/);
    expect(PROMPTS).toMatch(/以 read_docs 为准/);
  });

  it("names the hazard, so it is recognised rather than abstractly avoided", () => {
    // "Don't copy" is not actionable on its own. The reason is the thing the
    // model can check: our upstream-format setting means a call to
    // /v1/chat/completions is still forwarded to the upstream's
    // /chat/completions, and 404s there. That is in the configuration, not in
    // any vendor's documentation.
    expect(PROMPTS).toMatch(/仍然发往/);
    expect(PROMPTS).toMatch(/404/);
    expect(PROMPTS, "the consequence of copying is not stated").toMatch(
      /照抄厂商文档会写出一份和实际行为不符的文档/,
    );
  });

  it("removes the instruction that contradicted it", () => {
    // The line that made the copy the goal: "fetched content is the official
    // answer, quote it, do not restate it in your own words". It survives as
    // "it is the *upstream vendor's* official answer", and the old wording is
    // gone.
    expect(PROMPTS).not.toMatch(/抓回来的内容就是官方说法，\*\*引用它\*\*/);
    // The admin prompt's "以文档为准" stays — it is right about upstream fact —
    // but is immediately qualified.
    expect(PROMPTS).toMatch(/以文档为准[\s\S]{0,200}fetch_page 查的是上游厂商的文档/);
  });

  it("and the tool that writes the pages says the same thing", () => {
    // The description is where the instruction lands when the tool is chosen,
    // which is later than any system prompt the reader remembers quoting.
    expect(TOOLS).toMatch(/写的是本部署映射之后的接口，不是上游厂商的原生接口/);
    expect(TOOLS).toMatch(/把厂商原生接口照抄进来/);
    expect(TOOLS).toMatch(/read_docs 和 list_providers/);
  });
});
