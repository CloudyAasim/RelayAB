/**
 * src/components/announcements/AnnouncementMarkdown.tsx
 *
 * An announcement body, rendered.
 *
 * No `"use client"` on purpose: it holds no state, so the same component serves
 * the anonymous docs page (a server component) and the banner (a client one)
 * without a second implementation. Markdown is rendered by the house renderer,
 * which escapes before it emits, so an operator's prose cannot become markup.
 */
import { markdownToHtml } from "@/lib/markdown";
import { cn } from "@/lib/utils";

export function AnnouncementMarkdown({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  return (
    <div
      className={cn("prose prose-sm max-w-none text-foreground dark:prose-invert", className)}
      // Escaped by `markdownToHtml` before anything is emitted.
      dangerouslySetInnerHTML={{ __html: markdownToHtml(body) }}
    />
  );
}