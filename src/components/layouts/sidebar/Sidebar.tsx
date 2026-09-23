"use client";

import { cn } from "@/lib/utils";
import { type ReactNode } from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSidebar } from "./SidebarContext";
import { useT } from "@/components/i18n/I18nProvider";

/**
 * Sidebar — left rail for the authenticated layout.
 *
 * Behavior:
 *   - On `lg+` viewports: persistent left rail, collapsible via the icon-only rail.
 *   - On `<lg` viewports: slide-in drawer (controlled by `open`).
 *
 * Width tokens (Tailwind w-*):
 *   - expanded: 16rem (256px)
 *   - collapsed: 3.5rem (56px) — just enough for icons
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
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200 ease-in-out",
          "lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          // Mobile drawer behavior
          isMobile && (open ? "translate-x-0 shadow-xl" : "-translate-x-full"),
          // Desktop collapsible
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
        "flex h-14 items-center gap-2 border-b border-sidebar-border px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SidebarContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex-1 overflow-y-auto px-2 py-2", className)}>{children}</div>;
}

export function SidebarFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "border-t border-sidebar-border px-3 py-3",
        className,
      )}
    >
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
      className="absolute inset-y-0 right-0 hidden w-1.5 translate-x-1/2 cursor-w-resize rounded-full bg-transparent transition-colors hover:bg-sidebar-border lg:block"
    />
  );
}

/**
 * Visible collapse / expand control.
 *
 * `SidebarRail` is the hover strip pinned to the rail's edge — discoverable
 * only if you already know it is there. This is the explicit button. It is a
 * no-op on mobile, where the sidebar is a drawer with its own trigger.
 */
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
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
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
    <div className={cn("px-2 py-1", className)}>
      {/* Hide the group heading in rail mode — there is no room for it,
          and a truncated heading reads worse than none. */}
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
  /** Render the icon when collapsed (otherwise only label is hidden). */
  showIconWhenCollapsed?: boolean;
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
    collapsed && "justify-center",
  );

  const content = (
    <>
      {icon && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <span className={cn("truncate", collapsed && "hidden")}>{children}</span>
    </>
  );

  // In rail mode the label is hidden, so expose it as a native tooltip and
  // to assistive tech via aria-label.
  const collapsedLabel =
    collapsed && typeof children === "string" ? children : undefined;

  if (href) {
    return (
      <Link
        
        href={href}
        className={baseClass}
        aria-current={isActive ? "page" : undefined}
        aria-label={collapsedLabel}
        title={collapsedLabel}
        onClick={() => {
          // On mobile the sidebar is a drawer — close it after navigating.
          if (isMobile) setOpen(false);
        }}
      >
        {content}
      </Link>
    );
  }
  return (
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
}
