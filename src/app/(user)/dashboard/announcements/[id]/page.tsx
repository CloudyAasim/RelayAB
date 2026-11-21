/**
 * app/(user)/dashboard/announcements/[id]/page.tsx
 *
 * One announcement, read in full.
 *
 * The strip at the top of every page carries one notice as a single line —
 * a title and the beginning of the body. That is enough to decide "do I need
 * this?" but not enough to read it: a maintenance window with three steps, a
 * price table, a list of keys to rotate. Cutting those to one line and calling
 * it shown would mean the notice is technically surfaced and practically
 * unreadable, so the line is a link into here rather than the whole message.
 *
 * Why a route rather than an expandable strip: the reader sends this page to
 * somebody ("this is what I meant"), links to it from a chat, and comes back to
 * it a week later from the centre. An in-place expansion has no URL, and the
 * banner would grow on every page it is mounted on.
 *
 * `notFound()` rather than a redirect to the centre for an id that is gone: a
 * stale link that silently lands on a list leaves the reader wondering whether
 * they clicked the right thing. The 404 body says the notice is not there, which
 * is the truth — deleted, never published, and switched off are all the same to
 * them. `not-found.tsx` in this segment is what says it in words; without one
 * this route would show Next's built-in English 404.
 *
 * Caveat, measured not assumed: `(user)/dashboard/loading.tsx` means the
 * response is already streaming by the time this page runs, so `notFound()`
 * renders that body with a **200** status rather than a 404. That is the same
 * soft 404 `docs/[section]` avoids by redirecting, and the reason a thrown
 * status cannot be used as the guard here — the body is the contract.
 */
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublishedAnnouncement, toPublicAnnouncement } from "@/lib/db/announcements";
import { announcementState } from "@/lib/announcements/types";
import { getT } from "@/lib/i18n/server";
import { timezoneToIana } from "@/lib/timezone";
import { cn, formatDate } from "@/lib/utils";
import { SectionPageLayout } from "@/components/layouts";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { buttonVariants } from "@/components/ui/Button";
import { AnnouncementMarkdown } from "@/components/announcements/AnnouncementMarkdown";
import {
  LevelChip,
  LevelIcon,
  noticeTextClass,
  noticeToneClass,
} from "@/components/announcements/level";
import { ANNOUNCEMENTS_HREF } from "@/lib/announcements/links";
import Link from "next/link";
import { ArrowLeft, Pin } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AnnouncementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const now = new Date();
  // One clock reading for the whole page: `announcementState` and the metadata
  // below must agree about a row whose window closes between two `new Date()`.
  const row = await getPublishedAnnouncement(id, now);
  if (!row) notFound();

  const { t } = await getT();
  const timeZone = timezoneToIana(user.timezone);
  const announcement = toPublicAnnouncement(row);
  const live = announcementState(row, now) === "live";

  return (
    <SectionPageLayout>
      <SectionPageLayout.Breadcrumb>
        <Link
          href={ANNOUNCEMENTS_HREF}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t("announcements.back")}
        </Link>
      </SectionPageLayout.Breadcrumb>
      <SectionPageLayout.Title>{announcement.title}</SectionPageLayout.Title>
      <SectionPageLayout.Description>
        {t("announcements.detail.description")}
      </SectionPageLayout.Description>
      <SectionPageLayout.Content>
        <Card>
          <div
            className={cn(
              "rounded-md border p-4",
              // Same rule as the centre: the wash means "this applies now", so a
              // finished notice is a plain card with a 「已结束」 badge instead.
              live ? noticeToneClass(announcement.level) : "bg-muted/30",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <LevelIcon
                level={announcement.level}
                className={cn(
                  "h-4 w-4 shrink-0",
                  live ? noticeTextClass(announcement.level) : "text-muted-foreground",
                )}
              />
              <LevelChip
                level={announcement.level}
                label={t(`announcements.level.${announcement.level}`)}
              />
              {announcement.pinned && (
                <Badge tone="purple">
                  <Pin className="h-3 w-3" aria-hidden="true" />
                  {t("announcements.pinnedBadge")}
                </Badge>
              )}
              {!live && <Badge tone="neutral">{t("announcements.ended")}</Badge>}
            </div>
            {/*
              The body at full length, at reading width. It is the reason this
              route exists, so nothing here truncates or folds it.
            */}
            <AnnouncementMarkdown
              body={announcement.body}
              className={cn("mt-3", !live && "text-muted-foreground")}
            />
            <p className="mt-4 text-xs text-muted-foreground">
              {t("announcements.posted", {
                date: formatDate(announcement.createdAt, timeZone),
              })}
              {live && announcement.endsAt
                ? ` · ${t("announcements.until", {
                    date: formatDate(announcement.endsAt, timeZone),
                  })}`
                : ""}
            </p>
          </div>
        </Card>
        <div className="mt-4">
          <Link href={ANNOUNCEMENTS_HREF} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("announcements.back")}
          </Link>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}