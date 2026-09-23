import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import {
  ArrowLeft,
  Code2,
  Database,
  FileText,
  Scale,
  Server,
  ShieldAlert,
  Sparkles,
  Type,
  Wrench,
} from "lucide-react";
import { LicenseText } from "./LicenseText";

/**
 * Public license & open-source notices page.
 *
 * Reachable without a session and linked from the site-wide footer, so it
 * deliberately does NOT use `AuthenticatedLayout` — a visitor should be able
 * to check the project's licensing before ever signing in.
 *
 * Sections (in order):
 *   1. Header / metadata (year, origin, MIT badge)
 *   2. MIT license — full text
 *   3. Runtime dependencies
 *   4. Development dependencies
 *   5. Third-party assets (fonts, icons)
 *   6. Source code / repo link
 *   7. Trademark notice
 *   8. Data handling / privacy
 *   9. Compatibility summary
 *  10. Warranty disclaimer
 */

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("license.heading") };
}

interface Dep {
  name: string;
  version: string;
  license: string;
  /** Optional homepage / source repository, linked from the package name. */
  repo?: string;
  /** Optional copyright holder shown in tooltip. */
  copyright?: string;
}

const RUNTIME_DEPS: Dep[] = [
  { name: "@ai-sdk/anthropic", version: "1.2.12", license: "Apache-2.0", repo: "https://github.com/vercel/ai", copyright: "Vercel Inc." },
  { name: "@ai-sdk/openai", version: "1.3.24", license: "Apache-2.0", repo: "https://github.com/vercel/ai", copyright: "Vercel Inc." },
  { name: "@emulators/adapter-next", version: "0.11.2", license: "Apache-2.0", copyright: "Vercel Labs" },
  { name: "@emulators/core", version: "0.11.2", license: "Apache-2.0", copyright: "Vercel Labs" },
  { name: "@emulators/vercel", version: "0.11.2", license: "Apache-2.0", copyright: "Vercel Labs" },
  { name: "@upstash/redis", version: "1.38.4", license: "MIT", repo: "https://github.com/upstash/redis-js", copyright: "Upstash Inc." },
  { name: "@vercel/sdk", version: "1.28.35", license: "Apache-2.0", repo: "https://github.com/vercel/sdk", copyright: "Vercel Inc." },
  { name: "ai", version: "4.3.19", license: "Apache-2.0", repo: "https://github.com/vercel/ai", copyright: "Vercel Inc." },
  { name: "bcryptjs", version: "2.4.3", license: "MIT", repo: "https://github.com/dcodeIO/bcrypt.js", copyright: "Dawid Ciężarkiewicz" },
  { name: "clsx", version: "2.1.1", license: "MIT", repo: "https://github.com/lukeed/clsx", copyright: "Luke Edwards" },
  { name: "iron-session", version: "8.0.4", license: "MIT", repo: "https://github.com/vvo/iron-session", copyright: "Vercel Inc." },
  { name: "jose", version: "5.10.0", license: "MIT", repo: "https://github.com/panva/jose", copyright: "Filip Skokan" },
  { name: "lucide-react", version: "0.460.0", license: "ISC", repo: "https://github.com/lucide-icons/lucide", copyright: "Lucide Contributors" },
  { name: "next", version: "15.5.25", license: "MIT", repo: "https://github.com/vercel/next.js", copyright: "Vercel Inc." },
  { name: "next-themes", version: "0.4.6", license: "MIT", repo: "https://github.com/pacocoursey/next-themes", copyright: "Paco Coursey" },
  { name: "react", version: "19.3.0", license: "MIT", repo: "https://github.com/facebook/react", copyright: "Meta Platforms Inc." },
  { name: "react-dom", version: "19.3.0", license: "MIT", repo: "https://github.com/facebook/react", copyright: "Meta Platforms Inc." },
  { name: "tailwind-merge", version: "2.6.1", license: "MIT", repo: "https://github.com/dcastil/tailwind-merge", copyright: "Dany Castillo" },
  // UI primitives - Radix UI (added in v0.2+)
  { name: "@radix-ui/react-accordion", version: "1.2.20", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-checkbox", version: "1.3.11", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-dialog", version: "1.1.23", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-dropdown-menu", version: "2.1.24", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-label", version: "2.1.15", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-popover", version: "1.1.23", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-progress", version: "1.1.16", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-select", version: "2.3.7", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-separator", version: "1.1.15", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-slot", version: "1.3.3", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-switch", version: "1.3.7", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-tabs", version: "1.1.21", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-toast", version: "1.2.23", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "@radix-ui/react-tooltip", version: "1.2.16", license: "MIT", copyright: "Radix UI Contributors" },
  { name: "class-variance-authority", version: "0.7.1", license: "Apache-2.0", repo: "https://github.com/joe-bell/cva", copyright: "Joe Bell" },
  { name: "tailwindcss-animate", version: "1.0.7", license: "MIT", repo: "https://github.com/jamiebuilds/tailwindcss-animate", copyright: "Jamie Kyle" },
  { name: "zod", version: "3.25.76", license: "MIT", repo: "https://github.com/colinhacks/zod", copyright: "Colin McDonnell" },
];

const DEV_DEPS: Dep[] = [
  { name: "@playwright/test", version: "1.63.0", license: "Apache-2.0", repo: "https://github.com/microsoft/playwright", copyright: "Microsoft Corporation" },
  { name: "@tailwindcss/forms", version: "0.5.11", license: "MIT", repo: "https://github.com/tailwindlabs/tailwindcss-forms", copyright: "Tailwind Labs Inc." },
  { name: "@tailwindcss/typography", version: "0.5.20", license: "MIT", repo: "https://github.com/tailwindlabs/tailwindcss-typography", copyright: "Tailwind Labs Inc." },
  { name: "@types/bcryptjs", version: "2.4.6", license: "MIT", copyright: "DefinitelyTyped contributors" },
  { name: "@types/node", version: "22.20.4", license: "MIT", copyright: "DefinitelyTyped contributors" },
  { name: "@types/react", version: "19.3.0", license: "MIT", copyright: "DefinitelyTyped contributors" },
  { name: "@types/react-dom", version: "19.3.0", license: "MIT", copyright: "DefinitelyTyped contributors" },
  { name: "autoprefixer", version: "10.6.1", license: "MIT", repo: "https://github.com/postcss/autoprefixer", copyright: "Andrey Sitnik" },
  { name: "postcss", version: "8.5.28", license: "MIT", repo: "https://github.com/postcss/postcss", copyright: "Andrey Sitnik" },
  { name: "tailwindcss", version: "3.4.19", license: "MIT", repo: "https://github.com/tailwindlabs/tailwindcss", copyright: "Tailwind Labs Inc." },
  { name: "tsx", version: "4.23.13", license: "MIT", repo: "https://github.com/privatenumber/tsx", copyright: "Hirotaka Miyagi" },
  { name: "typescript", version: "5.9.3", license: "Apache-2.0", repo: "https://github.com/microsoft/TypeScript", copyright: "Microsoft Corporation" },
  { name: "vitest", version: "2.1.9", license: "MIT", repo: "https://github.com/vitest-dev/vitest", copyright: "Anthony Fu and Vitest contributors" },
];

/**
 * Map an SPDX identifier onto a badge tone. Permissive licenses read as
 * "safe" (green/blue); anything unrecognized stays neutral rather than
 * implying a judgement we haven't made.
 */
function licenseTone(license: string): "success" | "primary" | "info" | "neutral" {
  if (license === "MIT") return "success";
  if (license === "Apache-2.0") return "primary";
  if (license === "ISC") return "info";
  if (license === "BSD-3-Clause" || license === "BSD-2-Clause") return "info";
  if (license === "OFL-1.1") return "info";
  return "neutral";
}

function DepRows({ rows }: { rows: Dep[] }) {
  return (
    <>
      {rows.map((d) => (
        <TR key={d.name}>
          <TD>
            {d.repo ? (
              <a
                href={d.repo}
                target="_blank"
                rel="noreferrer noopener"
                title={d.copyright}
                className="font-mono text-xs text-primary underline-offset-2 hover:underline"
              >
                {d.name}
              </a>
            ) : (
              <code className="font-mono text-xs" title={d.copyright}>{d.name}</code>
            )}
          </TD>
          <TD>
            <code className="font-mono text-xs text-muted-foreground">{d.version}</code>
          </TD>
          <TD>
            <Badge tone={licenseTone(d.license)}>{d.license}</Badge>
          </TD>
        </TR>
      ))}
    </>
  );
}

export default async function LicensePage() {
  const { t } = await getT();
  const year = new Date().getFullYear();
  const repoUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim();

  // Surface the deployment's own origin so a self-hoster can tell which
  // instance these notices belong to. Pulled from config rather than the
  // request so it stays consistent across proxies.
  let origin = "";
  try {
    origin = await resolvePublicUrl();
  } catch {
    // Config can be incomplete on a fresh deploy; the page still renders.
  }

  const mitText =
    "MIT License\n\n" +
    "Copyright (c) " + year + " CloudyAasim\n\n" +
    "Permission is hereby granted, free of charge, to any person obtaining a copy\n" +
    "of this software and associated documentation files (the \"Software\"), to deal\n" +
    "in the Software without restriction, including without limitation the rights\n" +
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n" +
    "copies of the Software, and to permit persons to whom the Software is\n" +
    "furnished to do so, subject to the following conditions:\n\n" +
    "The above copyright notice and this permission notice shall be included in all\n" +
    "copies or substantial portions of the Software.\n\n" +
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n" +
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n" +
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n" +
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n" +
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n" +
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n" +
    "SOFTWARE.";

  const totalDeps = RUNTIME_DEPS.length + DEV_DEPS.length;
  const repoLabel = repoUrl ?? "github.com/CloudyAasim/RelayAB";

  return (
    <div className="relative flex-1 bg-background">
      {/* Decorative wash, matching the login page's treatment. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 overflow-hidden" aria-hidden>
        <div className="absolute -top-24 left-1/4 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -top-16 right-1/4 h-56 w-56 rounded-full bg-info/10 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-4xl px-4 py-10 sm:px-6">
        {/* Breadcrumb */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("common.back")}
        </Link>

        {/* Page header */}
        <header className="mt-5 flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Scale className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {t("license.heading")}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("license.intro")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="success">
                <ShieldAlert className="mr-1 h-3 w-3" />
                MIT
              </Badge>
              <Badge tone="neutral">
                <Server className="mr-1 h-3 w-3" />
                {t("license.count", { count: totalDeps })}
              </Badge>
              {origin && (
                <span className="font-mono text-xs text-muted-foreground">{origin}</span>
              )}
            </div>
          </div>
        </header>

        {/* MIT license text */}
        <Card className="mt-8">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-muted-foreground" />
                {t("license.mit.title")}
              </span>
            }
            description={t("license.mit.desc")}
            action={<LicenseText text={mitText} />}
          />
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
            {mitText}
          </pre>
        </Card>

        {/* Source code */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-muted-foreground" />
                {t("license.source.title")}
              </span>
            }
            description={t("license.source.desc")}
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("license.source.body", { repo: repoLabel })}
          </p>
          {repoUrl && (
            <div className="mt-3">
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-2 hover:underline"
              >
                {repoUrl} ↗
              </a>
            </div>
          )}
        </Card>

        {/* Runtime dependencies */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                {t("license.runtime.title")}
              </span>
            }
            description={t("license.runtime.desc")}
            action={
              <Badge tone="neutral">
                {t("license.summary.runtime", { count: RUNTIME_DEPS.length })}
              </Badge>
            }
          />
          <Table>
            <THead>
              <TR>
                <TH>{t("license.table.package")}</TH>
                <TH className="w-28">{t("license.table.version")}</TH>
                <TH className="w-32">{t("license.table.license")}</TH>
              </TR>
            </THead>
            <TBody>
              <DepRows rows={RUNTIME_DEPS} />
            </TBody>
          </Table>
        </Card>

        {/* Development dependencies */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                {t("license.dev.title")}
              </span>
            }
            description={t("license.dev.desc")}
            action={
              <Badge tone="neutral">
                {t("license.summary.dev", { count: DEV_DEPS.length })}
              </Badge>
            }
          />
          <Table>
            <THead>
              <TR>
                <TH>{t("license.table.package")}</TH>
                <TH className="w-28">{t("license.table.version")}</TH>
                <TH className="w-32">{t("license.table.license")}</TH>
              </TR>
            </THead>
            <TBody>
              <DepRows rows={DEV_DEPS} />
            </TBody>
          </Table>
          <p className="mt-4 text-xs text-muted-foreground">
            {t("license.deps.hint")} {t("license.compat.note")}
          </p>
        </Card>

        {/* Third-party assets */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Type className="h-4 w-4 text-muted-foreground" />
                {t("license.assets.title")}
              </span>
            }
            description={t("license.assets.desc")}
          />
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              {t("license.assets.fonts")}
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              {t("license.assets.icons")}
            </li>
          </ul>
        </Card>

        {/* Trademark */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                {t("license.trademark.title")}
              </span>
            }
            description={t("license.trademark.desc")}
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("license.trademark.body")}
          </p>
        </Card>

        {/* Data handling / privacy */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Database className="h-4 w-4 text-muted-foreground" />
                {t("license.privacy.title")}
              </span>
            }
            description={t("license.privacy.desc")}
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("license.privacy.body")}
          </p>
        </Card>

        {/* Compatibility summary */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {t("license.compat.note")}
              </span>
            }
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("license.compat.summary")}
          </p>
        </Card>

        {/* Warranty disclaimer */}
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                {t("license.warranty.title")}
              </span>
            }
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("license.warranty.body")}
          </p>
        </Card>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          © {year} CloudyAasim · RelayAB
        </p>
      </div>
    </div>
  );
}
