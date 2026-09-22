"use client";

/**
 * Site-wide footer.
 *
 * - Single source of truth for project license attribution.
 * - Includes the locale switcher so users can toggle zh-CN ⇄ en.
 * - Uses the design tokens so it follows light/dark mode.
 * - The GitHub link is opt-in via NEXT_PUBLIC_REPOSITORY_URL.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/components/i18n/I18nProvider";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";

/**
 * Routes that own the full viewport (sidebar + header app shell).
 *
 * The footer is appended after the shell by the root layout, so on these
 * routes it stacked *below* a `min-h-screen` shell — making every dashboard
 * page overflow by exactly the footer's height. The app shell has its own
 * status line in the sidebar and the locale switcher now lives in the header,
 * so the footer is simply not part of it.
 */
const APP_ROUTE_PREFIXES = ["/dashboard", "/admin"];

export function Footer() {
  const pathname = usePathname();
  const year = new Date().getFullYear();
  const repoUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim();
  const t = useT();

  if (pathname && APP_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  return (
    <footer className="mt-auto border-t border-border bg-muted/30">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
        <div>
          © {year} CloudyAasim ·{" "}
          <Link
            href="/license"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {t("footer.releasedUnder")}
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <LocaleSwitcher />
          {repoUrl ? (
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {t("footer.sourceCode")} ↗
            </a>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
