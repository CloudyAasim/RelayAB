import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { AuthenticatedLayout } from "@/components/layouts";
import { cachedListActiveAnnouncements } from "@/lib/db/data-cache";
import { toPublicAnnouncement } from "@/lib/db/announcements";

export const dynamic = "force-dynamic";

/**
 * Admin segment layout — authorization gate + app shell for everything under
 * /admin.
 *
 * Why the gate lives here: a `loading.tsx` in the same segment wraps each page
 * in a Suspense boundary, so the page body starts streaming before it runs. A
 * `redirect()` from inside the page then can't produce a real 307 — Next.js
 * falls back to an RSC redirect plus a `meta refresh`, which shows a blank
 * shell for about a second before navigating. Layouts render *outside* their
 * segment's loading boundary, so the check here runs before anything streams
 * and produces a clean 307.
 *
 * Why the shell lives here too: App Router keeps a layout mounted across
 * navigations between its children. Rendering the sidebar/header from the
 * page instead meant every click tore the whole shell down and rebuilt it
 * (see AuthenticatedLayout for the measurement). It also means the segment's
 * `loading.tsx` skeleton now swaps only the content column, leaving the
 * navigation in place while a page loads.
 *
 * The per-page checks remain as defence in depth.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  // The administrator sees the same strip, and needs to: publishing a notice
  // from the page next door and then not seeing it is the one moment this
  // feature has to be trustworthy. The admin rows are filtered to the active
  // window here exactly as they are for a user, so "scheduled" and "off" stay
  // invisible until they mean something.
  const announcements = (await cachedListActiveAnnouncements()).map(toPublicAnnouncement);

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      announcements={announcements}
    >
      {children}
    </AuthenticatedLayout>
  );
}
