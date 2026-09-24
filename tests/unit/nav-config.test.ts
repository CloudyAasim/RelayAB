/**
 * Regression guard for RB-001: ADMIN_NAV missing "/dashboard/settings" entry.
 *
 * The sidebar is rendered by picking USER_NAV or ADMIN_NAV based on role and
 * then mapping over sections → items.  There is no per-item filter, so
 * "does ADMIN_NAV contain X?" is exactly equivalent to "can an admin reach X?".
 *
 * Scope: personal section only (where RB-001 was found).
 * Non-personal sections (admin group, reference group) are out of scope —
 * pre-existing issues there are tracked separately.
 */
import { describe, it, expect } from "vitest";
import { USER_NAV, ADMIN_NAV } from "@/components/layouts/AuthenticatedLayout";

/** ADMIN_NAV's personal section (labelKey === "nav.sidebar.personal"). */
function adminPersonalItems() {
  return ADMIN_NAV.find((s) => s.labelKey === "nav.sidebar.personal")?.items ?? [];
}

/** USER_NAV's workspace section (labelKey === "nav.sidebar.workspace"). */
function userWorkspaceItems() {
  return USER_NAV.find((s) => s.labelKey === "nav.sidebar.workspace")?.items ?? [];
}

function findItem(items: ReturnType<typeof adminPersonalItems>, href: string) {
  return items.find((i) => i.href === href);
}

describe("nav config: RB-001 regression guard", () => {
  describe("USER_NAV workspace section", () => {
    it("contains /dashboard/settings", () => {
      expect(findItem(userWorkspaceItems() as any, "/dashboard/settings")).toBeDefined();
    });

    it("every item has a non-empty labelKey", () => {
      const missing = userWorkspaceItems().filter((i: any) => !i.labelKey);
      expect(missing).toEqual([]);
    });

    it("every item has a non-empty titleKey", () => {
      const missing = userWorkspaceItems().filter((i: any) => !i.titleKey);
      expect(missing).toEqual([]);
    });
  });

  describe("ADMIN_NAV personal section (RB-001 guard)", () => {
    it("contains /dashboard/settings", () => {
      expect(findItem(adminPersonalItems(), "/dashboard/settings")).toBeDefined();
    });

    it("USER_NAV workspace and ADMIN_NAV personal both have /dashboard/settings", () => {
      expect(findItem(userWorkspaceItems() as any, "/dashboard/settings")).toBeDefined();
      expect(findItem(adminPersonalItems(), "/dashboard/settings")).toBeDefined();
    });

    it("every item has a non-empty labelKey", () => {
      const missing = adminPersonalItems().filter((i) => !i.labelKey);
      expect(missing).toEqual([]);
    });

    it("every item has a non-empty titleKey", () => {
      const missing = adminPersonalItems().filter((i) => !i.titleKey);
      expect(missing).toEqual([]);
    });
  });
});
