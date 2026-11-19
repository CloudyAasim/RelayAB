/**
 * app/(admin)/admin/announcements/page.tsx
 *
 * Every announcement, in the order readers get them: pinned first, then newest.
 *
 * The list deliberately shows *all* rows, not the active ones. An announcement
 * that has not started yet and one that was never written look identical from a
 * reader's side, so the admin list is the only place the schedule is visible at
 * all — filtering it to "live" would hide exactly the rows worth checking.
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { announcementState, listAnnouncements } from "@/lib/db/announcements";
import { timezoneToIana } from "@/lib/timezone";
import { formatDate } from "@/lib/utils";
import { SectionPageLayout } from "@/components/layouts";
import { Card } from "@/components/ui/Card";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Table, THead, TBody, TR, TH, TD, EmptyState } from "@/components/ui/Table";
import { getT } from "@/lib/i18n/server";
import { Megaphone, CalendarClock } from "lucide-react";
import { CreateAnnouncementButton } from "./CreateAnnouncementButton";
import { AnnouncementActions } from "./AnnouncementActions";
import { LevelBadge } from "@/components/announcements/LevelBadge";
import type { AnnouncementState } from "@/lib/announcements/types";

export const dynamic = "force-dynamic";

/**
 * State → tone, so the column can be read without reading it: green is on air,
 * blue is waiting its turn, muted is over.
 */
const STATE_TONE: Record<AnnouncementState, Tone> = {
  live: "success",
  scheduled: "info",
  expired: "neutral",
  off: "neutral",
};

export default async function AnnouncementsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const timeZone = timezoneToIana(user.timezone);
  // One instant for the whole page: two rows whose windows touch must not
  // disagree because a millisecond passed between two `new Date()` calls.
  const now = new Date();
  const announcements = await listAnnouncements();

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.announcements.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Description>
        {t("admin.announcements.description")}
      </SectionPageLayout.Description>
      <SectionPageLayout.Actions>
        <CreateAnnouncementButton />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <Card>
          {announcements.length === 0 ? (
            <EmptyState
              icon={<Megaphone className="h-5 w-5" />}
              title={t("admin.announcements.empty")}
              description={t("admin.announcements.empty.description")}
            />
          ) : (
            <Table bare>
              <THead>
                <TR>
                  <TH>{t("admin.announcements.titleLabel")}</TH>
                  <TH>{t("admin.announcements.level")}</TH>
                  <TH>{t("admin.announcements.table.state")}</TH>
                  <TH>{t("admin.announcements.table.window")}</TH>
                  <TH className="w-32 text-right">{t("common.actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {announcements.map((a) => {
                  const state = announcementState(a, now);
                  return (
                    <TR key={a.id}>
                      <TD>
                        <div className="flex items-center gap-2 font-medium text-foreground">
                          {a.title}
                          {a.pinned && (
                            <Badge tone="purple">{t("announcements.pinnedBadge")}</Badge>
                          )}
                        </div>
                        {/* First line of the body: enough to tell two notices
                            apart without opening either of them. */}
                        <div className="line-clamp-1 text-xs text-muted-foreground">
                          {a.body}
                        </div>
                      </TD>
                      <TD>
                        <LevelBadge level={a.level} />
                      </TD>
                      <TD>
                        <Badge tone={STATE_TONE[state]}>
                          {t(`admin.announcements.state.${state}`)}
                        </Badge>
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">
                        {a.startsAt || a.endsAt ? (
                          <span className="inline-flex items-center gap-1.5">
                            <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>
                              {a.startsAt ? formatDate(a.startsAt, timeZone) : "—"}
                              {" → "}
                              {a.endsAt ? formatDate(a.endsAt, timeZone) : t("admin.announcements.noWindow")}
                            </span>
                          </span>
                        ) : (
                          t("admin.announcements.noWindow")
                        )}
                      </TD>
                      <TD className="text-right">
                        <AnnouncementActions announcement={a} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}