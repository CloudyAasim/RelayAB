import { bucketLabel, type UsageGrain, type UsageSeriesPoint } from "@/lib/usage/report";
import { formatCredits, formatNumber } from "@/lib/utils";

interface Props {
  points: UsageSeriesPoint[];
  grain: UsageGrain;
  labels: { credits: string; tokens: string; requests: string };
  emptyLabel: string;
}

/**
 * Dependency-free bar chart for the usage series. Server-rendered: the hover
 * detail is the native `title` tooltip, so no client JS is shipped for it.
 */
export function UsageBarChart({ points, grain, labels, emptyLabel }: Props) {
  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.creditsUsed));
  const total = points.reduce((sum, p) => sum + p.creditsUsed, 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{labels.credits}</span>
        <span className="tabular-nums">{formatCredits(total)}</span>
      </div>
      <div className="flex h-40 items-end gap-[2px]">
        {points.map((point) => {
          const height =
            point.creditsUsed > 0
              ? Math.max(2, Math.round((point.creditsUsed / max) * 100))
              : 0;
          const detail = `${bucketLabel(point.bucket, grain)} · ${labels.credits} ${formatCredits(
            point.creditsUsed,
          )} · ${labels.tokens} ${formatNumber(point.totalTokens)} · ${labels.requests} ${formatNumber(
            point.requests,
          )}`;
          return (
            <div
              key={point.bucket}
              className="group flex h-full flex-1 flex-col justify-end"
              title={detail}
            >
              <div
                className="w-full rounded-t-sm bg-primary/60 transition-colors group-hover:bg-primary"
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{bucketLabel(points[0].bucket, grain)}</span>
        {points.length > 1 && (
          <span>{bucketLabel(points[points.length - 1].bucket, grain)}</span>
        )}
      </div>
    </div>
  );
}
