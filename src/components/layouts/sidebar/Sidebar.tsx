"use client";

import { cn } from "@/lib/utils";
import { type ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSidebar } from "./SidebarContext";
import {
  SIDEBAR_CONTROL_MOTION,
  SIDEBAR_FADE_MOTION,
  SIDEBAR_LABEL_MOTION,
} from "./motion";
import { useT } from "@/components/i18n/I18nProvider";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/Tooltip";

/**
 * Sidebar — left rail for the authenticated layout.
 *
 * Responsive breakpoints:
 * - Mobile (< 1024px): the same panel, as an overlay drawer
 * - Desktop (≥ 1024px): persistent rail, collapsible
 *
 * Width:
 * - Mobile drawer: 240 (240px)
 * - Desktop expanded: 240 (240px)
 * - Desktop collapsed: 64 (64px)
 *
 * The two desktop widths are **not** two arbitrary numbers: the collapsed rail
 * is exactly what the expanded panel's left edge needs — 16px of margin, the
 * 32px control column, 16px of margin — so that every icon in the rail (the
 * brand mark, the nav items, the account and the collapse toggle) sits on the
 * same vertical axis whether the panel is open or shut.
 *
 * The drawer is the same object as the desktop panel: same width, same rounded
 * corners, same shadow, same interior. It is only an overlay.
 */
export function Sidebar({ children }: { children: ReactNode }) {
  const { collapsed, open, setOpen, isMobile } = useSidebar();

  return (
    <>
      {/* Backdrop for mobile drawer */}
      {isMobile && open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        aria-label="Sidebar navigation"
        data-state={collapsed ? "collapsed" : "expanded"}
        className={cn(
          // Mobile: the same floating panel as the desktop, only as an overlay.
          // It does not get its own shape — one object, two presentations.
          "fixed left-0 top-2 bottom-2 z-50 ml-2 flex w-[240px] flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-float transition-[width,transform] duration-300 ease-sidebar motion-reduce:transition-none lg:sticky lg:bottom-auto lg:h-[calc(100vh-1rem)] lg:my-2 lg:translate-x-0",
          // Two load-bearing details for the desktop rail:
          //
          //   `lg:top-2` — a sticky box is placed by its **border box**, so
          //   `top: 0` would park the panel flush against the top of the
          //   viewport the moment it stuck and the 8px margin would be gone
          //   (measured: the brand mark sat at y=12 instead of y=20). The
          //   inset carries the gap instead, so the panel keeps it whether it
          //   is scrolling or not.
          //
          //   `lg:bottom-auto` — `inset-y-0` (from the mobile drawer's
          //   `fixed`) leaves `bottom: 0` in force, and a sticky box pinned by
          //   **both** edges cannot move: it has to fit inside the scrollport,
          //   so the whole panel scrolled with the page instead of staying
          //   put. Releasing the bottom edge lets `top` alone govern.
          //
          // Closed on mobile: slide the whole panel off the left edge
          // **including** the 8px it stands off it, or 8px of it would stay
          // on screen.
          //
          // The sign belongs INSIDE the brackets. A negative modifier
          // (`-translate-x-…`) applied to an already-negative value does not
          // cancel out — it multiplies by -1, and the closed drawer slid
          // *right*, into the middle of the screen on top of the content,
          // instead of off the left edge. `translate-x-[-50%]` in
          // ui/Modal.tsx has the same shape and is right for the same reason.
          isMobile
            ? open
              ? "translate-x-0"
              : "translate-x-[calc(-100%_-_0.5rem)]"
            : "",
          collapsed && "lg:w-[64px]",
        )}
      >
        {children}
      </aside>
    </>
  );
}

export function SidebarHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-2 border-b border-sidebar-border px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SidebarContent({ children, className }: { children: ReactNode; className?: string }) {
  const { collapsed } = useSidebar();
  return (
    <div
      className={cn(
        // `overscroll-contain`: the panel's list scrolls on its own, and
        // reaching its end must not start scrolling the page behind it — on a
        // phone the two scrolls chain and the page slides away under the
        // panel.
        "flex-1 overflow-y-auto overscroll-contain px-3 py-4",
        // In the icon rail the scrollbar would eat the right-hand side of the
        // item column: the 6px it takes off the content box made the selected
        // row's highlight 34px instead of 40px, and it ended up touching the
        // scrollbar track with the icon no longer centred inside it. With no
        // right padding the scrollbar moves out to the panel's own edge and
        // the item column keeps its width — before and after the scrollbar
        // appears.
        collapsed && "pr-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SidebarFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("border-t border-sidebar-border px-3 py-3", className)}>
      {children}
    </div>
  );
}

export function SidebarRail() {
  const { toggleSidebar, isMobile } = useSidebar();
  if (isMobile) return null;
  return (
    <button
      type="button"
      aria-label="Toggle sidebar"
      onClick={toggleSidebar}
      className={cn(
        "absolute inset-y-0 right-0 hidden w-1 cursor-w-resize items-center justify-center rounded-full bg-transparent",
        SIDEBAR_CONTROL_MOTION,
        "hover:bg-sidebar-border lg:flex xl:hidden",
      )}
    />
  );
}

export function SidebarToggle({ className }: { className?: string }) {
  const { collapsed, toggleSidebar, isMobile } = useSidebar();
  const t = useT();

  if (isMobile) return null;

  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={t("nav.toggleSidebar")}
      aria-expanded={!collapsed}
      title={t("nav.toggleSidebar")}
      className={cn(
        // The icon rail has room for the glyph alone. The open panel spells
        // out what the button does, like every other button down there —
        // a bare glyph next to a labelled account button reads as an
        // afterthought.
        //
        // The width follows the nav items: the same column in the open panel
        // (`w-full`) and the same 40px in the icon rail (`w-10`). Two
        // narrower buttons at the foot of a column of full-width rows is
        // what made the panel look like it was assembled from two pieces.
        //
        // The icon stays at the **left** in both states (`pl-3`, no
        // `justify-center`): centring it made it jump to the middle of the
        // still-wide button the moment the rail started to close, and then
        // slide back — the button tore itself in half on the way down.
        "flex shrink-0 items-center rounded-lg text-sidebar-foreground/70",
        SIDEBAR_CONTROL_MOTION,
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        collapsed ? "h-8 w-10 pl-3" : "h-8 w-full gap-3 pl-3 pr-2.5 text-sm font-medium",
        className,
      )}
    >
      {/* Both glyphs stay mounted and crossfade so the affordance swaps
          without a hard cut while the rail is still moving. */}
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <PanelLeftOpen
          aria-hidden
          className={cn(
            "absolute h-4 w-4",
            SIDEBAR_FADE_MOTION,
            collapsed ? "opacity-100" : "opacity-0",
          )}
        />
        <PanelLeftClose
          aria-hidden
          className={cn(
            "absolute h-4 w-4",
            SIDEBAR_FADE_MOTION,
            collapsed ? "opacity-0" : "opacity-100",
          )}
        />
      </span>
      {/* The label fades with the rail instead of blinking out of existence,
          the same way the nav labels and the brand wordmark do. */}
      <span
        className={cn(
          "truncate",
          SIDEBAR_LABEL_MOTION,
          collapsed ? "max-w-0 opacity-0" : "max-w-[120px] opacity-100 delay-150",
        )}
      >
        {t("nav.sidebar.collapse")}
      </span>
    </button>
  );
}
export function SidebarInset({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-background">{children}</div>;
}

export function SidebarGroup({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  const { collapsed } = useSidebar();
  return (
    <div className={cn("py-1", className)}>
      {label && !collapsed && (
        <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

export function SidebarMenu({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("flex flex-col gap-1 sm:gap-0.5", className)}>{children}</ul>;
}

export function SidebarMenuItem({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

interface SidebarMenuButtonProps {
  href?: string;
  isActive?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
  children: ReactNode;
}

export function SidebarMenuButton({
  href,
  isActive,
  onClick,
  icon,
  children,
}: SidebarMenuButtonProps) {
  const { collapsed, isMobile, setOpen } = useSidebar();
  const baseClass = cn(
    // 44px tall on a phone — a finger needs that — and the tighter row the
    // desktop keeps, where the pointer does not.
    "group flex w-full items-center gap-3 rounded-lg py-3 pl-3 pr-3 text-sm font-medium sm:py-2",
    SIDEBAR_CONTROL_MOTION,
    "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    // The current page is the one row in the rail that carries the accent
    // colour, and it holds it on hover as well - otherwise the row changes
    // colour the moment the pointer lands on it.
    isActive && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
    // The icon stays exactly where it is when the rail narrows: the panel
    // shrinks, the label is clipped, the icon does not move. Only the gap
    // behind the clipped label goes away.
    //
    // `w-10` instead of `w-full` in the icon rail: a fixed 40px row, so the
    // highlight keeps its width (and keeps the icon centred inside it) even
    // when a scrollbar shows up next to it.
    collapsed && "w-10 gap-0",
  );

  const content = (
    <>
      {icon && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <span
        className={cn(
          "truncate",
          SIDEBAR_LABEL_MOTION,
          collapsed ? "max-w-0 opacity-0" : "max-w-[180px] opacity-100 delay-150",
        )}
      >
        {children}
      </span>
      {/* The icon-only rail has no room for a second element; a pending
          indicator here would push the icon off-centre and overflow the
          32px button. The active state still updates once navigation lands. */}
      {href && !collapsed && <LinkPendingIndicator />}
    </>
  );

  const collapsedLabel = collapsed && typeof children === "string" ? children : undefined;

  const triggerButton = href ? (
    <Link
      href={href}
      className={baseClass}
      aria-current={isActive ? "page" : undefined}
      aria-label={collapsedLabel}
      title={collapsedLabel}
      onClick={() => {
        if (isMobile) setOpen(false);
      }}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className={baseClass}
      aria-current={isActive ? "page" : undefined}
      aria-label={collapsedLabel}
      title={collapsedLabel}
    >
      {content}
    </button>
  );

  // Show Radix Tooltip in collapsed icon-only mode (desktop only) for keyboard users.
  if (collapsed && !isMobile && collapsedLabel) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {collapsedLabel}
        </TooltipContent>
      </Tooltip>
    );
  }

  return triggerButton;
}
function LinkPendingIndicator() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2 aria-hidden className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin opacity-70" />;
}
