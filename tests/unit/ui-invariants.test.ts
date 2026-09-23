/**
 * UI invariants — markup-based checks that keep the responsive design honest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..", "..", "src");

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf-8");
}

describe("responsive UI: login page invariants", () => {
  const login = read("app/(auth)/login/page.tsx");

  it("uses fixed inset-0 to lock viewport", () => {
    expect(login).toContain("fixed inset-0");
  });

  it("wraps content in flex column with shrink-0 header", () => {
    expect(login).toContain("flex flex-col");
    expect(login).toContain("shrink-0");
  });

  it("main content fills remaining space (flex-1)", () => {
    expect(login).toContain("flex-1");
  });

  it("constrains main width via max-w-* utility", () => {
    expect(login).toMatch(/max-w-(sm|md)/);
  });
});

describe("responsive UI: landing page invariants", () => {
  const landing = read("app/page.tsx");

  it("uses responsive grid for 'how it works' cards", () => {
    expect(landing).toMatch(/grid[\s\S]+?sm:grid-cols-2[\s\S]+?lg:grid-cols-4/);
  });

  it("stacks buttons on mobile (flex-col on small)", () => {
    expect(landing).toMatch(/flex-col[\s\S]+?sm:flex-row/);
  });

  it("centers hero content", () => {
    expect(landing).toContain("items-center text-center");
  });
});

describe("responsive UI: dashboard invariants", () => {
  const dashboard = read("app/(user)/dashboard/page.tsx");

  it("stats grid is responsive: 1 col → 2 col → 3 col", () => {
    expect(dashboard).toMatch(/grid-cols-1[\s\S]+?sm:grid-cols-2[\s\S]+?lg:grid-cols-3/);
  });

  it("hides low-priority table columns on small screens", () => {
    // The dashboard progressively hides columns at md/lg/xl breakpoints.
    expect(dashboard).toMatch(/hidden\s+(md|lg|xl):table-cell/);
  });

  it("table is wrapped in overflow-x-auto for narrow viewports", () => {
    expect(dashboard).toContain("overflow-x-auto");
  });
});

describe("responsive UI: SectionPageLayout invariants", () => {
  const section = read("components/layouts/SectionPageLayout.tsx");

  it("title/actions row stacks on mobile", () => {
    expect(section).toMatch(/flex-col[\s\S]+?sm:flex-row/);
  });
});

describe("responsive UI: docs page invariants", () => {
  const docs = read("app/(user)/dashboard/docs/DocsContent.tsx");

  it("Python/Node code cards stack on mobile", () => {
    expect(docs).toMatch(/grid-cols-1[\s\S]+?lg:grid-cols-2/);
  });

  it("table overflow-x-auto wraps long URL rows", () => {
    expect(docs).toContain("overflow-x-auto");
  });
});

describe("responsive UI: sidebar invariants", () => {
  const sidebar = read("components/layouts/sidebar/Sidebar.tsx");
  const ctx = read("components/layouts/sidebar/SidebarContext.tsx");

  it("sidebar uses lg breakpoint for desktop rail", () => {
    expect(sidebar).toContain("lg:sticky");
    expect(sidebar).toContain("lg:translate-x-0");
  });

  it("mobile drawer uses fixed positioning", () => {
    expect(sidebar).toContain("fixed inset-y-0 left-0");
  });

  it("context detects mobile via 1023px breakpoint", () => {
    expect(ctx).toContain("(max-width: 1023px)");
  });

  it("sidebar expands only at >= 1280px", () => {
    expect(ctx).toContain("EXPAND_MIN_VIEWPORT = 1280");
  });
});

describe("responsive UI: AuthenticatedLayout invariants", () => {
  const layout = read("components/layouts/AuthenticatedLayout.tsx");

  it("main content padding scales with viewport", () => {
    expect(layout).toMatch(/p-4[\s\S]+?sm:p-6[\s\S]+?lg:p-8/);
  });
});
