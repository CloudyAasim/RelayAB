"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { useT } from "@/components/i18n/I18nProvider";
import { ThemeToggle } from "@/components/layouts/ThemeToggle";
import { Server, Lock, User as UserIcon, ArrowRight, Home } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? t("login.failed"));
        return;
      }
      if (data.data?.user?.role === "admin") router.push("/admin");
      else router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.networkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    /*
     * Fixed viewport, internal flex column.
     *
     * The trick to keeping this page from scrolling is:
     *  1. The outer wrapper is `fixed inset-0` — it owns the entire viewport.
     *  2. The header is `shrink-0` (fixed height).
     *  3. The main content uses `flex-1 overflow-hidden` and centers with
     *     `flex items-center justify-center`. The Card is allowed to use
     *     `overflow-y-auto` only as a safety net, but normally the content
     *     fits well below the header on every viewport >= 360px.
     */
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Home className="h-4 w-4" />
          <span className="hidden sm:inline">{t("common.backToHome")}</span>
        </Link>
        <ThemeToggle />
      </header>

      {/* Main content - centered, locked to remaining space */}
      <main className="flex flex-1 items-center justify-center overflow-hidden px-4 py-8 sm:px-6">
        <div className="w-full max-w-sm sm:max-w-md">
          {/* Brand */}
          <div className="mb-6 text-center sm:mb-8">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground sm:h-12 sm:w-12">
              <Server className="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">RelayAB</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("login.pageTitle")}
            </p>
          </div>

          {/* Form card */}
          <Card>
            <CardHeader title={t("login.signIn")} description={t("login.signInDesc")} />
            {/*
              `method="post"` is a security requirement, not decoration: the
              default for a form is GET, so before hydration (or with JS off)
              the browser would navigate to `/login?username=…&password=…`,
              spilling the password into history, proxy logs and the Referer
              header. The React handler still owns the real submit path.
            */}
            <form onSubmit={onSubmit} method="post" className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="username" className="block text-sm font-medium text-foreground">
                  {t("login.username")}
                </label>
                <div className="relative">
                  <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="username"
                    name="username"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="password" className="block text-sm font-medium text-foreground">
                  {t("login.password")}
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" loading={loading} className="w-full rounded-lg bg-primary text-primary-foreground">
                {loading ? null : (
                  <>
                    {t("login.submit")}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>

            {/*
              The two questions a person actually has on this page, answered
              before they ask them.

              "I do not have an account" and "I forgot my password" both end
              in "ask an administrator" — and until this line existed, the only
              way to find that out was to submit the form and get an error.
              Two quiet lines, no extra chrome, and the dead end is not a dead
              end any more.
            */}
            <div className="space-y-1.5 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
              <p>{t("login.noAccount")}</p>
              <p>{t("login.forgotPassword")}</p>
            </div>
          </Card>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            {t("login.footnote")}
          </p>
        </div>
      </main>
    </div>
  );
}
