/**
 * app/(user)/dashboard/announcements/[id]/not-found.tsx
 *
 * What a reader sees when a notice id does not exist (deleted, never published,
 * or switched off — all the same to them).
 *
 * Scoped to this segment rather than added globally: every other route in the
 * app has no 404 story of its own yet, and dropping a house-wide boundary would
 * change behaviour for pages this change has no business touching.
 *
 * The dashboard segment has a `loading.tsx`, so the response starts streaming
 * before the page can `notFound()` — the status line is already a 200 and cannot
 * be taken back. That is a soft 404, and it is the reason `docs/[section]`
 * redirects instead of 404ing. We still 404 here because the alternative is
 * worse for a notice: a bookmark to a withdrawn maintenance window would land on
 * the list with no explanation, and the reader would assume the link was fine.
 * The status is honest-laundered, but the body tells the truth, and this file is
 * where the body stops being Next's built-in "This page could not be found".
 */
import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { buttonVariants } from "@/components/ui/Button";
import { ANNOUNCEMENTS_HREF } from "@/lib/announcements/links";

export default async function AnnouncementNotFound() {
  const { t } = await getT();

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("announcements.notFound")}</SectionPageLayout.Title>
      <SectionPageLayout.Description>
        {t("announcements.notFound.description")}
      </SectionPageLayout.Description>
      <SectionPageLayout.Content>
        <Link href={ANNOUNCEMENTS_HREF} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {t("announcements.back")}
        </Link>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}