/**
 * tests/unit/docs-spec-check-page.test.ts
 *
 * The admin docs render two files straight out of the repository: the adapter
 * protocol (`docs/模型适配协议/README.md`) and the judge
 * (`scripts/spec-check.ts`). Rendering "from the repo" is the point — the panel
 * must never show a second copy that can drift — but it only works if the file
 * actually ships, so both the section registry and the bundler config are
 * pinned here.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_SECTION_IDS, isAdminDocId, isKnownDocsPath } from "@/lib/docs/sections";

const JUDGE = join(process.cwd(), "scripts", "spec-check.ts");
const NEXT_CONFIG = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
const DICT = readFileSync(join(process.cwd(), "src", "lib", "i18n", "dict.ts"), "utf8");

describe("admin docs: judge page", () => {
  it("is registered as a section", () => {
    expect(isAdminDocId("spec-check")).toBe(true);
    expect(ADMIN_SECTION_IDS).toContain("spec-check");
  });

  it("is reachable without tripping the unknown-slug redirect in middleware", () => {
    // An unregistered slug would 307 back to the index, so the page would look
    // broken even though the component renders fine.
    expect(isKnownDocsPath("/admin/docs/spec-check")).toBe(true);
    expect(isKnownDocsPath("/admin/docs/spec-check/")).toBe(true);
  });

  it("sits next to the protocol page in the outline", () => {
    const mediaIndex = ADMIN_SECTION_IDS.indexOf("media");
    const judgeIndex = ADMIN_SECTION_IDS.indexOf("spec-check");
    expect(judgeIndex).toBeGreaterThan(mediaIndex);
    expect(judgeIndex).toBe(mediaIndex + 1);
  });

  it("ships the source file with the deployment", () => {
    // Without outputFileTracingIncludes the page renders "could not read" in
    // production while working fine locally.
    expect(NEXT_CONFIG).toContain('"./scripts/spec-check.ts"');
    expect(NEXT_CONFIG).toContain("outputFileTracingIncludes");
  });

  it("has a label in both languages", () => {
    const matches = DICT.match(/"admin\.docs\.nav\.specCheck"/g) ?? [];
    expect(matches.length).toBe(2);
    for (const key of [
      "admin.docs.nav.specCheck",
      "admin.docs.specCheck.title",
      "admin.docs.specCheck.desc",
      "admin.docs.specCheck.fixtures",
      "admin.docs.specCheck.readonly",
      "admin.docs.specCheck.copyLabel",
      "admin.docs.specCheck.unavailable",
    ]) {
      const count = DICT.match(new RegExp(`"${key.replace(/\./g, "\\.")}"`, "g")) ?? [];
      expect(count.length, `${key} must exist in zh and en`).toBe(2);
    }
  });

  it("renders the file the page claims to render", () => {
    const component = readFileSync(
      join(process.cwd(), "src", "components", "docs", "SpecCheckReference.tsx"),
      "utf8",
    );
    expect(component).toContain("scripts");
    expect(component).toContain("spec-check.ts");
    // No second copy: the component must read the repo file, not embed a string.
    expect(component).not.toContain("MAX_FETCH_MARKERS");
  });

  it("exposes the judge as a standalone command", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["spec-check"]).toContain("scripts/spec-check.ts");
  });

  it("links the offline single-file judge", () => {
    // The standalone judge is the one an operator hands to an AI that has never
    // seen the repository, so it must be reachable as a static asset and linked
    // from the docs page.
    const standalone = join(process.cwd(), "public", "spec-check.html");
    expect(existsSync(standalone)).toBe(true);

    const component = readFileSync(
      join(process.cwd(), "src", "components", "docs", "SpecCheckReference.tsx"),
      "utf8",
    );
    expect(component).toContain("/spec-check.html");
    expect(component).toContain("download");

    const page = readFileSync(
      join(process.cwd(), "src", "app", "(admin)", "admin", "docs", "AdminDocsContent.tsx"),
      "utf8",
    );
    expect(page).toContain("/spec-check.html");
  });
});
