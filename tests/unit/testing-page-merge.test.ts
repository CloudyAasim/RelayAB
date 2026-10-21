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
 *
 * The second half changed shape: the search settings page used to end in a
 * "运行状态" card that showed the state, held a feature-wide switch and a
 * global price, and had its own test box. The card is gone — the provider
 * rows are the state and the switch — so what this file guards is now
 * "the settings page is the list, and nothing else".
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
const SEARCH_PAGE = read("app", "(admin)", "admin", "search", "page.tsx");

describe("one testing page", () => {
  it("is labelled '测试', not '模型测试'", () => {
    expect(translate("zh-CN", "nav.models")).toBe("测试");
    expect(translate("zh-CN", "dashboard.models.title")).toBe("测试");
    expect(translate("en", "nav.models")).toBe("Testing");
  });

  it("renders the search tester next to the model testers", () => {
    expect(WORKSPACE).toMatch(/import \{ SearchTester/);
    expect(WORKSPACE).toMatch(/searchTest && \(/);
    expect(WORKSPACE).toMatch(/<SearchTester\s+labels=\{searchTest\.labels\}/);
    // …and the tester is told which services there are, because there is no
    // default one: the operator picks the service to test.
    expect(WORKSPACE).toMatch(/services=\{searchTest\.services\}/);
  });

  it("gives it to administrators only", () => {
    // The page decides; the component is not merely hidden with CSS. The test
    // route behind the card answers 403 for everyone else.
    expect(PAGE).toMatch(/sessionUser\.role === "admin" \? await loadSearchConfig/);
    expect(PAGE).toMatch(/searchTest=\{/);
  });

  it("talks to the admin search test route, not a new one", () => {
    expect(SEARCH_TESTER).toContain("/api/admin/search/test");
  });

  it("says the test is billed, because it is", () => {
    // The old promise was "this path charges nothing". It is not true any
    // more — the test goes through the same settlement as a real search — and
    // a label that says otherwise would be a lie in the operator's face.
    expect(SEARCH_TESTER).toContain("labels.billed");
    expect(SEARCH_TESTER).not.toContain("labels.unbilled");
    expect(translate("zh-CN", "admin.search.test.billed")).toMatch(/计费/);
  });
});

describe("the search settings page is the list, and nothing else", () => {
  it("no longer carries a status card", () => {
    // The card showed a second copy of facts the list already carries (which
    // backend serves, what it costs) and a feature-wide switch beside the
    // rows' own switches.
    expect(SEARCH_PAGE).not.toContain("SearchPanel");
    expect(SEARCH_PAGE).not.toContain("admin.search.status.");
  });

  it("no longer carries a second test box", () => {
    expect(SEARCH_PAGE).not.toContain("/api/admin/search/test");
  });

  it("takes its state from the provider rows", () => {
    expect(SEARCH_PAGE).toContain("admin.searchProviders.spec");
    expect(SEARCH_PAGE).toContain("admin.searchProviders.legacy");
  });
});

describe("price lives on the provider", () => {
  const FORM = read("app", "(admin)", "admin", "search", "SearchProviderForm.tsx");
  const FALLBACK = read("app", "(admin)", "admin", "search", "EnvFallbackPrice.tsx");

  it("is edited on the provider form and shown in the list", () => {
    expect(FORM).toContain("creditsPerCall");
    expect(SEARCH_PAGE).toContain('t("admin.searchProviders.creditsPerCall")');
  });

  it("keeps the environment fallback's price for the case it is the one in use", () => {
    // The fallback is the path a deployment uses before it has any provider
    // row, so its price is editable exactly while there are no rows.
    expect(SEARCH_PAGE).toContain("EnvFallbackPrice");
    expect(SEARCH_PAGE).toMatch(/providers\.length === 0 && \(/);
    expect(FALLBACK).toContain("creditsPerCall");
  });
});
