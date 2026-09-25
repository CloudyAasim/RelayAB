"use client";

/**
 * AuthenticatedLayout — shell for logged-in pages
 * 
 * Responsive:
 * - Mobile (< 1024px): sidebar as drawer, hamburger menu
 * - Desktop (≥ 1024px): persistent sidebar with toggle
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isNavItemActive } from "@/lib/nav";
import { TooltipProvider } from "@/components/ui/Tooltip";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarToggle,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  useSidebar,
} from "./sidebar";
import { AppHeader } from "./AppHeader";
import { useT } from "@/components/i18n/I18nProvider";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  BookOpen,
  KeyRound,
  LayoutDashboard,
  Server,
  Settings,
  Users,
  Activity,
  Wallet,
  FileText,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  href: string;
  labelKey: string;
  titleKey?: string;
  icon: LucideIcon;
  exact?: boolean;
}

interface NavSection {
  labelKey: string;
  items: NavItem[];
}

export const USER_NAV: NavSection[] = [
  {
    labelKey: "nav.sidebar.workspace",
    items: [
      { href: "/dashboard", labelKey: "nav.dashboard", titleKey: "dashboard.title", icon: LayoutDashboard, exact: true },
      { href: "/dashboard/docs", labelKey: "nav.docs", titleKey: "docs.title", icon: BookOpen },
      { href: "/dashboard/settings", labelKey: "nav.settings", titleKey: "settings.title", icon: Settings },
    ],
  },
];

export const ADMIN_NAV: NavSection[] = [
  {
    labelKey: "nav.sidebar.admin",
    items: [
      { href: "/admin", labelKey: "nav.overview", titleKey: "admin.overview.title", icon: LayoutDashboard, exact: true },
      { href: "/admin/users", labelKey: "nav.users", titleKey: "admin.users.title", icon: Users },
      { href: "/admin/keys", labelKey: "nav.keys", titleKey: "admin.keys.title", icon: KeyRound },
      { href: "/admin/providers", labelKey: "nav.providers", titleKey: "admin.providers.title", icon: Server },
      { href: "/admin/settings", labelKey: "admin.settings.title", icon: Settings },
    ],
  },
  {
    labelKey: "nav.sidebar.reference",
    items: [
      { href: "/admin/docs", labelKey: "admin.docs.title", titleKey: "admin.docs.title", icon: BookOpen },
      { href: "/dashboard/docs", labelKey: "nav.userDocs", titleKey: "docs.title", icon: FileText },
    ],
  },
  {
    labelKey: "nav.sidebar.personal",
    items: [
      { href: "/dashboard", labelKey: "nav.myDashboard", titleKey: "dashboard.title", icon: Wallet, exact: true },
      { href: "/dashboard/settings", labelKey: "nav.settings", titleKey: "settings.title", icon: Settings },
    ],
  },
];

interface AuthenticatedLayoutProps {
  role: "admin" | "user";
  username: string;
  displayName?: string;
  children: ReactNode;
}

export function AuthenticatedLayout({ role, username, displayName, children }: AuthenticatedLayoutProps) {
  return (
    <TooltipProvider delayDuration={300}>
    <SidebarProvider>
      <SidebarShell role={role} username={username} displayName={displayName}>
        {children}
      </SidebarShell>
    </SidebarProvider>
    </TooltipProvider>
  );
}

function SidebarShell({ role, username, displayName, children }: AuthenticatedLayoutProps) {
  const t = useT();
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  const sections = role === "user" ? USER_NAV : ADMIN_NAV;

  let pageTitle: string | undefined;
  for (const section of sections) {
    for (const item of section.items) {
      if (isNavItemActive(pathname, item.href, { exact: item.exact })) {
        pageTitle = t(item.titleKey ?? item.labelKey);
        break;
      }
    }
    if (pageTitle) break;
  }

  return (
    <div className="flex min-h-screen w-full flex-1">
      <Sidebar>
        <SidebarHeader className={cn(collapsed && "px-3")}>
          <Link href="/" className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-[height,width] duration-300 ease-sidebar motion-reduce:transition-none",
                // Icon-only rail: match the 32px footprint of the nav items so
                // the brand mark and the menu icons share one vertical axis.
                collapsed ? "h-8 w-8" : "h-7 w-7",
              )}
            >
              <Server className="h-4 w-4" />
            </span>
            {/* Kept mounted and clipped instead of unmounting, so the wordmark
                fades away with the rail rather than blinking out first. */}
            <span
              className={cn(
                "truncate font-semibold tracking-tight transition-[max-width,opacity] duration-300 ease-sidebar motion-reduce:transition-none",
                collapsed ? "max-w-0 opacity-0" : "max-w-[120px] opacity-100 delay-150",
              )}
            >
              RelayAB
            </span>
          </Link>
        </SidebarHeader>

        <SidebarContent>
          {sections.map((section, idx) => (
            <SidebarGroup key={`${section.labelKey}-${idx}`} label={t(section.labelKey)}>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        href={item.href}
                        icon={<Icon className="h-4 w-4" />}
                        isActive={isNavItemActive(pathname, item.href, { exact: item.exact })}
                      >
                        {t(item.labelKey)}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter>
          {/*
           * One row in both states. The status block collapses its own width
           * and opacity while the rail narrows, so the toggle stays pinned to
           * the right edge the whole time and simply ends up centred in the
           * 56px rail — no mid-animation layout switch.
           */}
          <div className={cn("flex items-center justify-between", collapsed ? "gap-0" : "gap-2")}>
            <div
              className={cn(
                "flex items-center gap-2 overflow-hidden text-xs text-muted-foreground transition-[max-width,opacity] duration-300 ease-sidebar motion-reduce:transition-none",
                collapsed ? "max-w-0 opacity-0" : "max-w-[180px] opacity-100 delay-150",
              )}
            >
              <Activity className="h-3.5 w-3.5 shrink-0 text-success" />
              <span className="truncate">{t("nav.sidebar.statusOnline")}</span>
            </div>
            <SidebarToggle />
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <AppHeader username={username} displayName={displayName} role={role} pageTitle={pageTitle} />
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </SidebarInset>
    </div>
  );
}
