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
  SIDEBAR_LABEL_MOTION,
} from "./sidebar";
import { AppHeader, UserMenu } from "./AppHeader";
import { useT } from "@/components/i18n/I18nProvider";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  BarChart3,
  BookOpen,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Server,
  Settings,
  Users,
  Wallet,
  FileText,
  FlaskConical,
  Sparkles,
  Search,
  type LucideIcon,
} from "lucide-react";

/**
 * Pages whose content manages its own edges against the viewport.
 *
 * The assistant is the only one: it is a single full-height column with a
 * composer pinned to the bottom, so the shell's padding is in the way and the
 * height arithmetic has to account for the app header and nothing else.
 */
const EDGE_TO_EDGE_ROUTES = new Set(["/dashboard/assistant"]);

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
      { href: "/dashboard/usage", labelKey: "nav.usage", titleKey: "usage.title", icon: BarChart3 },
      { href: "/dashboard/models", labelKey: "nav.models", titleKey: "dashboard.models.title", icon: FlaskConical },
      { href: "/dashboard/assistant", labelKey: "nav.assistant", titleKey: "assistant.title", icon: Sparkles },
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
      { href: "/admin/usage", labelKey: "nav.usage", titleKey: "usage.title", icon: BarChart3 },
      { href: "/admin/media-providers", labelKey: "nav.mediaProviders", titleKey: "admin.mediaProviders.title", icon: ImageIcon },
      { href: "/admin/search", labelKey: "nav.searchProviders", titleKey: "admin.searchProviders.title", icon: Search },
      { href: "/admin/providers", labelKey: "nav.providers", titleKey: "admin.providers.title", icon: Server },
      // Its own page, at the same level: it is a list over every model the
      // deployment serves, not another field of the system settings.
      { href: "/admin/model-notes", labelKey: "admin.modelNotes.nav", titleKey: "admin.modelNotes.title", icon: FileText },
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
      { href: "/dashboard/usage", labelKey: "nav.usage", titleKey: "usage.title", icon: BarChart3 },
      { href: "/dashboard/models", labelKey: "nav.models", titleKey: "dashboard.models.title", icon: FlaskConical },
      { href: "/dashboard/assistant", labelKey: "nav.assistant", titleKey: "assistant.title", icon: Sparkles },
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

  return (
    <div className="flex min-h-screen w-full flex-1">
      {/*
        One panel, not a bar and a rail.

        The top bar used to span the full width above a floating side panel,
        and the two never quite agreed: the bar was a different shape, a
        different surface and a different edge. Everything the bar carried —
        the brand, the page's name, the language, the theme and the account —
        now lives in the panel, so the layout is one object instead of two.
      */}
      <Sidebar>
        <SidebarHeader>
          <Link href="/" className="flex min-w-0 items-center gap-2">
            {/* 32×32 in both states: the brand mark never changes size or
                position when the panel opens or shuts. */}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Server className="h-4 w-4" />
            </span>
            {/* Kept mounted and clipped instead of unmounting, so the wordmark
                fades away with the rail rather than blinking out first. */}
            <span
              className={cn(
                "truncate font-semibold tracking-tight",
                SIDEBAR_LABEL_MOTION,
                collapsed ? "max-w-0 opacity-0" : "max-w-[120px] opacity-100 delay-150",
              )}
            >
              RelayAB
            </span>
          </Link>
          {/*
            The account used to sit in this corner — and move down to the
            bottom only once the rail shut, which was the one place where the
            two states disagreed. It now lives in the footer in **both** of
            them, so the top of the panel is only the brand.
          */}
        </SidebarHeader>

        <SidebarContent>
          {/*
            No page name here.

            The panel used to repeat the current page's name above the
            navigation — "概览" over a list whose top row was also "概览",
            with that row highlighted. The selected row already says where you
            are; saying it twice is how a panel ends up looking like it was
            assembled from two pieces.
          */}
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
           * One column, always — open panel or icon rail.
           *
           * Two lines: the account and the collapse toggle. The account is
           * the line that used to move: it lived in the panel's top-right
           * corner and dropped to the bottom only when the rail shut. Now it
           * has one home, and nothing in the panel changes place between the
           * two states.
           */}
          <div className="flex flex-col items-start gap-1">
            {/* The account, in its permanent home. In the icon rail it shrinks
                to the bare avatar, because 64px has no room for a name. */}
            <UserMenu
              username={username}
              displayName={displayName}
              role={role}
              variant={collapsed ? "mini" : "panel"}
            />
            <SidebarToggle />
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <AppHeader username={username} displayName={displayName} role={role} />
        {/*
          The assistant owns the whole viewport, and the padding has to go on
          *this* element rather than be cancelled by the chat with negative
          margins. A child that reaches outside its parent is clipped here —
          SectionPageLayout renders the page body in an `overflow-hidden` box —
          so pulling the chat outwards with `-mx-*` cut its top bar and composer
          off at the edges. It looked fine on a desktop only because the centred
          reading column left enough slack to absorb the overflow, and only
          broke once the column was the full width of a phone.

          Dropping the padding here achieves the same edge-to-edge result with
          nothing outside the box, so there is nothing to clip.
        */}
        <main
          className={
            EDGE_TO_EDGE_ROUTES.has(pathname) ? "flex-1" : "flex-1 p-4 sm:p-6 lg:p-8"
          }
        >
          {children}
        </main>
      </SidebarInset>
    </div>
  );
}
