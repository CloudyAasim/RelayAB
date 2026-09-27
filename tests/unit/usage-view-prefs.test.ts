import { describe, it, expect } from "vitest";
import {
  USAGE_VIEW_KEYS,
  usageViewCookieName,
  usageViewFromParams,
} from "@/lib/usage/view-prefs";

describe("usage view prefs", () => {
  it("maps the two usage paths to distinct cookies", () => {
    expect(usageViewCookieName("/admin/usage")).toBe("relay_usage_view_admin");
    expect(usageViewCookieName("/dashboard/usage")).toBe("relay_usage_view_user");
  });

  it("returns null for paths that are not usage screens", () => {
    expect(usageViewCookieName("/admin/users")).toBeNull();
    expect(usageViewCookieName("/dashboard")).toBeNull();
    expect(usageViewCookieName("/dashboard/usage/extra")).toBeNull();
  });

  it("keeps only the view params (ignoring _rsc and unknown keys)", () => {
    const params = new URLSearchParams(
      "range=30d&metric=tokens&_rsc=abc&group=model&foo=bar",
    );
    expect(usageViewFromParams(params)).toBe("range=30d&metric=tokens&group=model");
  });

  it("returns null when no view params are present", () => {
    expect(usageViewFromParams(new URLSearchParams("_rsc=abc"))).toBeNull();
    expect(usageViewFromParams(new URLSearchParams(""))).toBeNull();
  });

  it("drops empty values", () => {
    expect(usageViewFromParams(new URLSearchParams("range=&metric=credits"))).toBe(
      "metric=credits",
    );
  });

  it("re-filters a stored cookie value so junk cannot be replayed", () => {
    const stored = "range=7d&evil=drop-table&scope=all";
    expect(usageViewFromParams(new URLSearchParams(stored))).toBe(
      "range=7d&scope=all",
    );
  });

  it("persists exactly the documented keys, in order", () => {
    expect([...USAGE_VIEW_KEYS]).toEqual([
      "range",
      "scope",
      "keyId",
      "model",
      "metric",
      "group",
    ]);
  });
});
