/**
 * tests/unit/key-status.test.ts
 *
 * A key's status, and the fact that it is drawn once.
 *
 * Two things are pinned here, and they are different kinds of thing.
 *
 * The first is the rule. Four states, in the gateway's order. The two that are
 * easy to forget are the two that lie: a key an admin forced off, and a key
 * that ran past its end date while its switch was still on. Both used to be
 * reported as "enabled" on the user's own page — which is the opposite of what
 * the gateway does with them, since `lib/auth/apikey.ts` refuses both.
 *
 * The second is that the status is *drawn once*. It used to be a bare coloured
 * dot in the Status column and a badge in the Actions column, side by side in
 * the same row — and the two did not even agree about a key that was switched
 * off: a red dot beside a grey badge. That is a defect about arrangement
 * rather than about any one file, so the test that guards it has to look at
 * more than one file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyStatus } from "@/lib/keys/status";

const SRC = join(process.cwd(), "src");
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf-8");

describe("the state a key is in", () => {
  it("an ordinary key is enabled", () => {
    expect(keyStatus({ enabled: true })).toBe("enabled");
  });

  it("a key nobody switched on is off", () => {
    expect(keyStatus({ enabled: false })).toBe("disabled");
    // Absent is off as well: `enabled` is a stored flag, and a row without one
    // has not been turned on.
    expect(keyStatus({})).toBe("disabled");
  });

  it("an admin's override beats everything", () => {
    // Even a key that is switched on and not expired: the override is exactly
    // the thing that must not itself be overridden.
    expect(keyStatus({ enabled: true, forceDisabled: true })).toBe("forceDisabled");
    expect(
      keyStatus({
        enabled: true,
        forceDisabled: true,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe("forceDisabled");
  });

  it("a key past its end date is expired, not enabled", () => {
    // The one that used to be wrong. `enabled` is a switch somebody flipped,
    // not a fact about the clock, and the gateway refuses the key anyway.
    expect(keyStatus({ enabled: true, expiresAt: "2020-01-01T00:00:00.000Z" })).toBe("expired");
    expect(keyStatus({ enabled: true, expiresAt: "2999-01-01T00:00:00.000Z" })).toBe("enabled");
  });

  it("the end date itself decides, to the second", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const when = Date.parse(at);
    expect(keyStatus({ enabled: true, expiresAt: at }, when)).toBe("expired");
    expect(keyStatus({ enabled: true, expiresAt: at }, when - 1)).toBe("enabled");
  });

  it("a key with no end date, or one nobody can read, does not expire", () => {
    // Refusing a key over an unparseable date would be a failure with no way
    // out of it.
    expect(keyStatus({ enabled: true, expiresAt: null })).toBe("enabled");
    expect(keyStatus({ enabled: true, expiresAt: "" })).toBe("enabled");
    expect(keyStatus({ enabled: true, expiresAt: "not a date" })).toBe("enabled");
  });

  it("a key switched off is off, expired or not", () => {
    // The gateway's order: the switch is read before the clock, so the badge
    // says the same thing the API would say about the same key.
    expect(keyStatus({ enabled: false, expiresAt: "2020-01-01T00:00:00.000Z" })).toBe("disabled");
  });
});

describe("the status is drawn once", () => {
  const dashboard = read("app/(user)/dashboard/page.tsx");
  const actions = read("app/(user)/dashboard/UserKeyActions.tsx");
  const adminKeys = read("app/(admin)/admin/keys/page.tsx");
  const badge = read("components/keys/KeyStatusBadge.tsx");

  it("the Status column draws it", () => {
    expect(dashboard).toContain("<KeyStatusBadge");
    // …and not a bare dot beside it. The dot was half of the duplication, and
    // it was the half that disagreed with the other half.
    expect(dashboard).not.toContain("StatusDot");
  });

  it("the actions cell does not draw it again", () => {
    // The duplicate: the same fact in the same row, in two columns, in two
    // different colours.
    expect(actions).not.toContain("dashboard.status.enabled");
    expect(actions).not.toContain("dashboard.status.disabled");
  });

  it("and both pages ask the same question", () => {
    expect(adminKeys).toContain("<KeyStatusBadge");
    expect(badge).toContain("keyStatus");
  });

  it("the badge is not a client component", () => {
    // It reads the locale cookie. A client module importing `lib/i18n/server`
    // fails the build with "You're importing a component that needs
    // next/headers".
    expect(badge).not.toMatch(/^\s*["']use client["']/m);
  });

  it("and switching a key on the user's own page updates the column", () => {
    // The column is server-rendered now, so a toggle that never asks the
    // server again would leave the row saying "enabled" for a key that was
    // just switched off — and the "active keys" card would not move either.
    expect(actions).toMatch(/router\.refresh\(\)/);
  });
});
