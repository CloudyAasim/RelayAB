"use client";

/**
 * AuthenticatedLayout — the shell that wraps every logged-in page.
 *
 *   ┌──────────────┬─────────────────────────────────┐
 *   │              │  AppHeader  (theme, user menu)  │
 *   │   Sidebar    ├─────────────────────────────────┤
 *   │   (collapsible)                                  │
 *   │              │       main content (slot)        │
 *   └──────────────┴─────────────────────────────────┘
 *
 * IMPORTANT — render this from a segment layout
 * (`(admin)/admin/layout.tsx`, `(user)/dashboard/layout.tsx`), never from an
 * individual page.
 *
 * App Router keeps a layout mounted while you navigate between its children,
 * but replaces a page's whole subtree. When every page rendered its own shell
 * the sidebar, the header and every effect inside them (matchMedia listeners,
 * cookie reads, collapse animation) were torn down and rebuilt on each click —
 * measured as a full re-mount of the shell DOM on every navigation. Hosting
 * the shell in the layout means a navigation only swaps the content column,
 * and the segment's `loading.tsx` skeleton appears *inside* that column
 * instead of blanking out the navigation.
 *
 * The header title is derived from the active nav entry rather than passed
 * down per page, so pages stay pure content.
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isNavItemActive } from "@/lib/nav";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarRail,
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
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  href: string;
  /** Dictionary key for the sidebar label. */
  labelKey: string;
  /** Dictionary key for the header breadcrumb. Defaults to `labelKey`. */
  titleKey?: string;
  icon: LucideIcon;
  /** Section roots must match exactly (see `isNavItemActive`). */
  exact?: boolean;
}

interface NavSection {
  labelKey: string;
  items: NavItem[];
}

const USER_NAV: NavSection[] = [
  {
    labelKey: "nav.sidebar.workspace",
    items: [
      {
        href: "/dashboard",
        labelKey: "nav.dashboard",
        titleKey: "dashboard.title",
        icon: LayoutDashboard,
        exact: true,
      },
      { href: "/dashboard/docs", labelKey: "nav.docs", titleKey: "docs.title", icon: BookOpen },
      {
        href: "/dashboard/settings",
        labelKey: "nav.settings",
        titleKey: "settings.title",
        icon: Settings,
      },
    ],
  },
];

const ADMIN_NAV: NavSection[] = [
  {
    labelKey: "nav.sidebar.admin",
    items: [
      {
        href: "/admin",
        labelKey: "nav.overview",
        titleKey: "admin.overview.title",
        icon: LayoutDashboard,
        exact: true,
      },
      {
        href: "/admin/users",
        labelKey: "nav.users",
        titleKey: "admin.users.title",
        icon: Users,
      },
      {
        href: "/admin/keys",
        labelKey: "nav.keys",
        titleKey: "admin.keys.title",
        icon: KeyRound,
      },
      {
        href: "/admin/providers",
        labelKey: "nav.providers",
        titleKey: "admin.providers.title",
        icon: Server,
      },
      { href: "/admin/settings", labelKey: "admin.settings.title", icon: Settings },
      { href: "/admin/docs", labelKey: "admin.docs.title", icon: BookOpen },
    ],
  },
  {
    // Admins hold keys of their own too, so the personal dashboard is a real
    // destination for them, not just for regular users.
    labelKey: "nav.sidebar.personal",
    items: [
      {
        href: "/dashboard",
        labelKey: "nav.myDashboard",
        titleKey: "dashboard.title",
        icon: Wallet,
        exact: true,
      },
    ],
  },
  {
    labelKey: "nav.sidebar.reference",
    items: [
      { href: "/dashboard/docs", labelKey: "nav.docs", titleKey: "docs.title", icon: BookOpen },
      {
        href: "/dashboard/settings",
        labelKey: "nav.settings",
        titleKey: "settings.title",
        icon: Settings,
      },
    ],
  },
];

interface AuthenticatedLayoutProps {
  role: "admin" | "user";
  username: string;
  /** Friendly name shown in the user menu; falls back to the username. */
  displayName?: string;
  children: ReactNode;
}

export function AuthenticatedLayout({
  role,
  username,
  displayName,
  children,
}: AuthenticatedLayoutProps) {
  return (
    <SidebarProvider>
      <SidebarShell role={role} username={username} displayName={displayName}>
        {children}
      </SidebarShell>
    </SidebarProvider>
  );
}

function SidebarShell({
  role,
  username,
  displayName,
  children,
}: AuthenticatedLayoutProps) {
  const t = useT();
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  const sections = role === "user" ? USER_NAV : ADMIN_NAV;

  // The header breadcrumb mirrors the sidebar's active entry, so pages never
  // have to thread a title through the server tree.
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
          {sections.map((section, sectionIndex) => (
            <SidebarGroup
              key={`${section.labelKey}-${sectionIndex}`}
              label={t(section.labelKey)}
            >
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        href={item.href}
                        icon={<Icon className="h-4 w-4" />}
                        isActive={isNavItemActive(pathname, item.href, {
                          exact: item.exact,
                        })}
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
          displayName={displayName}
          role={role}
          pageTitle={pageTitle}
        />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </SidebarInset>
    </div>
  );
}
