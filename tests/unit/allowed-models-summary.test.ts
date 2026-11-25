/**
 * tests/unit/allowed-models-summary.test.ts
 *
 * An account's allowed models, wherever they are shown.
 *
 * It used to print every model name, comma-joined — so an account with a
 * generous whitelist was three lines taller than its neighbours in the users
 * table, and pushed its own key list below the fold on the dashboard. The
 * summary now shows how many models the account has, and the names live in a
 * menu behind it, grouped by kind: the grouping the picker already uses, so the
 * two never disagree about what a model is.
 *
 * Both surfaces render the same component, so both are checked. Reading only
 * one of them would miss the regression that re-inlines the list in the other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

const SUMMARY = read("src", "components", "models", "AllowedModelsSummary.tsx");
const ADMIN_PAGE = read("src", "app", "(admin)", "admin", "users", "page.tsx");
const ADMIN_EDITOR = read("src", "app", "(admin)", "admin", "users", "UserConfig.tsx");
const DASHBOARD_PAGE = read("src", "app", "(user)", "dashboard", "page.tsx");
const ALLOCATION = read("src", "app", "(user)", "dashboard", "AllocationSummary.tsx");

describe("the allowed-models summary", () => {
  it("does not print every model name inline", () => {
    // This is what made one row three lines taller than its neighbours: a
    // dozen model names, comma-joined, in a single cell.
    expect(ADMIN_PAGE).not.toContain('allowedModels.join(", ")');
    expect(ALLOCATION).not.toContain('allowedModels.join(", ")');
  });

  it("shows a count instead", () => {
    expect(SUMMARY).toContain("models.summary.count");
    // The count's placeholder has to be supplied at the call site, or the page
    // shows a literal "{count}".
    expect(SUMMARY).toMatch(/t\("models\.summary\.count",\s*\{\s*count:/);
  });

  it("keeps the names in a menu", () => {
    expect(SUMMARY).toContain("<Popover");
    expect(SUMMARY).toContain("<PopoverTrigger");
    expect(SUMMARY).toContain("<PopoverContent");
    // Nothing else may render its own menu: two menus would drift apart.
    expect(ADMIN_EDITOR).not.toContain("<Popover");
  });

  it("and that menu is grouped by kind", () => {
    // The same rule the picker uses.
    expect(SUMMARY).toContain("groupAllowedModels(");
    expect(SUMMARY).toContain("groupLabel(t, group.kind)");
  });

  it("says so when every model is allowed", () => {
    // "Every model" is stored as an empty list, so the summary has to say it.
    expect(SUMMARY).toContain('t("models.summary.allModels")');
  });

  it("is the component both surfaces render", () => {
    expect(ADMIN_PAGE).toContain("<AllowedModelsSummary");
    expect(ALLOCATION).toContain("<AllowedModelsSummary");
    expect(ADMIN_EDITOR).toContain("@/components/models/AllowedModelsSummary");
  });
});

describe("the dashboard's grouping", () => {
  it("comes from the catalogue, not from the account's own list", () => {
    // Without the catalogue every name would land in "other", which is the
    // flat list again with a heading on it.
    expect(DASHBOARD_PAGE).toContain("groupModelsByKind(");
    expect(DASHBOARD_PAGE).toContain("modelGroups={modelGroups}");
  });

  it("is not computed for an account with no whitelist", () => {
    // An account on "every model" has nothing to group, and the two provider
    // reads are not free.
    expect(DASHBOARD_PAGE).toMatch(
      /if \(fullUser && fullUser\.allowedModels\.length > 0\)/,
    );
  });
});
