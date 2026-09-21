import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";

/**
 * Dashboard segment layout — the authentication gate for the user area.
 *
 * Runs outside this segment's `loading.tsx` Suspense boundary so an
 * unauthenticated visitor gets a real 307 to /login instead of a streamed
 * shell followed by a client-side redirect (see the matching admin layout
 * for the full explanation).
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <>{children}</>;
}
