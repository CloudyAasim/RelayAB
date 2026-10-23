"use client";

/**
 * SidebarContext — global state for the collapsible sidebar.
 *
 * Mirrors new-api's `<SidebarProvider>` API:
 *   - `state`         : "expanded" | "collapsed"
 *   - `open`          : boolean — for mobile drawer
 *   - `setOpen`       : setter
 *   - `toggleSidebar` : flips state
 *
 * ## Two rules, and which one wins
 *
 * 1. **What the user chose wins.** Pressing the toggle stores the choice in a
 *    cookie, and that choice survives reloads, full page loads and
 *    cross-segment navigations.
 *
 * 2. **The viewport fills in what the user has not decided.** With no stored
 *    choice, a window too narrow for the full panel gets the icon rail and a
 *    wide one gets the panel.
 *
 * The order matters, and getting it wrong is what produced the bug this file
 * used to have: the viewport rule ran on **every** mount and overwrote the
 * stored choice, so collapsing the rail and reloading brought it straight
 * back. Since switching between route groups triggers a full page load in the
 * App Router, the rail appeared to expand on its own whenever a link crossed
 * that boundary — "sometimes", because only some links do.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type SidebarState = "expanded" | "collapsed";

interface SidebarContextValue {
  state: SidebarState;
  /**
   * True when the rail renders icon-only.
   *
   * Never true on mobile: there the sidebar is a full-width drawer, so it
   * always shows labels even though `state` may be "collapsed" (the viewport
   * rule marks anything under 1280px collapsed).
   */
  collapsed: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** True for small viewports where the sidebar should render as a drawer. */
  isMobile: boolean;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

/**
 * The user's own choice, and only the user's.
 *
 * A separate cookie from the one the viewport rule used to write: that one
 * held the *default* for the current window size, so reading it back as a
 * choice would pin the rail to whatever the window happened to be last time.
 */
const PREF_COOKIE = "relayab_sidebar_pref";
const PREF_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * The server cannot know the window's width, so the panel's width is decided
 * on the client — and it has to be decided **before the first paint**. With a
 * plain effect the browser painted the expanded panel and corrected it a frame
 * later, which is what made the rail look like it changed state by itself.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Viewport width at which the expanded rail (240px) still leaves a comfortable
 * content column.
 *
 * `lg` (1024px) is where the rail stops being a drawer, but 1024px minus a
 * 240px rail is too tight to read a table in — so between `lg` and `xl` the
 * sidebar defaults to collapsed.
 */
const EXPAND_MIN_VIEWPORT = 1280;

/**
 * Which layout a given viewport fits.
 *
 * Exported so the rule can be unit-tested without a browser: below the
 * threshold the expanded rail would squeeze the content column, so the sidebar
 * stays collapsed; at or above it, expanded.
 */
export function sidebarStateForViewport(viewportWidth: number): SidebarState {
  return viewportWidth >= EXPAND_MIN_VIEWPORT ? "expanded" : "collapsed";
}

/** The choice the user made, or null if they have not made one. */
export function readSidebarPreference(): SidebarState | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${PREF_COOKIE}=([^;]+)`));
  if (!m) return null;
  const value = decodeURIComponent(m[1]);
  if (value === "collapsed") return "collapsed";
  if (value === "expanded") return "expanded";
  return null;
}

function writeSidebarPreference(state: SidebarState): void {
  if (typeof document === "undefined") return;
  document.cookie = `${PREF_COOKIE}=${state}; path=/; max-age=${PREF_MAX_AGE}; SameSite=Lax`;
}

export function SidebarProvider({
  defaultOpen = true,
  children,
}: {
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  // SSR-safe initial state: rely on the prop on the server, the client's
  // decision on the client (see below).
  const [state, setState] = useState<SidebarState>(
    defaultOpen ? "expanded" : "collapsed",
  );
  // The drawer always starts shut. It is an overlay, and an overlay that
  // opens by itself covers the page it is meant to sit beside.
  const [open, setOpen] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  // Rule 1 and rule 2, decided once, before anything is painted.
  useIsomorphicLayoutEffect(() => {
    const pref = readSidebarPreference();
    const next = pref ?? sidebarStateForViewport(window.innerWidth);
    setState(next);
  }, []);

  // When the window crosses the threshold the viewport decides again — unless
  // the user has already said what they want.
  const fitsRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const evaluate = () => {
      const fits = window.innerWidth >= EXPAND_MIN_VIEWPORT;
      if (fitsRef.current === fits) return;
      fitsRef.current = fits;
      if (readSidebarPreference()) return;
      setState(sidebarStateForViewport(window.innerWidth));
    };
    evaluate();
    window.addEventListener("resize", evaluate);
    return () => window.removeEventListener("resize", evaluate);
  }, []);

  // Track viewport for the mobile drawer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      const next = mq.matches;
      setIsMobile(next);
      // Entering drawer mode always starts closed — otherwise dragging a
      // desktop window narrower would pop the drawer open over the content.
      if (next) setOpen(false);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const toggleSidebar = useCallback(() => {
    const next: SidebarState = state === "expanded" ? "collapsed" : "expanded";
    writeSidebarPreference(next);
    setState(next);
  }, [state]);

  // Icon-only mode is a desktop concept. The mobile drawer is always the
  // panel's full width, so it keeps its labels even when `state` reads
  // "collapsed".
  const collapsed = state === "collapsed" && !isMobile;

  const value = useMemo<SidebarContextValue>(
    () => ({ state, collapsed, open, setOpen, toggleSidebar, isMobile }),
    [state, collapsed, open, toggleSidebar, isMobile],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used inside a <SidebarProvider>.");
  }
  return ctx;
}
