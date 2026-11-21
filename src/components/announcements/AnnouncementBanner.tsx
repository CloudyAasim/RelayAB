"use client";

/**
 * src/components/announcements/AnnouncementBanner.tsx
 *
 * The strip at the top of every signed-in page.
 *
 * It carries **one** notice, not a feed. A feed on top of every page is a
 * second navigation bar, and the third announcement in it is already invisible.
 * The list of everything lives at `/dashboard/announcements`; this is the one
 * thing that has to be seen today.
 *
 * The strip is a link, not a label. A title alone said that something had
 * happened, not what — and left the reader no next step, so the notice was
 * either ignored or dismissed out of a vague sense of being interrupted. It now
 * shows the title *and* the first line of the body, and the whole thing opens
 * the notice at `/dashboard/announcements/<id>`: the one place where the body is
 * rendered in full, at reading width.
 *
 * Three things stay outside that link, because they are controls rather than
 * content: the 「还有 N 条」 count, the close button, and the level icon (part of
 * the link, but with no text to select). Only the text is wrapped, so a click
 * on the strip at large opens the notice while the two buttons keep their own
 * jobs — a `<button>` inside an `<a>` is invalid HTML, and a screen reader needs
 * the dismissal to be its own target anyway.
 *
 * Dismissal is per browser (`lib/announcements/dismissal.ts`), so the state
 * cannot be known on the server, and the banner is therefore rendered after
 * mount. Rendering it first and hiding it after hydration would flash a notice
 * the reader closed a week ago, which reads as the app forgetting things.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n/I18nProvider";
import { announcementExcerpt } from "@/lib/announcements/excerpt";
import { announcementHref, ANNOUNCEMENTS_HREF } from "@/lib/announcements/links";
import { LevelIcon, noticeTextClass } from "./level";
import { readDismissedIds, writeDismissedIds } from "@/lib/announcements/dismissal";
import type { PublicAnnouncement } from "@/lib/announcements/types";

export function AnnouncementBanner({
  announcements,
}: {
  /** Already active, already in priority order. */
  announcements: PublicAnnouncement[];
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    // After mount, never during render: the server cannot read localStorage and
    // guessing would produce markup that hydration then rewrites.
    setDismissed(readDismissedIds());
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const visible = announcements.filter((a) => !dismissed.includes(a.id));
  if (visible.length === 0) return null;
  const current = visible[0];
  // Computed per render, not memoised: it is one string over ≤160 characters,
  // and a `useMemo` here would have to depend on `current` anyway.
  const excerpt = announcementExcerpt(current.body);

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    // Written before the state change so a reload in the same breath still
    // remembers. The write itself is guarded; a browser that refuses storage
    // shows the notice again next time rather than failing.
    writeDismissedIds(next);
    setDismissed(next);
  };

  return (
    /*
     * A card that floats on the page, not a band welded to the frame.
     *
     * The strip used to be window chrome: it ran the full width of the inset,
     * took `bg-muted/40` and closed with a hairline under it, so it read as the
     * bottom edge of the header rather than as a notice of its own. Two things
     * made that wrong. It sat on the shell's background with no edge on either
     * side, which in Breeze's language is a *surface*, and every other surface
     * in this app is a `rounded-lg` card with a hairline and one shadow. And a
     * notice is temporary content that happened to arrive today — not part of
     * the window's fixed frame — so it should look like a sheet of paper laid
     * on the page and lifted off it, the same way the side panel is.
     *
     * So: the same geometry as the floating panel (`rounded-lg`, `border`,
     * `shadow-float`), inset from the frame by the page's own gutters
     * (`px-4 sm:px-6 lg:px-8`, `pt-4 sm:pt-6 lg:pt-8` — the same numbers
     * `main` pads with), and capped and centred at the content column's width
     * so its edges line up with the cards below it instead of running past
     * them on a wide screen.
     *
     * It stays in the flow, deliberately: it scrolls away with the page. Pinned
     * to the top it would be a second sticky bar under the narrow-screen header
     * and would cover the first line of every page.
     *
     * The card is neutral — `bg-card`, the level's colour on the icon alone.
     * A four-level wash across a strip that width is an alarm band; this is a
     * note that was published, and the icon says how loudly.
     */
    <div className="px-4 pt-4 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
      <div
        // `mx-auto max-w-7xl` is the same cap `SectionPageLayout` puts on the
        // page column, so the card's edges land on the cards below it.
        className="mx-auto flex w-full max-w-7xl items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-float sm:px-4"
      >
        <Link
          href={announcementHref(current.id)}
          className="group flex min-w-0 flex-1 items-baseline gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LevelIcon
            level={current.level}
            // The whole of the level's presence here. One coloured mark, and the
            // text stays in the ordinary foreground colours so a notice reads like
            // a line of the app rather than like a warning dialog.
            className={cn("h-4 w-4 shrink-0 self-center", noticeTextClass(current.level))}
          />
          {/*
            Title and body on one line, title first, because the title is what a
            returning reader scans for ("is this the one I already read?"). The
            body is capped at one line by `truncate` and by `announcementExcerpt`
            cutting the string first — the strip must not grow with the notice.
          */}
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground group-hover:underline">{current.title}</span>
            {excerpt && (
              <span className="ml-2 text-muted-foreground group-hover:text-foreground">
                {excerpt}
              </span>
            )}
          </span>
        </Link>
        {visible.length > 1 && (
          <Link
            href={ANNOUNCEMENTS_HREF}
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("announcements.moreCount", { count: visible.length - 1 })}
          </Link>
        )}
        <button
          type="button"
          onClick={() => dismiss(current.id)}
          aria-label={t("announcements.bannerDismiss")}
          title={t("announcements.bannerDismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}