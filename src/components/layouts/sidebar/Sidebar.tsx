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
          "fixed inset-y-0 left-0 z-50 flex w-[288px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200 ease-in-out lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          isMobile ? (open ? "translate-x-0 shadow-xl" : "-translate-x-full") : "",
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
    <div className={cn("flex h-14 items-center gap-2 border-b border-sidebar-border px-4", className)}>
      {children}
    </div>
  );
}

export function SidebarContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex-1 overflow-y-auto px-3 py-3", className)}>{children}</div>;
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
        "flex shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        collapsed ? "h-8 w-8" : "h-7 w-7",
        className,
      )}
    >
      {collapsed ? (
        <PanelLeftOpen className="h-4 w-4" />
      ) : (
        <PanelLeftClose className="h-4 w-4" />
      )}
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
        <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/60">
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
    "group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
    collapsed && "justify-center gap-0 px-2",
  );

  const content = (
    <>
      {icon && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <span className={cn("truncate", collapsed && "hidden")}>{children}</span>
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
