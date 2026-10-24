/**
 * tests/unit/mobile-account-menu.test.ts
 *
 * The account menu at the bottom of the sidebar, on a phone.
 *
 * The phone's sidebar is a drawer: the same 240px panel the desktop shows,
 * floating over the page, with the account button in its footer. That button
 * is the *last* thing on the screen, and the menu that opens from it used to
 * be 224px wide — 8px wider than the column the button sits in — which meant
 * it hung over the button's left edge and read as belonging to nothing. It
 * also asked to open *downwards*, from a button that has no room below it, and
 * only avoided the bottom of the screen because the popover library flipped it
 * on its own.
 *
 * This file pins the three things that have to agree:
 *
 *   1. the menu opens **upwards** from the panel's footer button;
 *   2. it hangs off that button's **left** edge, so it is in the same column;
 *   3. it is exactly as wide as that column — and the column's width is the
 *      panel's width minus the footer's padding, taken from **one** number.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const read = (...parts: string[]): string =>
  readFileSync(join(ROOT, ...parts), "utf-8");

const HEADER = read("src", "components", "layouts", "AppHeader.tsx");
const SIDEBAR = read("src", "components", "layouts", "sidebar", "Sidebar.tsx");
const CONTEXT = read("src", "components", "layouts", "sidebar", "SidebarContext.tsx");
const GLOBALS = read("src", "app", "globals.css");

/** The popover's props, as written in the source. */
function popoverProps(): string {
  const start = HEADER.indexOf("<PopoverContent");
  const end = HEADER.indexOf(">", start);
  return HEADER.slice(start, end);
}

describe("the account menu at the bottom of the panel", () => {
  it("opens upwards, because the button is the last thing on the screen", () => {
    // The panel variant is the rail's footer and the phone drawer's footer —
    // in both cases the button is at the bottom, and "downwards" only avoided
    // the edge of the screen because the popover library flipped it.
    expect(popoverProps()).toMatch(/side=\{variant === "full" \? "bottom" : "top"\}/);
  });

  it("hangs off the button's left edge, so it stays in the same column", () => {
    expect(popoverProps()).toMatch(/align=\{variant === "full" \? "end" : "start"\}/);
  });

  it("is exactly as wide as the column it belongs to", () => {
    // The button is the width of the footer's content, and the footer sits
    // inside the panel with 0.75rem of padding on each side.
    expect(popoverProps()).toContain("w-[calc(var(--sidebar-panel-width)-1.5rem)]");
    expect(SIDEBAR).toContain("px-3");
  });

  it("and the narrow-screen bar's menu still drops down and to the right", () => {
    // The other case: a button at the top right of the screen wants the
    // opposite of both.
    expect(popoverProps()).toContain('variant === "full" ? "w-56"');
  });
});

describe("the panel and its menu share one width", () => {
  it("the panel's width is a variable", () => {
    expect(GLOBALS).toContain("--sidebar-panel-width: 240px;");
  });

  it("and the panel uses it", () => {
    // Two places that have to agree cannot both spell the number.
    expect(SIDEBAR).toContain("w-[var(--sidebar-panel-width)]");
    expect(SIDEBAR).not.toContain("w-[240px]");
  });
});

describe("the phone's drawer keeps the wide panel", () => {
  it("the icon rail is a desktop idea", () => {
    // On a phone the sidebar is a 240px drawer, so the account button is the
    // wide one — the mini variant belongs to the 64px rail only.
    expect(CONTEXT).toMatch(/const collapsed = state === "collapsed" && !isMobile;/);
  });
});
