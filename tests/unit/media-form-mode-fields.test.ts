/**
 * tests/unit/media-form-mode-fields.test.ts
 *
 * The media provider form shows the fields the chosen mode can actually use.
 *
 * Reported 2026-11-13: two passthrough providers still showed "适配协议（JSON）".
 * In a passthrough mode there is no spec — no translation happens — so the editor
 * was inviting people to write something that is never read, and (worse) saving it
 * as if it mattered.
 *
 * Pinned here:
 *   - the spec editor is rendered only for `spec`;
 *   - a passthrough save does not send `specs`, so the stored row keeps whatever
 *     it had if the operator switches back;
 *   - only the passthrough mode shows the (optional) path allowlist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(process.cwd(), "src", "app", "(admin)", "admin", "media-providers", "MediaProviderForm.tsx"),
  "utf8",
);

describe("media provider form fields follow the mode", () => {
  it("derives whether the mode uses a spec", () => {
    expect(SOURCE).toContain('const usesSpecs = mode === "spec";');
    expect(SOURCE).toContain("usesSpecs");
  });

  it("renders the spec editor only when the mode uses it", () => {
    const specBlock = SOURCE.slice(SOURCE.indexOf("admin.mediaProviders.specs"));
    expect(specBlock.length).toBeGreaterThan(0);
    // The block that owns the textarea is wrapped in the guard.
    const before = SOURCE.slice(0, SOURCE.indexOf("admin.mediaProviders.specs"));
    expect(before.lastIndexOf("{usesSpecs && (")).toBeGreaterThan(-1);
  });

  it("does not send specs from a passthrough form", () => {
    expect(SOURCE).toContain("...(usesSpecs ? { specs: JSON.parse(specs) } : {})");
  });

  it("offers only the two modes", () => {
    expect(SOURCE).toContain("<Select");
    expect(SOURCE).toContain("MEDIA_PROVIDER_UI_MODES.map");
    // A legacy row is folded onto the mode it behaves as, so the select never
    // holds a value it cannot show.
    expect(SOURCE).toContain("canonicalMediaProviderMode(provider?.mode ?? \"spec\")");
  });

  it("shows the allowlist only for passthrough", () => {
    expect(SOURCE).toContain('{mode === "passthrough" && (');
  });
});