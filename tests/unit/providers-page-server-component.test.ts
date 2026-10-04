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
    expect(PAGE).toMatch(
      /labels: \{ none: string; hasRule: string; rulesOff: string; chat: string; responses: string \}/,
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

  it("it lists the endpoints, and the format only on the OpenAI side", () => {
    expect(PAGE).toContain("/v1/chat/completions");
    expect(PAGE).toContain("/v1/responses");
    expect(PAGE).toContain("/anthropic/v1/messages");
  });

  it("it marks which interfaces have a rule, and only while advanced is in effect", () => {
    // Per surface, and the marker is one function because which of the two it
    // is depends on the mode: the same stored list reads as "in effect" or
    // "stored but off" and the column has to agree with the engine either way.
    expect(PAGE).toMatch(/ruleMark\("openai-chat"\)/);
    expect(PAGE).toMatch(/ruleMark\("openai-responses"\)/);
    expect(PAGE).toMatch(/ruleMark\("anthropic-messages"\)/);
    expect(PAGE).toMatch(/mode === "advanced"/);
  });

  it("and says a provider with both sides off is unreachable", () => {
    // Two dashes would read as "nothing configured", which is a different
    // problem from "this provider answers nothing".
    expect(PAGE).toMatch(/admin\.providers\.table\.noInterface/);
    expect(PAGE).toMatch(/tone="warning"/);
  });
});
