import { Skeleton } from "@/components/ui/Table";

/**
 * Skeleton loading state for the docs page.
 */
export default function DocsLoading() {
  return (
    <div className="space-y-6">
      {/* Header banner skeleton */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted" />
          <div className="flex-1">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-2 h-4 w-64" />
          </div>
        </div>
      </div>

      {/* Content cards */}
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-6">
          <Skeleton className="h-5 w-24 mb-4" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        </div>
      ))}

      {/* Two-column grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {[1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-6">
            <Skeleton className="h-5 w-32 mb-4" />
            <Skeleton className="h-32 w-full rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
