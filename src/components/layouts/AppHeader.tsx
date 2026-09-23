"use client";

import Link from "next/link";
import { LogOut, Menu, Settings, ChevronDown, LayoutDashboard } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { logoutAction } from "@/app/(auth)/logout-action";
import { useSidebar } from "./sidebar";
import { useT } from "@/components/i18n/I18nProvider";
import { ThemeToggle } from "./ThemeToggle";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";

interface AppHeaderProps {
  username: string;
  displayName?: string;
  role: "admin" | "user";
  pageTitle?: ReactNode;
}

/**
 * AppHeader — top navigation bar
 * Responsive: compact on mobile, spacious on desktop
 */
export function AppHeader({ username, displayName, role, pageTitle }: AppHeaderProps) {
  const t = useT();
  const { toggleSidebar, open, setOpen, isMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-6">
      {/* Mobile menu trigger */}
      <Button
        size="icon"
        variant="ghost"
        className="hidden lg:flex"
        onClick={() => toggleSidebar()}
        aria-label={t("nav.toggleSidebar")}
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Mobile sidebar trigger */}
      {isMobile && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setOpen(!open)}
          aria-label={t("nav.toggleSidebar")}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {/* Brand on mobile */}
      <Link href="/" className="font-semibold tracking-tight lg:hidden">
        RelayAB
      </Link>

      {/* Page title on larger screens */}
      {pageTitle && (
        <div className="ml-2 hidden truncate text-sm font-medium text-foreground xl:block">
          {pageTitle}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <LocaleSwitcher />
        <ThemeToggle />
        <UserMenu
          username={username}
          displayName={displayName}
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
  displayName,
  role,
  open,
  setOpen,
}: {
  username: string;
  displayName?: string;
  role: "admin" | "user";
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const t = useT();
  const name = displayName?.trim() || username;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("nav.user.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden sm:inline">{username}</span>
        <Badge tone={role === "admin" ? "primary" : "neutral"} className="hidden md:inline-flex">
          {role}
        </Badge>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg animate-slide-down">
            <div className="border-b border-border px-3 py-2.5">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">
                @{username} · {role === "admin" ? t("nav.user.adminBadge") : t("nav.user.userBadge")}
              </p>
            </div>
            {role === "admin" && (
              <Link
                href="/admin"
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                onClick={() => setOpen(false)}
              >
                <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                {t("nav.user.adminPanel")}
              </Link>
            )}
            <Link
              href="/dashboard/settings"
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
              onClick={() => setOpen(false)}
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
              {t("nav.user.accountSettings")}
            </Link>
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
