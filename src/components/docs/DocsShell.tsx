"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { DocSection } from "@/lib/docs/sections";

/**
 * Chrome shared by every docs surface: a section outline on the left (wrapping
 * into a row on narrow screens) and prev/next at the bottom, so any page can
 * be reached without going back to the index.
 */
export function DocsShell({
  basePath,
  sections,
  children,
}: {
  basePath: string;
  sections: DocSection[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const hrefOf = (id: string) => `${basePath}/${id}`;
  const current = Math.max(
    0,
    sections.findIndex((section) => pathname === hrefOf(section.id)),
  );
  const prev = current > 0 ? sections[current - 1] : null;
  const next = current < sections.length - 1 ? sections[current + 1] : null;

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
        {children}

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
