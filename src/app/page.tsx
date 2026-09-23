import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ThemeToggle } from "@/components/layouts/ThemeToggle";
import {
  ArrowRight,
  BookOpen,
  Coins,
  KeyRound,
  LayoutDashboard,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import { CopyEndpoint } from "./CopyEndpoint";

export const metadata = {
  title: { absolute: "RelayAB" },
};

/**
 * Public welcome / landing page.
 *
 * Deliberately NOT a redirect. Before this existed, `/` bounced anonymous
 * visitors straight to /login, which meant someone handed the URL had no idea
 * what they were looking at or where to get a key. Now `/` explains the
 * service, publishes the endpoint they will need, and offers one obvious way
 * in for both signed-in and signed-out visitors.
 */
export default async function WelcomePage() {
  const { t } = await getT();

  // A missing/invalid config must not take the landing page down — it is the
  // page people see when something is wrong.
  let origin = "";
  try {
    origin = await resolvePublicUrl();
  } catch {
    origin = "";
  }
  const openaiBase = origin ? `${origin}/v1` : "";

  const user = await getCurrentUser().catch(() => null);
  const consoleHref = user?.role === "admin" ? "/admin" : "/dashboard";

  return (
    <div className="relative flex-1 overflow-hidden bg-background">
      {/* Decorative wash */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -top-24 right-1/4 h-80 w-80 rounded-full bg-info/10 blur-3xl" />
      </div>

      {/* Theme toggle - top right */}
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>

      <div className="relative mx-auto max-w-5xl px-4 pb-12 pt-14 sm:px-6 sm:pb-16 sm:pt-20">
        {/* ---- Hero ---- */}
        <div className="flex flex-col items-center text-center">
          {/* Brand: icon + name */}
          <div className="mb-4 flex items-center gap-2 sm:mb-5 sm:gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 sm:h-14 sm:w-14">
              <Server className="h-6 w-6 sm:h-7 sm:w-7" />
            </div>
            <span className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl sm:font-semibold sm:tracking-tight">
              RelayAB
            </span>
          </div>
          <h1 className="mt-2 text-lg font-medium tracking-tight text-muted-foreground sm:text-xl sm:font-medium sm:tracking-tight">
            {t("welcome.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:mt-3 sm:text-base">
            {t("welcome.subtitle")}
          </p>

          {/* Buttons - stacked on mobile, row on desktop */}
          <div className="mt-6 flex w-full flex-col items-center gap-2 sm:mt-7 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-3">
            {user ? (
              <Link href={consoleHref} className="w-full sm:w-auto">
                <Button size="lg" className="w-full sm:w-auto">
                  <LayoutDashboard className="mr-2 h-4 w-4" />
                  {t("welcome.enterConsole")}
                </Button>
              </Link>
            ) : (
              <Link href="/login" className="w-full sm:w-auto">
                <Button size="lg" className="w-full sm:w-auto">
                  {t("welcome.signIn")}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            )}
            <Link href="/docs" className="w-full sm:w-auto">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                <BookOpen className="mr-2 h-4 w-4" />
                {t("welcome.readDocs")}
              </Button>
            </Link>
          </div>

          {user && (
            <p className="mt-3 text-xs text-muted-foreground">
              {t("welcome.signedInAs", { username: user.username })}
            </p>
          )}
        </div>

        {/* ---- Endpoint ---- */}
        {openaiBase && (
          <div className="mx-auto mt-10 max-w-2xl sm:mt-12">
            <CopyEndpoint
              label={t("welcome.endpointLabel")}
              value={openaiBase}
              hint={t("welcome.endpointHint")}
            />
          </div>
        )}

        {/* ---- How it works ---- */}
        <section className="mt-12 sm:mt-16">
          <h2 className="text-center text-base font-semibold tracking-tight text-foreground sm:text-lg sm:font-semibold sm:tracking-tight">
            {t("welcome.how.title")}
          </h2>
          {/* Single column on mobile, 2 columns on tablet, 4 columns on desktop */}
          <div className="mt-4 grid gap-3 sm:mt-6 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
            <Step
              icon={<ShieldCheck className="h-4 w-4" />}
              title={t("welcome.how.step1.title")}
              body={t("welcome.how.step1.body")}
            />
            <Step
              icon={<Coins className="h-4 w-4" />}
              title={t("welcome.how.step2.title")}
              body={t("welcome.how.step2.body")}
            />
            <Step
              icon={<KeyRound className="h-4 w-4" />}
              title={t("welcome.how.step3.title")}
              body={t("welcome.how.step3.body")}
            />
            <Step
              icon={<BookOpen className="h-4 w-4" />}
              title={t("welcome.how.step4.title")}
              body={t("welcome.how.step4.body")}
            />
          </div>
        </section>

        {/* ---- Two audiences ---- */}
        <section className="mt-10 grid gap-3 sm:mt-14 sm:grid-cols-2 sm:gap-4">
          <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground sm:text-base">
                {t("welcome.users.title")}
              </h3>
            </div>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground sm:mt-3 sm:space-y-2 sm:text-sm">
              <li>{t("welcome.users.line1")}</li>
              <li>{t("welcome.users.line2")}</li>
              <li>{t("welcome.users.line3")}</li>
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground sm:text-base">
                {t("welcome.admins.title")}
              </h3>
            </div>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground sm:mt-3 sm:space-y-2 sm:text-sm">
              <li>{t("welcome.admins.line1")}</li>
              <li>{t("welcome.admins.line2")}</li>
              <li>{t("welcome.admins.line3")}</li>
            </ul>
          </div>
        </section>

        {/* ---- Compatibility footer ---- */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2 sm:mt-12">
          <span className="text-xs text-muted-foreground">
            {t("welcome.compat")}
          </span>
          <Badge tone="primary">OpenAI Chat Completions</Badge>
          <Badge tone="info">Anthropic Messages</Badge>
        </div>
      </div>
    </div>
  );
}

function Step({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="text-primary">
          {icon}
        </span>
        <h3 className="text-sm font-semibold text-foreground sm:text-base">{title}</h3>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground sm:mt-3 sm:text-sm">{body}</p>
    </div>
  );
}
