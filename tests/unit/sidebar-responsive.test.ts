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
    expect(sidebar).toContain('collapsed && "w-10 gap-0"');
    expect(sidebar).not.toContain("pl-[7.5px]");
    expect(sidebar).not.toContain('collapsed && "justify-center px-2"');
  });

  it("keeps the icon rail's rows a fixed width, scrollbar or not", () => {
    // The scrollbar used to eat the right-hand side of the item column: the
    // highlight shrank from 40px to 34px, ended up touching the scrollbar
    // track, and the icon stopped being centred inside it. No right padding
    // pushes the scrollbar out to the panel's edge, and a fixed row width
    // keeps the highlight the same size either way.
    expect(sidebar).toContain('collapsed && "pr-0"');
    expect(sidebar).toContain('collapsed && "w-10 gap-0"');
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

  it("gives the toggle a 40px hit target when collapsed", () => {
    expect(sidebar).toContain('collapsed ? "h-8 w-10 pl-3"');
    expect(sidebar).not.toContain('collapsed ? "h-8 w-8" : "h-7 w-7"');
  });

  it("spells the toggle out in the open panel", () => {
    // A bare glyph next to a labelled account button reads as an
    // afterthought; the open panel says what the button does. The label
    // fades with the rail, like the nav labels and the brand wordmark.
    expect(sidebar).toContain(
      'collapsed ? "h-8 w-10 pl-3" : "h-8 w-full gap-3 pl-3 pr-2.5 text-sm font-medium"',
    );
    expect(sidebar).toContain('{t("nav.sidebar.collapse")}');
    expect(sidebar).toContain(
      'collapsed ? "max-w-0 opacity-0" : "max-w-[120px] opacity-100 delay-150"',
    );
  });

  it("gives the footer buttons the same width as the nav items", () => {
    // The panel is one column of rows; two shorter buttons at the foot of it
    // made it look like two pieces put together. Open panel: the full column
    // width. Icon rail: the same 40px the nav rows use.
    expect(sidebar).toContain("border-t border-sidebar-border px-3 py-3");
    expect(sidebar).toContain('collapsed && "w-10 gap-0"');
    expect(sidebar).toContain(
      'collapsed ? "h-8 w-10 pl-3" : "h-8 w-full gap-3 pl-3 pr-2.5 text-sm font-medium"',
    );
  });

  it("crossfades the toggle glyph instead of hard-swapping it", () => {
    expect(sidebar).toContain('collapsed ? "opacity-100" : "opacity-0"');
    expect(sidebar).toContain('collapsed ? "opacity-0" : "opacity-100"');
  });

  it("does not render the pending indicator in the icon-only rail", () => {
    expect(sidebar).toContain("{href && !collapsed && <LinkPendingIndicator />}");
  });

  it("fits its content: 240px open, 64px shut", () => {
    expect(sidebar).toContain("flex w-[240px] flex-col");
    expect(sidebar).toContain('collapsed && "lg:w-[64px]"');
  });

  it("gives the phone drawer the same panel, not a slab of its own", () => {
    // One object, two presentations: the drawer is the desktop panel —
    // same width, same rounded corners, same shadow, same interior — only
    // an overlay. It used to be a 288px hard-edged slab.
    expect(sidebar).toContain("fixed left-0 top-2 bottom-2 z-50 ml-2 flex w-[240px]");
    expect(sidebar).toContain("rounded-lg border border-sidebar-border");
    expect(sidebar).toContain("shadow-float");
  });

  it("slides the drawer off the edge including the 8px it stands off it", () => {
    // Otherwise 8px of the panel would stay on screen when it is closed.
    //
    // The sign matters, and the failure is silent: `-translate-x-[calc(-100%…)]`
    // is Tailwind's *negative modifier* applied to an already-negative value,
    // so it multiplies by -1 and slides the drawer **right** — it parked the
    // closed drawer in the middle of the screen, on top of the content,
    // instead of off the left edge. The negative belongs inside the brackets,
    // the way `translate-x-[-50%]` does it in ui/Modal.tsx.
    expect(sidebar).toContain("translate-x-[calc(-100%_-_0.5rem)]");
    expect(sidebar).not.toContain("-translate-x-[calc(");
  });

  it("keeps the footer one column in both states", () => {
    // Two lines: the account and the collapse toggle. There is no layout
    // switch any more, so nothing is mounted or unmounted to make one.
    expect(layout).toContain('"flex flex-col items-start gap-1"');
    expect(layout).not.toContain("justify-between");
  });

  it("has no status line in the footer", () => {
    // The "service online" hint told nobody anything and cost a row.
    expect(layout).not.toContain("nav.sidebar.statusOnline");
    expect(layout).not.toContain("Activity");
  });

  it("keeps the panel on screen while the page scrolls", () => {
    // `inset-y-0` (the mobile drawer) leaves `bottom: 0` in force, and a
    // sticky box pinned by **both** edges cannot move: it has to fit inside
    // the scrollport, so the whole panel scrolled with the page instead of
    // staying put.
    expect(sidebar).toContain("lg:sticky");
    expect(sidebar).toContain("lg:bottom-auto");
    expect(sidebar).toContain("lg:my-2");
  });

  it("keeps the panel 8px below the top once it sticks", () => {
    // A sticky box is placed by its **border box**, so `top: 0` parked the
    // panel flush against the top of the viewport and the 8px margin was
    // gone (measured: the brand mark sat at y=12 instead of y=20). The inset
    // has to carry the gap, not the margin.
    expect(sidebar).toContain("lg:top-2");
    expect(sidebar).not.toContain("lg:top-0");
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
    expect(header).toContain('"flex h-8 w-10 items-center justify-start pl-2"');
  });

  it("gives the panel's account button the column width", () => {
    expect(header).toContain('"flex h-11 w-full items-center gap-2 pl-2 pr-2.5 sm:h-8"');
    expect(header).toContain("ml-auto h-4 w-4 shrink-0 text-muted-foreground");
  });

  it("does not repeat the name as a role badge", () => {
    // The trigger said "admin admin" on an account called admin — the role
    // is in the menu, where it belongs.
    expect(header).not.toContain("<Badge");
    expect(header).not.toContain("nav.user.adminBadge\"><");
  });

  it("gives the open panel the panel variant (name, no role badge)", () => {
    // The name and the role badge side by side read as "admin admin", and the
    // badge is what pushed the wordmark out of the panel's header.
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
