import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";

/**
 * Admin segment layout — the authorization gate for everything under /admin.
 *
 * Why this exists instead of relying on the per-page checks alone: a
 * `loading.tsx` in the same segment wraps each page in a Suspense boundary,
 * so the shell starts streaming before the page body runs. A `redirect()`
 * from inside the page then can't produce a real 307 — Next.js falls back to
 * an RSC redirect plus a `meta refresh`, which shows a blank shell for about
 * a second before navigating.
 *
 * Layouts render *outside* their segment's loading boundary, so the check
 * here runs before anything streams and produces a clean 307.
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
  return <>{children}</>;
}
