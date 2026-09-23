/**
 * PageSkeleton — loading placeholder for full pages.
 *
 * Renders a responsive grid of skeletons that mirror the layout of the
 * final page so users don't see content "jump" when it loads.
 *
 *   <SkeletonPage cardCount={3} />
 *
 * Use as the content of a Suspense fallback, or directly via loading.tsx.
 */
import { Skeleton } from "./Skeleton";
import { cn } from "@/lib/utils";

interface PageSkeletonProps {
  /** Number of stat cards in the top row. Default 3. */
  cardCount?: number;
  /** Number of rows in the table placeholder. Default 4. */
  rowCount?: number;
  /** Extra className for the outer wrapper. */
  className?: string;
}

export function PageSkeleton({
  cardCount = 3,
  rowCount = 4,
  className,
}: PageSkeletonProps) {
  return (
    <div className={cn("space-y-4 sm:space-y-6", className)} aria-busy="true">
      {/* Stats row: 1 col on mobile, 2 cols on tablet, 3 cols on desktop */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        {Array.from({ length: cardCount }).map((_, i) => (
          <Skeleton key={i} className="h-20 sm:h-24" />
        ))}
      </div>

      {/* Banner */}
      <Skeleton className="h-16 sm:h-20" />

      {/* Table */}
      <div className="space-y-2 rounded-lg border border-border bg-card p-3 sm:p-4">
        <Skeleton className="h-6 w-1/3" />
        {Array.from({ length: rowCount }).map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    </div>
  );
}
