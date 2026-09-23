/**
 * Login page must NOT scroll on standard viewports.
 *
 * These tests verify the markup invariants that keep the page inside the
 * viewport. Real visual verification happens in the Playwright e2e suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const loginPage = readFileSync(
  join(__dirname, "..", "..", "src", "app", "(auth)", "login", "page.tsx"),
  "utf-8",
);

describe("login page: no-vertical-scroll invariants", () => {
  it("uses fixed inset-0 to lock to the viewport", () => {
    expect(loginPage).toContain("fixed inset-0");
  });

  it("wraps content in flex flex-col with shrink-0 header", () => {
    expect(loginPage).toContain("flex flex-col");
    expect(loginPage).toContain("shrink-0");
  });

  it("main content uses flex-1 to fill remaining space", () => {
    expect(loginPage).toContain("flex-1");
  });

  it("overflow is contained (no body-level scroll)", () => {
    // Either `overflow-hidden` on main or `inset-0` on the outer wrapper
    // is sufficient.
    expect(loginPage).toMatch(/overflow-hidden|fixed inset-0/);
  });
});
