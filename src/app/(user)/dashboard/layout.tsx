import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { AuthenticatedLayout } from "@/components/layouts";
import { cachedListActiveAnnouncements } from "@/lib/db/data-cache";
import { toPublicAnnouncement } from "@/lib/db/announcements";

export const dynamic = "force-dynamic";

/**
 * Dashboard segment layout — authentication gate + app shell for the user
 * area.
 *
 * Runs outside this segment's `loading.tsx` Suspense boundary so an
 * unauthenticated visitor gets a real 307 to /login instead of a streamed
 * shell followed by a client-side redirect (see the matching admin layout for
 * the full explanation).
 *
 * Hosting the shell here (rather than in each page) is what keeps the sidebar
 * and header mounted while navigating between the dashboard pages.
 *
 * The notices are read here for the same reason: the banner sits in the shell,
 * the shell is a client component, and this is the nearest server frame that
 * every page passes through. One query per navigation, whatever the page.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

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