"use client";

import Link from "next/link";
import { LogOut, Menu, Settings, ChevronDown, LayoutDashboard, Palette } from "lucide-react";
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
}

/**
 * AppHeader — the bar for **narrow screens only**.
 *
 * On a wide screen there is no bar any more: the top bar's contents (the
 * brand, the page's name, the language, the theme and the account) live in the
 * floating side panel, which is the one piece of chrome the layout has. A
 * full-width bar above a floating panel was the thing that made the two look
 * like two different applications.
 *
 * On a narrow screen the panel is a drawer, so the page needs its own way
 * back to it — that is all this bar is: the drawer button, the name, and the
 * account menu.
 */
export function AppHeader({ username, displayName, role }: AppHeaderProps) {
  const t = useT();
  const { open, setOpen, isMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6 lg:hidden">
      {isMobile && (
        <Button
          size="icon"
          variant="ghost"
          className="rounded-lg"
          onClick={() => setOpen(!open)}
          aria-label={t("nav.toggleSidebar")}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}

      <Link href="/" className="font-semibold tracking-tight text-foreground">
        RelayAB
      </Link>

      <div className="ml-auto flex items-center gap-1">
        <UserMenu username={username} displayName={displayName} role={role} />
      </div>
    </header>
  );
}

/**
 * The account menu: who you are, how the deployment looks, and the way out.
 *
 * **Appearance lives in here** — the theme and the language are settings of
 * *this* person, not of the deployment, and the panel that holds them is the
 * floating one, so the menu is where they belong. The menu owns its own open
 * state, which is what lets the same component sit in the panel and in the
 * narrow-screen bar without the two fighting over one flag.
 */
export function UserMenu({
  username,
  displayName,
  role,
}: {
  username: string;
  displayName?: string;
  role: "admin" | "user";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = displayName?.trim() || username;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("nav.user.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
          <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-border bg-popover text-popover-foreground shadow-float animate-slide-down">
            <div className="border-b border-border px-4 py-3">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">
                @{username} · {role === "admin" ? t("nav.user.adminBadge") : t("nav.user.userBadge")}
              </p>
            </div>

            {/*
              How this deployment looks. Two settings, both about *this*
              browser, so they ride along with the account rather than with
              the page.
            */}
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Palette className="h-4 w-4" />
                {t("theme.toggle")}
              </span>
              <ThemeToggle />
            </div>
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="text-sm text-muted-foreground">{t("footer.language")}</span>
              <LocaleSwitcher />
            </div>

            {role === "admin" && (
              <Link
                href="/admin"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => setOpen(false)}
              >
                <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                {t("nav.user.adminPanel")}
              </Link>
            )}
            <Link
              href="/dashboard/settings"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => setOpen(false)}
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
              {t("nav.user.accountSettings")}
            </Link>
            <form action={logoutAction}>
              <button
                type="submit"
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
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
