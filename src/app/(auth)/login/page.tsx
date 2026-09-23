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
    <div className="fixed inset-0 flex flex-col bg-gradient-to-br from-background via-background to-muted">
      {/* Decorative blobs — clipped to viewport */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-1/4 -left-1/4 h-1/2 w-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-1/4 -right-1/4 h-1/2 w-1/2 rounded-full bg-info/10 blur-3xl" />
      </div>

      {/* Header */}
      <header className="relative z-10 flex h-12 shrink-0 items-center justify-between px-3 sm:h-14 sm:px-6">
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
      <main className="relative z-10 flex flex-1 items-center justify-center overflow-hidden px-3">
        <div className="w-full max-w-sm sm:max-w-md">
          {/* Brand */}
          <div className="mb-4 text-center sm:mb-6">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg sm:mb-3 sm:h-14 sm:w-14">
              <Server className="h-5 w-5 sm:h-7 sm:w-7" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-2xl">RelayAB</h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">
              {t("login.pageTitle")}
            </p>
          </div>

          {/* Form card */}
          <Card className="shadow-xl">
            <CardHeader title={t("login.signIn")} description={t("login.signInDesc")} />
            <form onSubmit={onSubmit} className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6 sm:space-y-4">
              <div className="space-y-1">
                <label htmlFor="username" className="block text-xs font-medium text-foreground sm:text-sm">
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
                <label htmlFor="password" className="block text-xs font-medium text-foreground sm:text-sm">
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
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive sm:text-sm">
                  {error}
                </div>
              )}

              <Button type="submit" loading={loading} className="w-full">
                {loading ? null : (
                  <>
                    {t("login.submit")}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          </Card>

          <p className="mt-3 text-center text-xs text-muted-foreground sm:mt-4">
            {t("login.footnote")}
          </p>
        </div>
      </main>
    </div>
  );
}
