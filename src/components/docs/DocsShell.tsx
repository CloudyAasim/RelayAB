"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { Check, Copy } from "lucide-react";
import type { DocSection } from "@/lib/docs/sections";

/**
 * Chrome shared by every docs surface: a section outline on the left (wrapping
 * into a row on narrow screens), a copy-this-page control, and prev/next, so
 * any page can be reached — and handed to an AI — without going back to the
 * index.
 */
export function DocsShell({
  basePath,
  sections,
  copyPageLabel,
  copiedLabel,
  copyFailedLabel,
  children,
}: {
  basePath: string;
  sections: DocSection[];
  copyPageLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const t = useT();
  const [copied, setCopied] = useState(false);
  const hrefOf = (id: string) => `${basePath}/${id}`;
  const current = Math.max(
    0,
    sections.findIndex((section) => pathname === hrefOf(section.id)),
  );
  const prev = current > 0 ? sections[current - 1] : null;
  const next = current < sections.length - 1 ? sections[current + 1] : null;

  async function copyPage() {
    const body = document.querySelector("[data-docs-body]") as HTMLElement | null;
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body.innerText.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // eslint-disable-next-line no-alert
      alert(copyFailedLabel);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
      <nav className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
        <ul className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
          {sections.map((section, index) => {
            const active = index === current;
            return (
              <li key={section.id}>
                <Link
                  href={hrefOf(section.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 space-y-5">
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="secondary" onClick={copyPage}>
            {copied ? (
              <>
                <Check className="mr-1 h-3.5 w-3.5" />
                {copiedLabel}
              </>
            ) : (
              <>
                <Copy className="mr-1 h-3.5 w-3.5" />
                {copyPageLabel}
              </>
            )}
          </Button>
        </div>

        <div data-docs-body className="space-y-5">
          {children}
        </div>

        <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
          {prev ? (
            <Link
              href={hrefOf(prev.id)}
              className="rounded-md border border-border px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              ← {prev.label}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={hrefOf(next.id)}
              className="rounded-md border border-border px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {next.label} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </div>
    </div>
  );
}
