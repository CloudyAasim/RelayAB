"use client";

import { cn } from "@/lib/utils";
import { type ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useT } from "@/components/i18n/I18nProvider";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/Tooltip";

/**
 * Sidebar — left rail for the authenticated layout.
 *
 * Responsive breakpoints:
 * - Mobile (< 1024px): slide-in drawer
 * - Desktop (≥ 1024px): persistent rail, collapsible
 *
 * Width:
 * - Mobile drawer: 72 (288px)
 * - Desktop expanded: 64 (256px)
 * - Desktop collapsed: 14 (56px)
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
          "fixed inset-y-0 left-0 z-50 flex w-[288px] flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-300 ease-sidebar motion-reduce:transition-none lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          // Plasma 6's floating panel: on a wide screen the rail lifts off the
          // edge, rounds its corners and casts one soft shadow, so it reads as a
          // panel *above* the page rather than a wall beside it. On a narrow
          // screen there is no room to float, so it docks back to the edge as a
          // drawer — which is what the mobile branch below already does.
          "lg:my-2 lg:ml-2 lg:h-[calc(100vh-1rem)] lg:rounded-lg lg:border lg:border-sidebar-border lg:shadow-float",
          isMobile ? (open ? "translate-x-0 shadow-float" : "-translate-x-full") : "",
          collapsed && "lg:w-14",
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
        "flex h-14 items-center gap-2 border-b border-sidebar-border px-4 transition-[padding] duration-300 ease-sidebar motion-reduce:transition-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SidebarContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex-1 overflow-y-auto px-3 py-4", className)}>{children}</div>;
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
      className="absolute inset-y-0 right-0 hidden w-1 cursor-w-resize items-center justify-center rounded-full bg-transparent transition-colors hover:bg-sidebar-border lg:flex xl:hidden"
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
        "flex shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-[width,height,background-color,color] duration-300 ease-sidebar hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-reduce:transition-none",
        collapsed ? "h-8 w-8" : "h-7 w-7",
        className,
      )}
    >
      {/* Both glyphs stay mounted and crossfade so the affordance swaps
          without a hard cut while the rail is still moving. */}
      <span className="relative flex h-4 w-4 items-center justify-center">
        <PanelLeftOpen
          aria-hidden
          className={cn(
            "absolute h-4 w-4 transition-opacity duration-300 motion-reduce:transition-none",
            collapsed ? "opacity-100" : "opacity-0",
          )}
        />
        <PanelLeftClose
          aria-hidden
          className={cn(
            "absolute h-4 w-4 transition-opacity duration-300 motion-reduce:transition-none",
            collapsed ? "opacity-0" : "opacity-100",
          )}
        />
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
  return <ul className={cn("flex flex-col gap-0.5", className)}>{children}</ul>;
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
    "group flex w-full items-center gap-3 rounded-lg py-2 pl-3 pr-3 text-sm font-medium",
    "transition-[padding,background-color,color] duration-300 ease-sidebar hover:duration-150 motion-reduce:transition-none",
    "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    // The current page is the one row in the rail that carries the accent
    // colour, and it holds it on hover as well - otherwise the row changes
    // colour the moment the pointer lands on it.
    isActive && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
    // Keep the icon next to the rail edge and let the closing rail settle
    // around it, instead of switching to `justify-center` and making the icon
    // jump to the middle of the still-wide button at the start of the collapse.
    collapsed && "gap-0 pl-[7.5px] pr-[7.5px]",
  );

  const content = (
    <>
      {icon && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <span
        className={cn(
          "truncate transition-[max-width,opacity] duration-300 ease-sidebar motion-reduce:transition-none",
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
