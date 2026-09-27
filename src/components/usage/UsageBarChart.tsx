import {
  bucketLabel,
  metricValue,
  type UsageGrain,
  type UsageMetric,
  type UsageSeriesPoint,
} from "@/lib/usage/report";
import { formatCredits, formatNumber } from "@/lib/utils";

function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "credits" ? formatCredits(value) : formatNumber(value);
}

interface Props {
  points: UsageSeriesPoint[];
  grain: UsageGrain;
  metric: UsageMetric;
  /** Localized name of the selected metric ("积分" / "Tokens" / "请求次数"). */
  metricLabel: string;
  labels: { credits: string; tokens: string; requests: string };
  emptyLabel: string;
}

/**
 * Dependency-free bar chart for the usage series.
 *
 * - A numeric Y axis (max / mid / 0) plus a mid gridline gives a scale at a
 *   glance, so the bar heights are readable without hovering.
 * - Each bar reveals a detail card on hover *and* on keyboard focus, leading
 *   with the currently selected metric and then the other two.
 */
export function UsageBarChart({
  points,
  grain,
  metric,
  metricLabel,
  labels,
  emptyLabel,
}: Props) {
  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>
    );
  }

  const values = points.map((point) => metricValue(point, metric));
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{metricLabel}</span>
        <span className="tabular-nums">{formatMetric(total, metric)}</span>
      </div>

      <div className="flex gap-2">
        {/* Y axis: max / mid / 0 */}
        <div className="flex h-40 w-16 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground sm:w-20">
          <span>{formatMetric(max, metric)}</span>
          <span>{formatMetric(max / 2, metric)}</span>
          <span>0</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative flex h-40 items-end gap-[2px] border-b border-border">
            <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border/40" />
            {points.map((point) => {
              const value = metricValue(point, metric);
              const height =
                value > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
              const bucket = bucketLabel(point.bucket, grain);
              const detail = `${bucket} · ${labels.credits} ${formatCredits(
                point.creditsUsed,
              )} · ${labels.tokens} ${formatNumber(point.totalTokens)} · ${labels.requests} ${formatNumber(
                point.requests,
              )}`;
              return (
                <div
                  key={point.bucket}
                  className="group relative flex h-full flex-1 flex-col justify-end outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  tabIndex={0}
                  aria-label={detail}
                  title={detail}
                >
                  <div
                    className="w-full rounded-t-sm bg-primary transition-[filter] group-hover:brightness-110 group-focus:brightness-110"
                    style={{ height: `${height}%` }}
                  />
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[10px] leading-tight text-popover-foreground shadow-md group-hover:block group-focus:block">
                    <div className="font-medium">{bucket}</div>
                    <div className="font-semibold text-primary">
                      {metricLabel} {formatMetric(value, metric)}
                    </div>
                    <div className="text-muted-foreground">
                      {labels.credits} {formatCredits(point.creditsUsed)} · {labels.tokens}{" "}
                      {formatNumber(point.totalTokens)} · {labels.requests}{" "}
                      {formatNumber(point.requests)}
                    </div>
                  </div>
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
      </div>
    </div>
  );
}
