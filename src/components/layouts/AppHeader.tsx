"use client";

import Link from "next/link";
import { LogOut, Menu, Settings, ChevronDown, User } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { logoutAction } from "@/app/(auth)/logout-action";
import { useSidebar } from "./sidebar";
import { useT } from "@/components/i18n/I18nProvider";
import { ThemeToggle } from "./ThemeToggle";

interface AppHeaderProps {
  username: string;
  role: "admin" | "user";
  /** Optional breadcrumb / page title for the header right side. */
  pageTitle?: ReactNode;
}

/**
 * Top app bar — sits above the content area.
 *
 * On mobile, opens the sidebar drawer via the menu button.
 * On desktop, hosts the theme toggle and user dropdown.
 */
export function AppHeader({ username, role, pageTitle }: AppHeaderProps) {
  const t = useT();
  const { toggleSidebar, open, setOpen, isMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-6">
      {/* Mobile menu trigger */}
      <Button
        size="icon"
        variant="ghost"
        className="lg:hidden"
        onClick={() => (isMobile ? setOpen(!open) : toggleSidebar())}
        aria-label={t("nav.toggleSidebar")}
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Brand (mobile only — desktop sidebar has the logo) */}
      <Link href="/" className="font-semibold tracking-tight lg:hidden">
        RelayAB
      </Link>

      {/* Optional page title */}
      {pageTitle && (
        <div className="ml-2 hidden truncate text-sm font-medium text-foreground lg:block">
          {pageTitle}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <UserMenu
          username={username}
          role={role}
          open={menuOpen}
          setOpen={setMenuOpen}
        />
      </div>
    </header>
  );
}

function UserMenu({
  username,
  role,
  open,
  setOpen,
}: {
  username: string;
  role: "admin" | "user";
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden sm:inline">{username}</span>
        <Badge tone={role === "admin" ? "primary" : "neutral"} className="hidden sm:inline-flex">
          {role}
        </Badge>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* Click-outside dismiss */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg animate-slide-down">
            <div className="border-b border-border px-3 py-2.5">
              <p className="text-sm font-medium">{username}</p>
              <p className="text-xs text-muted-foreground">
                {role === "admin" ? t("nav.user.adminBadge") : t("nav.user.userBadge")}
              </p>
            </div>
            <Link
              href={role === "admin" ? "/admin" : "/dashboard/settings"}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
              onClick={() => setOpen(false)}
            >
              <User className="h-4 w-4 text-muted-foreground" />
              {role === "admin" ? t("nav.user.adminPanel") : t("nav.user.profile")}
            </Link>
            {role === "user" && (
              <Link
                href="/dashboard/settings"
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                onClick={() => setOpen(false)}
              >
                <Settings className="h-4 w-4 text-muted-foreground" />
                {t("nav.settings")}
              </Link>
            )}
            <form action={logoutAction}>
              <button
                type="submit"
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/5"
              >
                <LogOut className="h-4 w-4" />
                {t("nav.logout")}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
