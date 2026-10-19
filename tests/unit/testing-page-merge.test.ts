/**
 * tests/unit/testing-page-merge.test.ts
 *
 * "Test a model" and "test a search" are the same question asked about two
 * things the gateway fronts, so they share one page and one nav entry.
 *
 * What has to stay true:
 *  - the search probe is rendered on the testing page, for administrators,
 *  - it is not rendered for regular users (the route behind it is admin-only),
 *  - and the search settings page no longer carries a second copy of the box.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { translate } from "@/lib/i18n/dict";

const SRC = join(__dirname, "..", "..", "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf-8");

const WORKSPACE = read("app", "(user)", "dashboard", "models", "ModelsWorkspace.tsx");
const PAGE = read("app", "(user)", "dashboard", "models", "page.tsx");
const SEARCH_TESTER = read("app", "(user)", "dashboard", "models", "SearchTester.tsx");
const SEARCH_PANEL = read("app", "(admin)", "admin", "search", "SearchPanel.tsx");

describe("one testing page", () => {
  it("is labelled '测试', not '模型测试'", () => {
    expect(translate("zh-CN", "nav.models")).toBe("测试");
    expect(translate("zh-CN", "dashboard.models.title")).toBe("测试");
    expect(translate("en", "nav.models")).toBe("Testing");
  });

  it("renders the search tester next to the model testers", () => {
    expect(WORKSPACE).toMatch(/import \{ SearchTester/);
    expect(WORKSPACE).toMatch(/searchTest && \(/);
    expect(WORKSPACE).toMatch(/<SearchTester labels=\{searchTest\.labels\}/);
  });

  it("gives it to administrators only", () => {
    // The page decides; the component is not merely hidden with CSS. The test
    // route behind the card answers 403 for everyone else.
    expect(PAGE).toMatch(/sessionUser\.role === "admin" \? await loadSearchConfig/);
    expect(PAGE).toMatch(/searchTest=\{/);
  });

  it("talks to the admin search test route, not a new one", () => {
    expect(SEARCH_TESTER).toContain("/api/admin/search/test");
    // The "not billed" promise is still shown to the operator.
    expect(SEARCH_TESTER).toContain("labels.unbilled");
  });

  it("removes the duplicate box from the search settings page", () => {
    expect(SEARCH_PANEL).not.toContain("/api/admin/search/test");
    expect(SEARCH_PANEL).not.toMatch(/admin\.search\.test\./);
  });
});

describe("price lives on the provider", () => {
  const FORM = read("app", "(admin)", "admin", "search", "SearchProviderForm.tsx");
  const SEARCH_PAGE = read("app", "(admin)", "admin", "search", "page.tsx");

  it("is edited on the provider form and shown in the list", () => {
    expect(FORM).toContain("creditsPerCall");
    expect(SEARCH_PAGE).toContain('t("admin.searchProviders.creditsPerCall")');
  });

  it("keeps the global price only as the environment fallback", () => {
    // The global input is rendered when the active backend has no row.
    expect(SEARCH_PANEL).toMatch(/\{!props\.creditsFromProvider && \(/);
    expect(SEARCH_PANEL).toMatch(/priceFromProvider/);
  });
});
