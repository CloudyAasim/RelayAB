"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
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
 *
 * The outline carries the operator's own pages as indented sub-entries, so a
 * note about rate limits sits under the chapter somebody opens to find the rate
 * limit, rather than in an appendix at the end.
 *
 * **Links here do not prefetch, and that is load-bearing.** The outline is
 * rendered from the settings table, so a payload fetched before the operator
 * saved a new page is wrong the moment they save it. `next.config.mjs` keeps a
 * 30-second Client Router Cache for the rest of the app, and a prefetched
 * outline is what gets served out of it — a page that appears on one visit and
 * is gone on the next. A docs page is a handful of small queries; paying for
 * them per navigation is the cheaper trade than an outline that lies.
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

  // The sub-entry links are anchors into the page you are already on, so the
  // router does not re-render and there is no navigation to observe. The hash
  // is the only signal, and it has to be read from the browser.
  const [hash, setHash] = useState("");
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [pathname]);

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
                  prefetch={false}
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
                {section.children && section.children.length > 0 && (
                  <ul className="mb-1 ml-2 border-l border-border pl-2 lg:mb-0.5">
                    {section.children.map((child) => {
                      const childActive = active && hash === `#${child.id}`;
                      return (
                        <li key={child.id}>
                          <a
                            href={`${hrefOf(section.id)}#${child.id}`}
                            aria-current={childActive ? "location" : undefined}
                            className={cn(
                              "block rounded-md px-2 py-1 text-xs transition-colors",
                              childActive
                                ? "font-medium text-primary"
                                : "text-muted-foreground/80 hover:text-foreground",
                            )}
                          >
                            {child.label}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
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
              prefetch={false}
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
              prefetch={false}
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
