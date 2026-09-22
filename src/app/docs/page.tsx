/**
 * Public documentation page - accessible without login.
 */
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { ThemeToggle } from "@/components/layouts";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";

export const metadata = {
  title: { absolute: "接入文档 - RelayAB" },
};

export default async function PublicDocsPage() {
  const { t, locale } = await getT();

  const base = await resolvePublicUrl();
  const openaiBase = `${base}/v1`;
  const anthropicBase = `${base}/anthropic`;
  const responsesBase = `${base}/v1`;

  const user = await getCurrentUser().catch(() => null);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Simple header for public docs */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/80 px-4 backdrop-blur lg:px-6">
        <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
            </svg>
          </span>
          RelayAB
        </a>
        <div className="flex items-center gap-2">
          {user ? (
            <a
              href={user.role === "admin" ? "/admin" : "/dashboard"}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t("nav.dashboard")} →
            </a>
          ) : (
            <a
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t("welcome.signIn")}
            </a>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">{t("docs.title")}</h1>
            <p className="mt-2 text-muted-foreground">{t("docs.intro")}</p>
          </div>
          <DocsContent
            baseUrl={base}
            openaiBase={openaiBase}
            anthropicBase={anthropicBase}
            responsesBase={responsesBase}
          />
        </div>
      </main>

    </div>
  );
}
