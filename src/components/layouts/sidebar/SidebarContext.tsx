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
 * State is persisted in a cookie (`sidebar_state`) so it survives reloads,
 * matching new-api and shadcn/ui defaults.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type SidebarState = "expanded" | "collapsed";

interface SidebarContextValue {
  state: SidebarState;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** True for small viewports where the sidebar should render as a drawer. */
  isMobile: boolean;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const COOKIE_NAME = "relayab_sidebar_state";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * Viewport width at which the expanded rail (256px) still leaves a comfortable
 * content column.
 *
 * `lg` (1024px) is where the rail stops being a drawer, but 1024px minus a
 * 256px rail is too tight to read a table in — so between `lg` and `xl` the
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

function readCookieState(): SidebarState {
  if (typeof document === "undefined") return "expanded";
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m) return "expanded";
  return decodeURIComponent(m[1]) === "collapsed" ? "collapsed" : "expanded";
}

function writeCookieState(state: SidebarState): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=${state}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function SidebarProvider({
  defaultOpen = true,
  children,
}: {
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  // SSR-safe initial state: rely on the prop on the server, the cookie on the client.
  const [state, setState] = useState<SidebarState>(
    defaultOpen ? "expanded" : "collapsed",
  );
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  // After hydration, adopt the cookie value so a reload restores the user's
  // choice. The viewport rule below may override this on the next tick.
  useEffect(() => {
    const cookieState = readCookieState();
    setState(cookieState);
    setOpen(cookieState === "expanded");
  }, []);

  // Fit-to-viewport rule: on load, and whenever the viewport crosses the
  // threshold, pick the layout that actually fits. Within one size class a
  // manual toggle wins — re-applying the rule on every resize event would
  // silently undo the user's choice.
  const fitsRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const evaluate = () => {
      const fits = window.innerWidth >= EXPAND_MIN_VIEWPORT;
      if (fitsRef.current === fits) return;
      fitsRef.current = fits;
      const next = sidebarStateForViewport(window.innerWidth);
      setState(next);
      setOpen(next === "expanded");
      writeCookieState(next);
    };
    evaluate();
    window.addEventListener("resize", evaluate);
    return () => window.removeEventListener("resize", evaluate);
  }, []);

  // Track viewport for the mobile drawer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const toggleSidebar = useCallback(() => {
    setState((prev) => {
      const next: SidebarState = prev === "expanded" ? "collapsed" : "expanded";
      writeCookieState(next);
      setOpen(next === "expanded");
      return next;
    });
  }, []);

  const value = useMemo<SidebarContextValue>(
    () => ({ state, open, setOpen, toggleSidebar, isMobile }),
    [state, open, toggleSidebar, isMobile],
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
