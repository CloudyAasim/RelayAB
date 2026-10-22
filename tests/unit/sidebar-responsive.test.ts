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
 * The icon-only rail is 64px wide with 32px of usable interior after `px-4`,
 * and everything in the panel sits on that one axis: the brand mark, the nav
 * items, the account button and the collapse toggle.
 *
 * Two problems previously showed up here and must not come back:
 *   1. the footer kept the status label and the toggle in one `justify-between`
 *      row, so the toggle overflowed the rail (measured scrollWidth 62 >
 *      clientWidth 55);
 *   2. elements changed **place** between the two states — the nav icons
 *      shifted sideways, the brand mark changed size, and the account button
 *      lived in the panel's top-right corner when it was open and at the
 *      bottom when it was shut.
 *
 * The rail now eases its width, keeps labels mounted and clips them, and
 * **nothing in it moves**: the same elements sit at the same coordinates
 * whether the panel is open or shut.
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

  it("keeps the nav icon where it is when the rail narrows", () => {
    // The rail narrows and the label is clipped — the icon does not move.
    expect(sidebar).toContain('collapsed && "gap-0"');
    expect(sidebar).not.toContain("pl-[7.5px]");
    expect(sidebar).not.toContain('collapsed && "justify-center px-2"');
  });

  it("fades the brand wordmark instead of unmounting it", () => {
    expect(layout).toContain(
      'collapsed ? "max-w-0 opacity-0" : "max-w-[120px] opacity-100 delay-150"',
    );
  });

  it("keeps the brand mark 32x32 in both states", () => {
    expect(layout).toContain(
      '"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"',
    );
    expect(layout).not.toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
  });

  it("gives the toggle a 32px hit target in both states", () => {
    expect(sidebar).toContain(
      '"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70',
    );
    expect(sidebar).not.toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
  });

  it("crossfades the toggle glyph instead of hard-swapping it", () => {
    expect(sidebar).toContain('collapsed ? "opacity-100" : "opacity-0"');
    expect(sidebar).toContain('collapsed ? "opacity-0" : "opacity-100"');
  });

  it("does not render the pending indicator in the icon-only rail", () => {
    expect(sidebar).toContain("{href && !collapsed && <LinkPendingIndicator />}");
  });

  it("fits its content: 240px open, 64px shut", () => {
    expect(sidebar).toContain("lg:w-[240px]");
    expect(sidebar).toContain('collapsed && "lg:w-[64px]"');
  });

  it("keeps the footer one column in both states", () => {
    // Three lines: the status, the account, the collapse toggle. The status
    // shrinks its own width and height and fades; nothing is unmounted.
    expect(layout).toContain('"flex flex-col items-start gap-1"');
    expect(layout).not.toContain("justify-between");
    expect(layout).toContain(
      'collapsed ? "max-h-0 max-w-0 opacity-0" : "max-h-4 max-w-[180px] opacity-100 delay-150"',
    );
  });

  it("gives the account one home, in the footer, in both states", () => {
    expect(layout.match(/<UserMenu/g)?.length).toBe(1);
    expect(layout).toContain('variant={collapsed ? "mini" : "panel"}');
  });
});

/**
 * The account menu has to work from the 64px rail, where the panel's own
 * `overflow-hidden` is an active obstacle: a menu drawn inside the panel is
 * cut off at the panel's edge, and the trigger itself — avatar, name, role
 * badge, chevron — is far wider than the rail.
 */
describe("sidebar: the account menu in the icon-only rail", () => {
  const layout = read("components/layouts/AuthenticatedLayout.tsx");
  const header = read("components/layouts/AppHeader.tsx");

  it("shrinks the trigger to the avatar in the icon-only rail", () => {
    expect(header).toContain('variant?: "full" | "panel" | "mini"');
    expect(header).toContain('variant === "mini"');
    expect(header).toContain('"flex h-8 w-8 items-center justify-center"');
  });

  it("gives the open panel the panel variant (name, no role badge)", () => {
    // The name and the role badge side by side read as "admin admin", and the
    // badge is what pushed the wordmark out of the panel's header.
    expect(header).toContain('variant === "full" && (');
    expect(header).toContain('variant === "panel"');
    expect(layout).toContain('variant={collapsed ? "mini" : "panel"}');
  });

  it("leaves the panel so the panel cannot clip it", () => {
    // A portal, not an absolutely positioned child: the panel clips its own
    // overflow, so a menu inside it dies at the panel's edge.
    expect(header).toContain("<PopoverContent");
    expect(header).not.toContain("absolute right-0 top-full");
  });
});
