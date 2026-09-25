import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { sidebarStateForViewport } from "@/components/layouts/sidebar";

const SRC = join(__dirname, "..", "..", "src");
function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf-8");
}

/**
 * The sidebar picks its layout from the viewport: the expanded rail (256px)
 * needs room, otherwise it is collapsed. `lg` (1024px) is where the rail stops
 * being a drawer, but 1024px minus 256px leaves too narrow a content column,
 * so the expanded default only kicks in from 1280px up.
 */
describe("sidebarStateForViewport", () => {
  it("stays collapsed on narrow viewports", () => {
    expect(sidebarStateForViewport(320)).toBe("collapsed");
    expect(sidebarStateForViewport(768)).toBe("collapsed");
    expect(sidebarStateForViewport(1024)).toBe("collapsed");
    expect(sidebarStateForViewport(1279)).toBe("collapsed");
  });

  it("expands once the rail fits alongside the content", () => {
    expect(sidebarStateForViewport(1280)).toBe("expanded");
    expect(sidebarStateForViewport(1440)).toBe("expanded");
    expect(sidebarStateForViewport(2560)).toBe("expanded");
  });
});

/**
 * Regression guard for the collapsed rail.
 *
 * The icon-only rail is 56px wide with 32px of usable interior after `px-3`.
 * Before this guard, the footer kept the status label and the toggle in one
 * `justify-between` row, so the toggle overflowed the rail (measured
 * scrollWidth 62 > clientWidth 55), and the brand mark did not line up with
 * the nav icons. These assertions pin the fixed structure down.
 */
describe("sidebar: collapsed rail layout", () => {
  const layout = read("components/layouts/AuthenticatedLayout.tsx");
  const sidebar = read("components/layouts/sidebar/Sidebar.tsx");

  it("stacks the footer controls vertically when collapsed", () => {
    expect(layout).toContain('className="flex flex-col items-center gap-1.5"');
  });

  it("keeps the expanded footer as a single row", () => {
    expect(layout).toContain('className="flex items-center justify-between gap-2"');
  });

  it("aligns the collapsed brand mark with the 32px nav icons", () => {
    expect(layout).toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
    expect(layout).toContain('collapsed && "justify-center px-3"');
  });

  it("gives the toggle a 32px hit target when collapsed", () => {
    expect(sidebar).toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
  });

  it("does not render the pending indicator in the icon-only rail", () => {
    expect(sidebar).toContain("{href && !collapsed && <LinkPendingIndicator />}");
  });
});
