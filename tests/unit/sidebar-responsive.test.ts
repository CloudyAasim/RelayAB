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
 * Regression guard for the collapsed rail and its expand/collapse motion.
 *
 * The icon-only rail is 56px wide with 32px of usable interior after `px-3`.
 * Two problems previously showed up here and must not come back:
 *   1. the footer kept the status label and the toggle in one `justify-between`
 *      row, so the toggle overflowed the rail (measured scrollWidth 62 >
 *      clientWidth 55);
 *   2. the width snapped / labels popped and the footer switched to a column
 *      mid-animation, which made the collapse feel jumpy.
 * The rail now eases its width, keeps labels mounted and clips them, and the
 * footer stays a single row that shrinks its status block.
 */
describe("sidebar: collapsed rail layout & motion", () => {
  const layout = read("components/layouts/AuthenticatedLayout.tsx");
  const sidebar = read("components/layouts/sidebar/Sidebar.tsx");

  it("eases the rail width with one shared curve and clips overflow", () => {
    expect(sidebar).toContain(
      "transition-[width,transform] duration-300 ease-sidebar",
    );
    expect(sidebar).toContain("overflow-hidden");
    expect(sidebar).toContain("motion-reduce:transition-none");
  });

  it("keeps nav labels mounted and collapses them via max-width/opacity", () => {
    expect(sidebar).toContain(
      'collapsed ? "max-w-0 opacity-0" : "max-w-[180px] opacity-100 delay-150"',
    );
    expect(sidebar).not.toContain("collapsed && \"hidden\"");
  });

  it("nudges the nav icon inward instead of jumping it to the centre", () => {
    expect(sidebar).toContain('collapsed && "gap-0 pl-[7.5px] pr-[7.5px]"');
    expect(sidebar).not.toContain('collapsed && "justify-center px-2"');
  });

  it("fades the brand wordmark instead of unmounting it", () => {
    expect(layout).toContain(
      'collapsed ? "max-w-0 opacity-0" : "max-w-[120px] opacity-100 delay-150"',
    );
  });

  it("keeps the footer a single shrinking row (no mid-animation column)", () => {
    expect(layout).toContain("justify-between");
    expect(layout).toContain(
      'collapsed ? "max-w-0 opacity-0" : "max-w-[180px] opacity-100 delay-150"',
    );
    expect(layout).not.toContain("flex flex-col items-center");
  });

  it("aligns the collapsed brand mark with the 32px nav icons", () => {
    expect(layout).toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
    expect(layout).toContain('collapsed && "px-3"');
  });

  it("gives the toggle a 32px hit target when collapsed", () => {
    expect(sidebar).toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
  });

  it("crossfades the toggle glyph instead of hard-swapping it", () => {
    expect(sidebar).toContain('collapsed ? "opacity-100" : "opacity-0"');
    expect(sidebar).toContain('collapsed ? "opacity-0" : "opacity-100"');
  });

  it("does not render the pending indicator in the icon-only rail", () => {
    expect(sidebar).toContain("{href && !collapsed && <LinkPendingIndicator />}");
  });
});
