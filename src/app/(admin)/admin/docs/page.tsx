/**
 * app/(admin)/admin/docs/page.tsx
 *
 * Admin-only operator reference.
 *
 * Kept separate from the user-facing /docs page: that one explains how to call
 * the API, this one explains how to *run* it (provider wiring, metering,
 * troubleshooting). Access is enforced by the /admin segment layout, which
 * redirects non-admins before anything renders.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  BookOpen,
  Coins,
  LifeBuoy,
  Route,
  Server,
  Split,
  Tags,
  Wrench,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { Card, CardHeader } from "@/components/ui/Card";
import { AuthenticatedLayout, SectionPageLayout } from "@/components/layouts";

export const dynamic = "force-dynamic";

export default async function AdminDocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      pageTitle={t("admin.docs.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("admin.docs.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <div className="max-w-4xl space-y-5">
            <Card>
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <BookOpen className="h-5 w-5" />
                </span>
                <p className="text-sm text-muted-foreground">{t("admin.docs.subtitle")}</p>
              </div>
            </Card>

            <Card>
              <CardHeader
                title={
                  <CardTitle icon={<Server className="h-4 w-4" />}>
                    {t("admin.docs.provider.title")}
                  </CardTitle>
                }
                description={t("admin.docs.provider.desc")}
              />
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>{t("admin.docs.provider.kind")}</li>
                <li>{t("admin.docs.provider.baseUrl")}</li>
                <li>{t("admin.docs.provider.format")}</li>
              </ul>
            </Card>

            {/* How to add the second protocol for a vendor — the step people
                most often get wrong (they reach for the Anthropic template). */}
            <Card className="border-primary/20 bg-primary/[0.03]">
              <CardHeader
                title={
                  <CardTitle icon={<Split className="h-4 w-4" />}>
                    {t("admin.docs.add.title")}
                  </CardTitle>
                }
                description={t("admin.docs.add.desc")}
              />
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-foreground/90">
                <li>{t("admin.docs.add.step1")}</li>
                <li>{t("admin.docs.add.step2")}</li>
                <li>{t("admin.docs.add.step3")}</li>
                <li>{t("admin.docs.add.step4")}</li>
              </ol>
              <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
                {t("admin.docs.add.why")}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{t("admin.docs.add.note")}</p>
            </Card>

            <Card>
              <CardHeader
                title={
                  <CardTitle icon={<Route className="h-4 w-4" />}>
                    {t("admin.docs.routes.title")}
                  </CardTitle>
                }
                description={t("admin.docs.routes.desc")}
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">{t("admin.docs.routes.col.endpoint")}</th>
                      <th className="py-2 pr-3 font-medium">{t("admin.docs.routes.col.base")}</th>
                      <th className="py-2 font-medium">{t("admin.docs.routes.col.format")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    {/* Written out literally (not mapped) so the i18n scanner
                        in tests/unit/i18n-usage.test.ts can see every key. */}
                    <tr className="border-b border-border/60">
                      <td className="py-2 pr-3 align-top font-mono text-xs text-foreground">
                        {t("admin.docs.routes.r1.endpoint")}
                      </td>
                      <td className="py-2 pr-3 align-top text-xs">
                        {t("admin.docs.routes.r1.base")}
                      </td>
                      <td className="py-2 align-top text-xs">
                        {t("admin.docs.routes.r1.format")}
                      </td>
                    </tr>
                    <tr className="border-b border-border/60">
                      <td className="py-2 pr-3 align-top font-mono text-xs text-foreground">
                        {t("admin.docs.routes.r2.endpoint")}
                      </td>
                      <td className="py-2 pr-3 align-top text-xs">
                        {t("admin.docs.routes.r2.base")}
                      </td>
                      <td className="py-2 align-top text-xs">
                        {t("admin.docs.routes.r2.format")}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-3 align-top font-mono text-xs text-foreground">
                        {t("admin.docs.routes.r3.endpoint")}
                      </td>
                      <td className="py-2 pr-3 align-top text-xs">
                        {t("admin.docs.routes.r3.base")}
                      </td>
                      <td className="py-2 align-top text-xs">
                        {t("admin.docs.routes.r3.format")}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Two short reference cards side by side on wide screens. */}
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title={
                    <CardTitle icon={<Tags className="h-4 w-4" />}>
                      {t("admin.docs.mapping.title")}
                    </CardTitle>
                  }
                  description={t("admin.docs.mapping.desc")}
                />
                <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                  <li>{t("admin.docs.mapping.rule1")}</li>
                  <li>{t("admin.docs.mapping.rule2")}</li>
                  <li>{t("admin.docs.mapping.rule3")}</li>
                </ul>
              </Card>

              <Card>
                <CardHeader
                  title={
                    <CardTitle icon={<Coins className="h-4 w-4" />}>
                      {t("admin.docs.quota.title")}
                    </CardTitle>
                  }
                  description={t("admin.docs.quota.desc")}
                />
                <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                  <li>{t("admin.docs.quota.point1")}</li>
                  <li>{t("admin.docs.quota.point2")}</li>
                  <li>{t("admin.docs.quota.point3")}</li>
                </ul>
              </Card>
            </div>

            <Card>
              <CardHeader
                title={
                  <CardTitle icon={<LifeBuoy className="h-4 w-4" />}>
                    {t("admin.docs.trouble.title")}
                  </CardTitle>
                }
                description={t("admin.docs.trouble.desc")}
              />
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>{t("admin.docs.trouble.step1")}</li>
                <li>{t("admin.docs.trouble.step2")}</li>
                <li>{t("admin.docs.trouble.step3")}</li>
              </ol>
            </Card>

            <Card>
              <CardHeader
                title={
                  <CardTitle icon={<Wrench className="h-4 w-4" />}>
                    {t("admin.docs.ops.title")}
                  </CardTitle>
                }
                description={t("admin.docs.ops.desc")}
              />
              <pre className="overflow-x-auto rounded-md border border-border bg-foreground/[0.03] px-3 py-2.5 text-xs font-mono leading-relaxed text-foreground">
{`pnpm bootstrap-admin --username <name> [--password <pw>]
pnpm reset-password --username <name>
pnpm rotate-key
pnpm list-usage [--user <name>] [--days N]`}
              </pre>
              <p className="mt-3 text-xs text-muted-foreground">
                <Link href="/docs" className="underline underline-offset-2">
                  {t("docs.title")}
                </Link>
              </p>
            </Card>
          </div>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}

function CardTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </span>
  );
}
