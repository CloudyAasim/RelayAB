/**
 * Regression guard for RB-001: ADMIN_NAV missing "/dashboard/settings" entry.
 *
 * The sidebar is rendered by picking USER_NAV or ADMIN_NAV based on role and
 * then mapping over sections → items.  There is no per-item filter, so
 * "does ADMIN_NAV contain X?" is exactly equivalent to "can an admin reach X?".
 *
 * Scope: mostly the personal section (where RB-001 was found). The admin
 * group is checked only for the announcement publishing page, which was added
 * deliberately and would be unreachable if it were left out.
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

  /**
   * The announcement centre has to be reachable from both sides, and the
   * publishing screen from the admin group — the same "is it in NAV?" question
   * as RB-001, for a page that was added rather than forgotten.
   */
  describe("announcements are reachable", () => {
    it("a user reaches /dashboard/announcements from the workspace section", () => {
      expect(findItem(userWorkspaceItems() as any, "/dashboard/announcements")).toBeDefined();
    });

    it("an admin reaches /dashboard/announcements from the personal section", () => {
      // An admin reads the notices too; the centre is not an admin-only page.
      expect(findItem(adminPersonalItems(), "/dashboard/announcements")).toBeDefined();
    });

    it("an admin reaches /admin/announcements from the admin group", () => {
      const adminGroup =
        ADMIN_NAV.find((s) => s.labelKey === "nav.sidebar.admin")?.items ?? [];
      expect(findItem(adminGroup, "/admin/announcements")).toBeDefined();
    });

    it("the publishing page is not in the reader's nav", () => {
      // `/admin/announcements` redirects a non-admin to the dashboard anyway;
      // offering the link would be a control that only refuses.
      expect(findItem(userWorkspaceItems() as any, "/admin/announcements")).toBeUndefined();
    });

    it("both spellings carry the label and title the sidebar prints", () => {
      const centre = findItem(adminPersonalItems(), "/dashboard/announcements");
      expect(centre?.labelKey).toBe("announcements.title");
      expect(centre?.titleKey).toBe("announcements.title");

      const adminGroup =
        ADMIN_NAV.find((s) => s.labelKey === "nav.sidebar.admin")?.items ?? [];
      const publishing = findItem(adminGroup, "/admin/announcements");
      expect(publishing?.labelKey).toBe("nav.announcements");
      expect(publishing?.titleKey).toBe("admin.announcements.title");
    });
  });
});
