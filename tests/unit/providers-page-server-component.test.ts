/**
 * tests/unit/providers-page-server-component.test.ts
 *
 * `providers/page.tsx` is a server component — it reads the session and the
 * rows — and the table's new interface cell wanted translations. Reaching for a
 * client-side hook for them type-checks, passes the whole unit suite, and fails
 * `next build` on the client/server boundary. It happened once already on the
 * models page and cost a deploy; the labels are passed in as props here, and
 * this file makes that structural.
 *
 * The other half is what the column is allowed to say. It used to render
 * `kind` — the value a row was *typed* as — which after the two modes is not
 * the routing truth: a row saved as `openai` with the OpenAI side switched off
 * served nothing while the table said "openai". A list that can state a
 * falsehood is worse than one that says less.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PAGE = readFileSync(join(ROOT, "src", "app", "(admin)", "admin", "providers", "page.tsx"), "utf-8");

describe("the providers page stays a server component", () => {
  it("no hooks, no client directive", () => {
    expect(PAGE).not.toMatch(/^\s*"use client"/m);
    expect(PAGE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Reducer|Transition|T)\(/);
    expect(PAGE).toMatch(/getCurrentUser\(\)/);
  });

  it("so the table takes its labels as props", () => {
    // The cell is defined in this file, so anything it renders with a hook is
    // a hook in a server component.
    expect(PAGE).toMatch(/function InterfaceCell\(/);
    // The parked-count label is a function, not a template: the count is only
    // knowable inside the cell, and the server's `t` is the one thing that knows
    // how to substitute `{n}`. The window spans the doc comment deliberately.
    expect(PAGE).toMatch(
      /labels: \{\s*none: string;\s*hasRule: string;\s*openaiSide: string;\s*anthropicSide: string;[\s\S]{0,320}parkedRules: \(n: number\) => string;\s*chat: string;\s*responses: string;\s*\};/,
    );
    expect(PAGE).toMatch(/<InterfaceCell[\s\S]{0,400}labels=\{\{/);
  });
});

describe("the interface column says what is served, not what was typed", () => {
  it("it no longer renders the stored `kind`", () => {
    // The value a row was created as. Still a column on the table component for
    // older rows, but it is not the routing decision and it can be wrong.
    expect(PAGE).not.toMatch(/\{p\.kind\}/);
  });

  it("simple mode names the sides, with the format on the OpenAI one", () => {
    // It used to enumerate the client endpoints and hang the format label off
    // `/v1/chat/completions`, which made one face read as two live endpoints.
    // The form calls it one side covering both — "OpenAI 侧 — /v1/chat/completions,
    // /v1/responses" — and the column now says the same thing it does.
    expect(PAGE).toMatch(/\{labels\.openaiSide\}/);
    expect(PAGE).toMatch(/\{labels\.anthropicSide\}/);
    expect(PAGE).toMatch(
      /labels\.openaiSide<\/Badge>|openaiSide[\s\S]{0,160}openai\.format === "chat"/,
    );
  });

  it("and each branch stays out of the other's vocabulary", () => {
    // The whole defect in one assertion: a single list serving both modes. Simple
    // has no per-surface rule marker and no client endpoint path; advanced has
    // no face name. Cutting on `if (!advanced)` is the only separator offered.
    //
    // Scoped to the cell on purpose. Splitting the whole file would put the call
    // site in one half, and the call site names every label there is — which
    // would fail this for a reason that has nothing to do with what the cell
    // renders.
    //
    // Cut on advanced's own helper rather than on `if (!advanced) {`: the simple
    // branch is *inside* that block, so splitting there puts simple in the
    // second half and inverts every assertion below.
    const cell = PAGE.slice(
      PAGE.indexOf("function InterfaceCell("),
      PAGE.indexOf("import { SectionPageLayout"),
    );
    const [simple, advanced] = cell.split("const ruleMark = (protocol: string) =>");
    expect(advanced.length, "there is no advanced branch to check").toBeGreaterThan(100);
    expect(simple, "simple mode mentions an endpoint path").not.toMatch(/\/v1\/responses/);
    expect(simple, "simple mode marks a surface with a rule").not.toMatch(/labels\.hasRule/);
    expect(advanced, "advanced mode names a face").not.toMatch(/labels\.openaiSide/);
    expect(advanced, "advanced mode announces parked rules").not.toMatch(/labels\.parkedRules/);
    expect(advanced, "advanced mode lost its own list").toMatch(/ruleMark\("openai-chat"\)/);
    // And the simple branch really is behind the mode, not merely written first.
    expect(simple).toMatch(/if \(!advanced\) \{/);
  });

  it("advanced mode still lists the endpoints, and the format only on the OpenAI side", () => {
    expect(PAGE).toContain("/v1/chat/completions");
    expect(PAGE).toContain("/v1/responses");
    expect(PAGE).toContain("/anthropic/v1/messages");
    expect(PAGE).toMatch(/ruleMark\("openai-chat"\)/);
    expect(PAGE).toMatch(/ruleMark\("openai-responses"\)/);
    expect(PAGE).toMatch(/ruleMark\("anthropic-messages"\)/);
  });

  it("a parked rule is one line, and only in simple mode", () => {
    // A provider whose rules were switched off and one that never had any are
    // otherwise identical, and "did I lose it" is the first question that
    // follows choosing simple — so it is worth one line. It is not worth three.
    expect(PAGE).toMatch(/const parked = advanced\s*\n\s*\? 0\s*\n\s*: SURFACES\.filter\(\(s\) => hasRule\(s\.id\)\)\.length;/);
    expect(PAGE).toMatch(/\{parked > 0 && \(/);
    expect(PAGE).toMatch(/labels\.parkedRules\(parked\)/);
    // Counted by protocol, not by array length: `textSpecs` holds raw JSON, so
    // its length counts a duplicate and an unparseable draft like a real rule.
    expect(PAGE).not.toMatch(/parked = .*textSpecs\.length/);
  });

  it("and says a provider with both sides off is unreachable", () => {
    // Two dashes would read as "nothing configured", which is a different
    // problem from "this provider answers nothing".
    expect(PAGE).toMatch(/admin\.providers\.table\.noInterface/);
    expect(PAGE).toMatch(/tone="warning"/);
  });
});
