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
import { LevelIcon, noticeTextClass, noticeToneClass } from "./level";
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

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    // Written before the state change so a reload in the same breath still
    // remembers. The write itself is guarded; a browser that refuses storage
    // shows the notice again next time rather than failing.
    writeDismissedIds(next);
    setDismissed(next);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-4 py-2 text-sm sm:px-6",
        noticeToneClass(current.level),
      )}
    >
      <LevelIcon
        level={current.level}
        className={cn("h-4 w-4 shrink-0", noticeTextClass(current.level))}
      />
      <p className="min-w-0 flex-1 truncate font-medium text-foreground">{current.title}</p>
      {visible.length > 1 && (
        <Link
          href="/dashboard/announcements"
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
  );
}