"use client";

import Link from "next/link";
import { LogOut, Menu, Settings, ChevronDown, LayoutDashboard, Palette } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SIDEBAR_CONTROL_MOTION } from "./sidebar";
import { cn } from "@/lib/utils";
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
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-4 sm:px-6 lg:hidden">
      {isMobile && (
        <Button
          size="icon"
          variant="ghost"
          className={cn("rounded-lg", SIDEBAR_CONTROL_MOTION, "h-11 w-11 sm:h-10 sm:w-10")}
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
  variant = "full",
}: {
  username: string;
  displayName?: string;
  role: "admin" | "user";
  /**
   * How much room the trigger has.
   *
   * - `full`  — avatar, name, role badge, chevron. The narrow-screen bar,
   *              which is as wide as the screen.
   * - `panel` — avatar, name, chevron. The floating panel's footer: the
   *              panel is 240px, and spelling the name out next to the role
   *              badge is what used to cut the wordmark down to "R…".
   * - `mini`  — the avatar alone. The 64px icon rail has room for nothing
   *              else.
   */
  variant?: "full" | "panel" | "mini";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = displayName?.trim() || username;
  return (
    /*
     * A Radix popover, not an absolutely positioned div.
     *
     * The panel clips its own overflow (`overflow-hidden`), so a menu drawn
     * inside it would be cut off at the panel's edge — and in the 64px rail
     * there is no room for it at all. The popover renders through a portal,
     * which is the only reason the account menu works from the narrow rail.
     */
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("nav.user.menu")}
          className={cn(
            "rounded-lg border border-border bg-card text-sm font-medium text-foreground",
            SIDEBAR_CONTROL_MOTION,
            "hover:bg-accent hover:text-accent-foreground",
            // The panel's footer is a column of rows, and these two sit in it
            // like the nav items above: the same width in the open panel
            // (`w-full`) and the same 40px in the icon rail (`w-10`).
            // The avatar stays at the **left** in both variants: centring it in
            // the narrow one made it jump to the middle of the still-wide
            // button the moment the rail started to close, and then slide
            // back. `pl-2` puts the 24px avatar exactly in the middle of the
            // 40px square anyway.
            variant === "mini"
              ? "flex h-8 w-10 items-center justify-start pl-2"
              : variant === "panel"
                ? "flex h-11 w-full items-center gap-2 pl-2 pr-2.5 sm:h-8"
                : "inline-flex h-11 items-center gap-2 px-2.5 sm:h-9",
          )}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {username.slice(0, 1).toUpperCase()}
          </span>
          {variant !== "mini" && (
            <span className={variant === "panel" ? "truncate" : "hidden sm:inline"}>{username}</span>
          )}
          {variant !== "mini" && (
            <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side={variant === "mini" ? "top" : "bottom"}
        align={variant === "mini" ? "start" : "end"}
        sideOffset={8}
        className="w-56 p-0"
      >
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
      </PopoverContent>
    </Popover>
  );
}
