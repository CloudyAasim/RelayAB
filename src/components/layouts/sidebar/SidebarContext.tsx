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

  // After hydration, adopt the cookie value so a reload restores the user's choice.
  useEffect(() => {
    const cookieState = readCookieState();
    setState(cookieState);
    setOpen(cookieState === "expanded");
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
