import { Skeleton } from "./Table";

/**
 * PageSkeleton — theme-aware loading placeholder for server-component pages.
 *
 * Rendered by Next.js `loading.tsx` files while a route segment streams in.
 * Uses the `muted` design token so it follows light/dark mode.
 */
export function PageSkeleton({
  stats = 3,
  rows = 4,
}: {
  stats?: number;
  rows?: number;
}) {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-48" />
      {stats > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: stats }, (_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="mt-3 h-7 w-20" />
            </div>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border bg-card p-6">
        <Skeleton className="mb-4 h-5 w-32" />
        <div className="space-y-3">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
