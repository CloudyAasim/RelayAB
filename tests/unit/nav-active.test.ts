import { describe, it, expect } from "vitest";
import { isNavItemActive } from "@/lib/nav";

describe("isNavItemActive", () => {
  it("matches the exact path", () => {
    expect(isNavItemActive("/dashboard", "/dashboard")).toBe(true);
    expect(isNavItemActive("/dashboard/docs", "/dashboard/docs")).toBe(true);
  });

  it("keeps nested entries highlighted for their sub-pages", () => {
    expect(isNavItemActive("/dashboard/docs/intro", "/dashboard/docs")).toBe(true);
    expect(isNavItemActive("/admin/users/123", "/admin/users")).toBe(true);
  });

  it("does not light up a section root on a sibling route", () => {
    // The regression: a plain prefix match made "dashboard" active on every
    // /dashboard/* page.
    expect(isNavItemActive("/dashboard/docs", "/dashboard", { exact: true })).toBe(false);
    expect(isNavItemActive("/dashboard/settings", "/dashboard", { exact: true })).toBe(false);
    expect(isNavItemActive("/admin/users", "/admin", { exact: true })).toBe(false);
    expect(isNavItemActive("/admin/docs", "/admin", { exact: true })).toBe(false);
  });

  it("still matches the section root itself when exact", () => {
    expect(isNavItemActive("/dashboard", "/dashboard", { exact: true })).toBe(true);
    expect(isNavItemActive("/admin", "/admin", { exact: true })).toBe(true);
  });

  it("never matches without a pathname", () => {
    expect(isNavItemActive(null, "/dashboard")).toBe(false);
    expect(isNavItemActive(undefined, "/dashboard", { exact: true })).toBe(false);
  });

  it("does not treat a lookalike prefix as a match", () => {
    expect(isNavItemActive("/dashboard-extra", "/dashboard")).toBe(false);
    expect(isNavItemActive("/administer", "/admin")).toBe(false);
  });
});
