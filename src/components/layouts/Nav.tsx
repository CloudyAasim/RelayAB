"use client";

import Link from "next/link";
import { logoutAction } from "@/app/(auth)/logout-action";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/components/i18n/I18nProvider";

interface NavProps {
  username: string;
  role: "admin" | "user";
}

/**
 * Top navigation bar. Rendered on every authenticated page (dashboard
 * and admin). Shows the role-appropriate links:
 *
 *   user  → Dashboard · Docs · Settings
 *   admin → Overview · Users · Keys · Providers
 *
 * Both roles also see Docs (admin might also want the page to copy the
 * public URL when debugging).
 */
export function Nav({ username, role }: NavProps) {
  const t = useT();
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-semibold tracking-tight text-brand-700">
            RelayAB
          </Link>
          <div className="hidden gap-4 sm:flex">
            {role === "user" && (
              <>
                <Link
                  href="/dashboard"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.dashboard")}
                </Link>
                <Link
                  href="/dashboard/docs"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.docs")}
                </Link>
                <Link
                  href="/dashboard/settings"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.settings")}
                </Link>
              </>
            )}
            {role === "admin" && (
              <>
                <Link
                  href="/admin"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.overview")}
                </Link>
                <Link
                  href="/admin/users"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.users")}
                </Link>
                <Link
                  href="/admin/keys"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.keys")}
                </Link>
                <Link
                  href="/admin/providers"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.providers")}
                </Link>
                <Link
                  href="/dashboard/docs"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  {t("nav.docs")}
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-600">{username}</span>
          <Badge tone={role === "admin" ? "purple" : "slate"}>{role}</Badge>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              {t("nav.logout")}
            </button>
          </form>
        </div>
      </nav>
    </header>
  );
}
