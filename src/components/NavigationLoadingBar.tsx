"use client";

/**
 * NavigationLoadingBar — top-of-viewport progress bar for client navigations.
 *
 * Why this doesn't use route-change events: the App Router does not emit any.
 * The previous implementation listened for `next-route-change-start` /
 * `next-route-change-complete`, which nothing ever dispatches, so the bar
 * never appeared and slow navigations looked like a dead connection.
 *
 * Instead we detect the start of a navigation ourselves — a plain left click
 * on a same-origin link (capture phase, before React's own handler) or a
 * back/forward `popstate` — and finish when `usePathname()` actually changes.
 * That covers every navigation this app performs, including the server-action
 * redirects that come back as a route change.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n/I18nProvider";

/** Keep the bar on screen long enough to be perceived, so quick navigations
 *  don't produce a distracting flicker. */
const MIN_VISIBLE_MS = 300;
/** Never leave a stuck bar if a navigation is aborted. */
const SAFETY_MS = 15_000;
const FADE_MS = 240;

type Phase = "idle" | "loading" | "leaving";

export function NavigationLoadingBar() {
  const t = useT();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");

  // The effect below owns the timers; `finishRef` lets the pathname effect
  // trigger the same completion path without re-subscribing listeners.
  const finishRef = useRef<() => void>(() => {});

  useEffect(() => {
    let startedAt = 0;
    let safetyTimer: number | undefined;
    let fadeTimer: number | undefined;

    const finish = () => {
      if (!startedAt) return;
      const elapsed = Date.now() - startedAt;
      startedAt = 0;
      window.clearTimeout(safetyTimer);
      window.clearTimeout(fadeTimer);
      fadeTimer = window.setTimeout(() => {
        setPhase("leaving");
        fadeTimer = window.setTimeout(() => setPhase("idle"), FADE_MS);
      }, Math.max(0, MIN_VISIBLE_MS - elapsed));
    };
    finishRef.current = finish;

    const begin = () => {
      // A second click while already loading just restarts the clock.
      window.clearTimeout(safetyTimer);
      window.clearTimeout(fadeTimer);
      startedAt = Date.now();
      setPhase("loading");
      safetyTimer = window.setTimeout(finish, SAFETY_MS);
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a[href]") as
        | HTMLAnchorElement
        | null
        | undefined;
      if (!anchor) return;
      if (anchor.hasAttribute("download")) return;
      const target = anchor.getAttribute("target");
      if (target && target !== "_self") return;

      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same path + query means Next will not navigate anywhere.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }
      begin();
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", begin);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", begin);
      window.clearTimeout(safetyTimer);
      window.clearTimeout(fadeTimer);
    };
  }, []);

  // The router committed a new route: the pending request is done.
  useEffect(() => {
    finishRef.current();
  }, [pathname]);

  if (phase === "idle") return null;

  return (
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed inset-x-0 top-0 z-[9999] h-0.5 transition-opacity duration-200",
          phase === "leaving" ? "opacity-0" : "opacity-100",
        )}
      >
        <div
          className="h-full bg-primary shadow-[0_0_8px] shadow-primary/60 transition-[width] ease-out"
          style={{
            width: phase === "loading" ? "85%" : "100%",
            transitionDuration: phase === "loading" ? "8000ms" : "180ms",
          }}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {t("common.loading")}
      </span>
    </>
  );
}
