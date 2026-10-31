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
    //
    // `translated` is the third answer the OpenAI badge can give — a row whose
    // OpenAI side is served by the gateway's translation has no upstream
    // dialect to name — so the label set grew with the fact it reports. It
    // grew again when Gemini became an upstream dialect: there are now two
    // translated dialects, and they are not the same one.
    // The label set grew with the fact it reports: the four client
    // interfaces, and the two ways an interface can be answered.
    for (const field of [
      "none: string;",
      "hasRule: string;",
      "parkedRules: (n: number) => string;",
      "chat: string;",
      "responses: string;",
      "anthropic: string;",
      "gemini: string;",
      "passthrough: string;",
      "routedTo: (dialect: string) => string;",
    ]) {
      expect(PAGE, field).toContain(field);
    }
    expect(PAGE).toMatch(/<InterfaceCell[\s\S]{0,400}labels=\{\{/);
  });
});

describe("the interface column says what is served, not what was typed", () => {
  it("it no longer renders the stored `kind`", () => {
    // The value a row was created as. Still a column on the table component for
    // older rows, but it is not the routing decision and it can be wrong.
    expect(PAGE).not.toMatch(/\{p\.kind\}/);
  });

  it("the column reads the route table, one badge per answered interface", () => {
    // It used to read the face flags — one dialect for three interfaces — and
    // that summary cannot say the thing that matters now: a Gemini vendor
    // whose own endpoint takes the request as it arrived is not "translated to
    // Gemini", and a badge that says so is wrong rather than merely old.
    expect(PAGE).toMatch(/routes=\{routesOf\(p\)\}/);
    expect(PAGE).toMatch(/route\.kind !== "unsupported"/);
    // Each badge says how that interface is answered.
    expect(PAGE).toMatch(/labels\.passthrough/);
    expect(PAGE).toMatch(/labels\.routedTo\(route\.dialect\)/);
    // And the four client interfaces are named.
    for (const key of ["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate"]) {
      expect(PAGE, key).toContain(key);
    }
  });

  it("and each branch stays out of the other's vocabulary", () => {
    // Simple has no per-interface rule marker — a rule is not in effect there,
    // and marking one would claim a rule that does not run. Advanced has no
    // parked-count line, because in advanced the rules are the point.
    //
    // Scoped to the cell on purpose. Splitting the whole file would put the call
    // site in one half, and the call site names every label there is — which
    // would fail this for a reason that has nothing to do with what the cell
    // renders.
    const cell = PAGE.slice(
      PAGE.indexOf("function InterfaceCell("),
      PAGE.indexOf("import { SectionPageLayout"),
    );
    const [simple, advanced] = cell.split("const ruleMark = (protocol: string) =>");
    expect(advanced.length, "there is no advanced branch to check").toBeGreaterThan(100);
    expect(simple, "simple mode marks an interface with a rule").not.toMatch(/labels\.hasRule/);
    expect(advanced, "advanced mode announces parked rules").not.toMatch(/labels\.parkedRules/);
    expect(advanced, "advanced mode lost its own list").toMatch(/ruleMark\(surface\.id\)/);
    // And the simple branch really is behind the mode, not merely written first.
    expect(simple).toMatch(/if \(!advanced\) \{/);
  });

  it("advanced mode lists the same interfaces and marks the ones with a rule", () => {
    // Both branches read the route table now — the routing is one thing and it
    // does not change with the mode. What changes is the rules: in advanced they
    // are in effect, so a rule is worth marking.
    expect(PAGE).toMatch(/ruleMark\(surface\.id\)/);
    expect(PAGE).toMatch(/served\.map\(\(\{ surface, route \}\) =>/);
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
