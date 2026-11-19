/**
 * app/(user)/dashboard/announcements/page.tsx
 *
 * The announcement centre: everything that has been published, newest first.
 *
 * The banner at the top of the shell carries exactly one notice, because a list
 * on every page is a second navigation bar. This is where the rest of them
 * live, and why the banner can afford to be one line.
 *
 * Two states, drawn differently on purpose:
 *
 *  - **live** keeps the level's own wash — it is a notice that applies now;
 *  - **finished** is a plain card with a muted mark and a 「已结束」 badge, because
 *    a red box around a maintenance window that ended last month is an alarm
 *    about nothing. It stays readable rather than disappearing: "was there a
 *    notice about this?" is a real question, and an announcement that is a row
 *    (not a paragraph somebody overwrites) can answer it.
 *
 * `listPublishedAnnouncements` decides what is here. Not-started rows are
 * drafts and switched-off rows were withdrawn; neither belongs in a reader's
 * history. One `now` is taken for the whole page so the two states cannot
 * disagree about a row whose window closes between two clock reads.
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listPublishedAnnouncements } from "@/lib/db/announcements";
import { announcementState } from "@/lib/announcements/types";
import { getT } from "@/lib/i18n/server";
import { timezoneToIana } from "@/lib/timezone";
import { cn, formatDate } from "@/lib/utils";
import { SectionPageLayout } from "@/components/layouts";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/Table";
import { AnnouncementMarkdown } from "@/components/announcements/AnnouncementMarkdown";
import {
  LevelChip,
  LevelIcon,
  noticeTextClass,
  noticeToneClass,
} from "@/components/announcements/level";
import { Megaphone, Pin } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { t } = await getT();
  const timeZone = timezoneToIana(user.timezone);
  const now = new Date();
  const announcements = await listPublishedAnnouncements(now);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("announcements.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Description>
        {t("announcements.description")}
      </SectionPageLayout.Description>
      <SectionPageLayout.Content>
        {announcements.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Megaphone className="h-5 w-5" />}
              title={t("announcements.empty")}
              description={t("announcements.empty.description")}
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {announcements.map((announcement) => {
              const live = announcementState(announcement, now) === "live";
              return (
                <Card
                  key={announcement.id}
                  // Only a live notice is tinted: the wash is the level saying
                  // "this applies", so painting a finished one with it would say
                  // the opposite of the 「已结束」 badge beside it.
                  className={cn(!live && "bg-muted/30")}
                >
                  <div
                    className={cn(
                      live && "rounded-md border p-3",
                      live && noticeToneClass(announcement.level),
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
                      <span className="font-medium text-foreground">{announcement.title}</span>
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
                    <AnnouncementMarkdown
                      body={announcement.body}
                      className={cn("mt-2", !live && "text-muted-foreground")}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
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
              );
            })}
          </div>
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}