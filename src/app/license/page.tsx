import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { getPublicUrl } from "@/lib/config";
import {
  ArrowLeft,
  Boxes,
  Scale,
  Server,
  ShieldCheck,
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
 * The project version is intentionally NOT displayed anywhere on this page.
 */
/**
 * Localized <title>. Resolved per request from the active locale rather than
 * hardcoded, so a Chinese visitor doesn't get "License · RelayAB" in the tab
 * next to an otherwise Chinese page.
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
}

const RUNTIME_DEPS: Dep[] = [
  { name: "@ai-sdk/anthropic", version: "1.2.12", license: "Apache-2.0", repo: "https://github.com/vercel/ai" },
  { name: "@ai-sdk/openai", version: "1.3.24", license: "Apache-2.0", repo: "https://github.com/vercel/ai" },
  { name: "@emulators/adapter-next", version: "0.11.2", license: "Apache-2.0" },
  { name: "@emulators/core", version: "0.11.2", license: "Apache-2.0" },
  { name: "@emulators/vercel", version: "0.11.2", license: "Apache-2.0" },
  { name: "@upstash/redis", version: "1.38.4", license: "MIT", repo: "https://github.com/upstash/redis-js" },
  { name: "@vercel/sdk", version: "1.28.35", license: "Apache-2.0", repo: "https://github.com/vercel/sdk" },
  { name: "ai", version: "4.3.19", license: "Apache-2.0", repo: "https://github.com/vercel/ai" },
  { name: "bcryptjs", version: "2.4.3", license: "MIT", repo: "https://github.com/dcodeIO/bcrypt.js" },
  { name: "clsx", version: "2.1.1", license: "MIT", repo: "https://github.com/lukeed/clsx" },
  { name: "iron-session", version: "8.0.4", license: "MIT", repo: "https://github.com/vvo/iron-session" },
  { name: "jose", version: "5.10.0", license: "MIT", repo: "https://github.com/panva/jose" },
  { name: "lucide-react", version: "0.460.0", license: "ISC", repo: "https://github.com/lucide-icons/lucide" },
  { name: "next", version: "15.5.25", license: "MIT", repo: "https://github.com/vercel/next.js" },
  { name: "next-themes", version: "0.4.6", license: "MIT", repo: "https://github.com/pacocoursey/next-themes" },
  { name: "react", version: "19.3.0", license: "MIT", repo: "https://github.com/facebook/react" },
  { name: "react-dom", version: "19.3.0", license: "MIT", repo: "https://github.com/facebook/react" },
  { name: "tailwind-merge", version: "2.6.1", license: "MIT", repo: "https://github.com/dcastil/tailwind-merge" },
  { name: "zod", version: "3.25.76", license: "MIT", repo: "https://github.com/colinhacks/zod" },
];

const DEV_DEPS: Dep[] = [
  { name: "@playwright/test", version: "1.63.0", license: "Apache-2.0", repo: "https://github.com/microsoft/playwright" },
  { name: "@tailwindcss/forms", version: "0.5.11", license: "MIT", repo: "https://github.com/tailwindlabs/tailwindcss-forms" },
  { name: "@tailwindcss/typography", version: "0.5.20", license: "MIT", repo: "https://github.com/tailwindlabs/tailwindcss-typography" },
  { name: "@types/bcryptjs", version: "2.4.6", license: "MIT" },
  { name: "@types/node", version: "22.20.4", license: "MIT" },
  { name: "@types/react", version: "19.3.0", license: "MIT" },
  { name: "@types/react-dom", version: "19.3.0", license: "MIT" },
  { name: "autoprefixer", version: "10.6.1", license: "MIT", repo: "https://github.com/postcss/autoprefixer" },
  { name: "postcss", version: "8.5.28", license: "MIT", repo: "https://github.com/postcss/postcss" },
  { name: "tailwindcss", version: "3.4.19", license: "MIT", repo: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "tsx", version: "4.23.13", license: "MIT", repo: "https://github.com/privatenumber/tsx" },
  { name: "typescript", version: "5.9.3", license: "Apache-2.0", repo: "https://github.com/microsoft/TypeScript" },
  { name: "vitest", version: "2.1.9", license: "MIT", repo: "https://github.com/vitest-dev/vitest" },
];

/**
 * Map a SPDX identifier onto a badge tone. Permissive licenses read as
 * "safe" (green/blue); anything unrecognized stays neutral rather than
 * implying a judgement we haven't made.
 */
function licenseTone(license: string): "success" | "primary" | "info" | "neutral" {
  if (license === "MIT") return "success";
  if (license === "Apache-2.0") return "primary";
  if (license === "ISC") return "info";
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
                className="font-mono text-xs text-primary underline-offset-2 hover:underline"
              >
                {d.name}
              </a>
            ) : (
              <code className="font-mono text-xs">{d.name}</code>
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

  // Surface the deployment's own origin so a self-hoster can tell which
  // instance these notices belong to. Pulled from config rather than the
  // request so it stays consistent across proxies.
  let origin = "";
  try {
    origin = getPublicUrl();
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
                <ShieldCheck className="mr-1 h-3 w-3" />
                MIT
              </Badge>
              <Badge tone="neutral">
                <Boxes className="mr-1 h-3 w-3" />
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
      </div>
    </div>
  );
}
