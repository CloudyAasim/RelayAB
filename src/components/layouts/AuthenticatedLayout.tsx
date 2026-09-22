"use client";

/**
 * AuthenticatedLayout — the shell that wraps every logged-in page.
 *
 * Layout:
 *   ┌──────────────┬─────────────────────────────────┐
 *   │              │  AppHeader  (theme, user menu)  │
 *   │   Sidebar    ├─────────────────────────────────┤
 *   │   (collapsible)                                  │
 *   │              │       main content (slot)        │
 *   └──────────────┴─────────────────────────────────┘
 *
 * On `<lg` viewports the sidebar collapses into a drawer triggered by the
 * hamburger in the AppHeader.
 *
 * The sidebar links are role-aware: admin sees admin entries, regular user
 * sees personal entries.
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarRail, SidebarToggle, SidebarGroup, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarInset, useSidebar } from "./sidebar";
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
} from "lucide-react";

interface AuthenticatedLayoutProps {
  role: "admin" | "user";
  username: string;
  /** Optional page title for the top bar breadcrumb. */
  pageTitle?: ReactNode;
  children: ReactNode;
}

export function AuthenticatedLayout({
  role,
  username,
  pageTitle,
  children,
}: AuthenticatedLayoutProps) {
  return (
    <SidebarProvider>
      <SidebarShell role={role} username={username} pageTitle={pageTitle}>
        {children}
      </SidebarShell>
    </SidebarProvider>
  );
}

function SidebarShell({
  role,
  username,
  pageTitle,
  children,
}: AuthenticatedLayoutProps) {
  const t = useT();
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/");

  return (
    // Sidebar + content must sit side-by-side, so wrap them in a flex-row.
    // On mobile the sidebar is `fixed` so it leaves the flow; the flex-row
    // container then just holds the inset full-width.
    <div className="flex min-h-screen w-full flex-1">
      <Sidebar>
        <SidebarHeader className={cn(collapsed && "justify-center")}>
          <Link href="/" className="flex min-w-0 items-center gap-2">
            {/* Scales proportionally with the rail: both axes shrink together
                (h-5 w-5 keeps the square), and the mark stays slightly larger
                than the 16px menu icons below it. */}
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-[height,width] duration-200 ease-in-out",
                collapsed ? "h-5 w-5" : "h-7 w-7",
              )}
            >
              <Server
                className={cn(
                  "transition-[height,width] duration-200 ease-in-out",
                  collapsed ? "h-3 w-3" : "h-4 w-4",
                )}
              />
            </span>
            {!collapsed && (
              <span className="truncate font-semibold tracking-tight">RelayAB</span>
            )}
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {role === "user" ? (
            <SidebarGroup label={t("nav.sidebar.workspace")}>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} isActive={isActive("/dashboard")}>
                    {t("nav.dashboard")}
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton href="/dashboard/docs" icon={<BookOpen className="h-4 w-4" />} isActive={isActive("/dashboard/docs")}>
                    {t("nav.docs")}
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton href="/dashboard/settings" icon={<Settings className="h-4 w-4" />} isActive={isActive("/dashboard/settings")}>
                    {t("nav.settings")}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          ) : (
            <>
              <SidebarGroup label={t("nav.sidebar.admin")}>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/admin" icon={<LayoutDashboard className="h-4 w-4" />} isActive={pathname === "/admin"}>
                      {t("nav.overview")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/admin/users" icon={<Users className="h-4 w-4" />} isActive={isActive("/admin/users")}>
                      {t("nav.users")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/admin/keys" icon={<KeyRound className="h-4 w-4" />} isActive={isActive("/admin/keys")}>
                      {t("nav.keys")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/admin/providers" icon={<Server className="h-4 w-4" />} isActive={isActive("/admin/providers")}>
                      {t("nav.providers")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/admin/settings" icon={<Settings className="h-4 w-4" />} isActive={isActive("/admin/settings")}>
                      {t("admin.settings.title")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/admin/docs" icon={<BookOpen className="h-4 w-4" />} isActive={isActive("/admin/docs")}>
                      {t("admin.docs.title")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
              {/* Admins hold keys of their own too, so the personal
                  dashboard is a real destination for them, not just for
                  regular users. */}
              <SidebarGroup label={t("nav.sidebar.personal")}>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      href="/dashboard"
                      icon={<Wallet className="h-4 w-4" />}
                      isActive={pathname === "/dashboard"}
                    >
                      {t("nav.myDashboard")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
              <SidebarGroup label={t("nav.sidebar.reference")}>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/dashboard/docs" icon={<BookOpen className="h-4 w-4" />} isActive={isActive("/dashboard/docs")}>
                      {t("nav.docs")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton href="/dashboard/settings" icon={<Settings className="h-4 w-4" />} isActive={isActive("/dashboard/settings")}>
                      {t("nav.settings")}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            </>
          )}
        </SidebarContent>
        <SidebarFooter>
          <div
            className={cn(
              "flex items-center gap-2",
              collapsed ? "flex-col" : "justify-between",
            )}
          >
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Activity className="h-3.5 w-3.5 shrink-0 text-success" />
              {/* The rail has no room for the label — keep the status dot. */}
              {!collapsed && (
                <span className="truncate">{t("nav.sidebar.statusOnline")}</span>
              )}
            </div>
            <SidebarToggle />
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <AppHeader
          username={username}
          role={role}
          pageTitle={pageTitle}
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </SidebarInset>
    </div>
  );
}
