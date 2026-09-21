"use client";

/**
 * ThemeToggle — system / light / dark switcher in the app header.
 *
 * Backed by `next-themes`. Persists choice in localStorage and applies
 * the `dark` class to <html>, which swaps all `bg-card` / `text-foreground`
 * / etc. utility classes via the CSS variables in globals.css.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const t = useT();

  // Avoid hydration mismatch: until mounted, render a neutral placeholder
  // so SSR and client output the same DOM.
  useEffect(() => setMounted(true), []);

  const cycle = () => {
    const order: Array<"system" | "light" | "dark"> = ["system", "light", "dark"];
    const next = order[(order.indexOf((theme as typeof order[number]) ?? "system") + 1) % order.length];
    setTheme(next);
  };

  // SSR placeholder
  if (!mounted) {
    return (
      <Button size="icon" variant="ghost" aria-label={t("theme.toggle")}>
        <Sun className="h-4 w-4" />
      </Button>
    );
  }

  const icon =
    theme === "system" ? (
      <Monitor className="h-4 w-4" />
    ) : resolvedTheme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Sun className="h-4 w-4" />
    );

  const label =
    theme === "system"
      ? t("theme.system")
      : theme === "dark"
        ? t("theme.dark")
        : t("theme.light");

  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={cycle}
      aria-label={`${t("theme.toggle")} (${label})`}
      title={`${t("theme.toggle")} (${label})`}
    >
      {icon}
    </Button>
  );
}
