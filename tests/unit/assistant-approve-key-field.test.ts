/**
 * tests/unit/assistant-approve-key-field.test.ts
 *
 * The approve panel, for the one case where the admin has to supply something.
 *
 * This file had no coverage at all, which is why two of the mutations run
 * against it changed nothing and looked like passing tests. The rules it has to
 * hold, in order of how much they would cost to get wrong:
 *
 *  1. The key field appears for a create and only for a create. An update has
 *     no key, and a field that shows up for one is a field someone will type
 *     a secret into and then watch do nothing.
 *  2. Approve is disabled until it is filled. The server refuses without one,
 *     and a button that lets you press it anyway teaches that the refusal is
 *     noise.
 *  3. The draft is cleared the moment the decision goes out. A draft that
 *     survived an approval would be a secret sitting in a tab long after the
 *     thing it was for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PANEL = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "assistant", "PendingActions.tsx"),
  "utf-8",
);

describe("the approve panel, where the key is typed", () => {
  it("knows which actions are creates", () => {
    // A list rather than a `kind.endsWith("create")` at the call site, so the
    // panel and the server agree on the same two names.
    expect(PANEL).toMatch(/CREATE_KINDS = new Set\(\["provider\.create", "media_provider\.create"\]\)/);
  });

  it("shows the field for a create and hides it for an update", () => {
    const field = PANEL.indexOf("{CREATE_KINDS.has(a.kind) && (");
    expect(field).toBeGreaterThan(-1);
    const guard = PANEL.slice(field, field + 900);
    expect(guard).toContain('type="password"');
    expect(guard).toContain("actions.apiKeyLabel");
    expect(guard).toContain("actions.apiKeyHint");
    // A masked field: a key is not something to read over someone's shoulder.
    expect(guard).toMatch(/autoComplete="off"/);
  });

  it("will not let approve be pressed without one", () => {
    expect(PANEL).toMatch(/disabled=\{busyId === a\.id \|\| \(CREATE_KINDS\.has\(a\.kind\) && !keys\[a\.id\]\?\.trim\(\)\)\}/);
  });

  it("sends the key with the decision", () => {
    expect(PANEL).toMatch(/const apiKey = keys\[id\]\?\.trim\(\) \|\| undefined;/);
    expect(PANEL).toMatch(/\.\.\.\(apiKey \? \{ apiKey \} : \{\}\)/);
  });

  it("clears the draft before the request goes out, not after it comes back", () => {
    const read = PANEL.indexOf("const apiKey = keys[id]?.trim() || undefined;");
    const clear = PANEL.indexOf("delete next[id];", read);
    const await_ = PANEL.indexOf("await fetch(`/api/assistant/actions/${id}`", read);
    expect(read).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(read);
    // Before the network call, not after: clearing on the way back leaves the
    // secret in a field for as long as the request takes.
    expect(clear).toBeLessThan(await_);
  });

  it("puts the draft back only when a retry could work", () => {
    // A refusal the admin can fix — a 500 — should not make them retype a
    // secret. A 400 is the server saying the key itself is wrong, and
    // restoring it would only put the same wrong key back in the box.
    expect(PANEL).toMatch(/if \(apiKey && decision === "approve" && res\.status !== 400\)/);
  });

  it("keeps it out of storage", () => {
    // The whole point of the key arriving at approval: nowhere durable. The
    // words appear in the comment explaining this; what must not appear is a
    // call.
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage\./);
    expect(code).not.toMatch(/sessionStorage\./);
  });

  it("says who can see the field at all", () => {
    // The field is inside the `isAdmin` branch, so a regular user looking at
    // a pending action is never offered a place to type a secret.
    const adminBranch = PANEL.indexOf('a.status === "pending" && isAdmin');
    const field = PANEL.indexOf("{CREATE_KINDS.has(a.kind) && (");
    expect(adminBranch).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(adminBranch);
  });
});
