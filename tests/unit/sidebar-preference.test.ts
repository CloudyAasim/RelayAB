/**
 * tests/unit/sidebar-preference.test.ts
 *
 * The panel's width follows two rules, and which one wins is the whole
 * difference between "it remembered what I did" and "it opened itself".
 *
 *   1. What the user pressed wins — through reloads, full page loads and
 *      cross-segment navigations.
 *   2. The viewport fills in what the user has not decided.
 *
 * The bug this file guards: rule 2 ran on **every** mount and overwrote
 * rule 1, so collapsing the rail and reloading brought it straight back —
 * and since switching between route groups triggers a full page load, the
 * rail appeared to expand on its own whenever a link crossed that boundary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sidebarStateForViewport } from "@/components/layouts/sidebar";

const ROOT = process.cwd();
const read = (relative: string): string =>
  readFileSync(join(ROOT, "src", relative), "utf-8");

const CTX = read("components/layouts/sidebar/SidebarContext.tsx");

describe("the sidebar's state rules", () => {
  it("the user's own choice wins over the viewport", () => {
    expect(CTX).toContain(
      "const next = pref ?? sidebarStateForViewport(window.innerWidth)",
    );
    // The resize rule must stand down when a choice exists.
    expect(CTX).toContain("if (readSidebarPreference()) return;");
  });

  it("the choice is stored apart from the default", () => {
    // A separate cookie from the one the viewport rule used to write: that one
    // held the *default* for the current window size, so reading it back as a
    // choice would pin the rail to whatever the window was last time.
    expect(CTX).toContain("relayab_sidebar_pref");
    expect(CTX).not.toContain("relayab_sidebar_state");
  });

  it("only the toggle writes the choice", () => {
    const writes = CTX.match(/writeSidebarPreference\(/g) ?? [];
    // one call site (the definition) plus one use (the toggle)
    expect(writes.length).toBe(2);
  });

  it("the decision is made before the first paint", () => {
    // With a plain effect the browser painted the expanded panel and
    // corrected it a frame later — that snap is what made the rail look like
    // it changed state by itself.
    expect(CTX).toContain(
      'typeof window !== "undefined" ? useLayoutEffect : useEffect',
    );
    expect(CTX).toContain("useIsomorphicLayoutEffect(() => {");
  });

  it("the drawer starts shut", () => {
    // An overlay that opens by itself covers the page it sits beside.
    expect(CTX).toContain("const [open, setOpen] = useState<boolean>(false)");
  });

  it("the viewport threshold is unchanged", () => {
    expect(sidebarStateForViewport(1024)).toBe("collapsed");
    expect(sidebarStateForViewport(1279)).toBe("collapsed");
    expect(sidebarStateForViewport(1280)).toBe("expanded");
    expect(sidebarStateForViewport(1920)).toBe("expanded");
  });
});

describe("one motion recipe for the panel", () => {
  const motion = read("components/layouts/sidebar/motion.ts");
  const sidebar = read("components/layouts/sidebar/Sidebar.tsx");
  const header = read("components/layouts/AppHeader.tsx");
  const layout = read("components/layouts/AuthenticatedLayout.tsx");

  it("the recipes are the panel's own curve, and honour reduced motion", () => {
    expect(motion).toContain("ease-sidebar");
    expect(motion).toContain("motion-reduce:transition-none");
    expect(motion).toContain("duration-300");
  });

  it("every control in the panel uses the same recipe", () => {
    // The account button used to fall back to the default 150ms curve, so a
    // nav row eased in over 300ms next to a button that snapped.
    expect(sidebar).toContain("SIDEBAR_CONTROL_MOTION");
    expect(header).toContain("SIDEBAR_CONTROL_MOTION");
    expect(layout).toContain("SIDEBAR_LABEL_MOTION");
    expect(header).not.toContain("transition-colors hover:bg-accent");
  });

  it("no control keeps a private transition of its own", () => {
    // A second, hand-written duration in the panel is how they drift apart.
    for (const source of [sidebar, header, layout]) {
      expect(source.match(/duration-150/g) ?? []).toEqual([]);
      expect(source.match(/transition-colors\b/g) ?? []).toEqual([]);
    }
  });

  it("the panel does not repeat the page's name above the navigation", () => {
    // The selected row already says where you are.
    expect(layout).not.toContain("pageTitle");
  });
});

/**
 * The phone is not a small desktop: the things you touch have to be big
 * enough to touch, the things you read have to leave room for the screen,
 * and a panel that scrolls must not drag the page behind it along.
 */
describe("the panel on a phone", () => {
  const sidebar = read("components/layouts/sidebar/Sidebar.tsx");
  const header = read("components/layouts/AppHeader.tsx");
  const table = read("components/ui/Table.tsx");

  it("touch targets are a finger wide", () => {
    // 44px is the smallest target a thumb can hit; the desktop keeps the
    // tighter row, where the pointer does not need the room.
    expect(sidebar).toContain("py-3 pl-3 pr-3");
    expect(sidebar).toContain("sm:py-2");
    expect(header).toContain("h-11");
  });

  it("the panel's own scroll does not drag the page with it", () => {
    expect(sidebar).toContain("overscroll-contain");
  });

  it("the narrow bar is a solid surface, like the panel", () => {
    // A translucent, blurred bar next to a solid floating panel is two
    // visual languages on one screen.
    expect(header).not.toContain("backdrop-blur");
    expect(header).toMatch(/border-b border-border bg-background\b/);
  });

  it("the table gives the phone some of its width back", () => {
    // Four columns on a 375px screen: sixteen pixels of padding per column
    // is sixteen pixels of nothing to read.
    expect(table).toContain("px-3 py-3");
    expect(table).toContain("sm:px-4");
  });
});
