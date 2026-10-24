/**
 * tests/unit/admin-model-summary.test.ts
 *
 * The account card's "allowed models" row.
 *
 * It used to print every model name, comma-joined, inside a three-column
 * grid — so an account with a generous whitelist was three lines taller than
 * its neighbours and pushed the rest of the card down. The row now shows how
 * many models the account has, and the names live in a menu behind it.
 *
 * The menu is the same grouping the picker uses, so the two never disagree
 * about what a model is.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const EDITOR = readFileSync(
  join(ROOT, "src", "app", "(admin)", "admin", "users", "AllocationEditor.tsx"),
  "utf-8",
);

describe("the account card's model row", () => {
  it("does not print every model name into the card", () => {
    // This is the thing that made one card three lines taller than its
    // neighbours: fourteen model names, comma-joined, in a 60%-wide cell.
    expect(EDITOR).not.toContain('u.allowedModels.join(", ")');
  });

  it("shows a count instead", () => {
    expect(EDITOR).toContain("admin.users.allocation.modelCount");
    // The count's placeholder has to be supplied at the call site, or the
    // page shows "{count} models".
    expect(EDITOR).toMatch(
      /t\("admin\.users\.allocation\.modelCount",\s*\{\s*count:/,
    );
  });

  it("keeps the names in a menu", () => {
    expect(EDITOR).toContain("<Popover");
    expect(EDITOR).toContain("<PopoverTrigger");
    expect(EDITOR).toContain("<PopoverContent");
  });

  it("and that menu is grouped by kind", () => {
    // The same rule the picker uses.
    expect(EDITOR).toContain("groupAllowedModels(");
    expect(EDITOR).toContain("groupLabel(t, group.kind)");
  });

  it("and it still offers the whole-catalog shortcut when nothing is granted", () => {
    // "Every model" is stored as an empty list, so the row has to say so.
    expect(EDITOR).toContain('t("admin.users.allocation.allModels")');
  });
});
