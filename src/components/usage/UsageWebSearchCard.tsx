import { Card, CardHeader } from "@/components/ui/Card";
import { formatCredits, formatNumber } from "@/lib/utils";
import type { UsageSummary } from "@/lib/usage/report";

interface Props {
  /** The subset's own totals. */
  summary: UsageSummary;
  /** The whole report's credits, for the share line. */
  totalCredits: number;
  labels: {
    title: string;
    description: string;
    calls: string;
    credits: string;
    share: string;
    empty: string;
    subsetHint: string;
  };
}

/**
 * How much of the selected range was web search.
 *
 * Deliberately a card rather than an extra row in the breakdown table. Search
 * rows are already inside every total and every breakdown — this is the same
 * money counted a second way, to answer "how much of it was search". A row in
 * the table would look like one more category to add up.
 */
export function UsageWebSearchCard({ summary, totalCredits, labels }: Props) {
  const share =
    totalCredits > 0 ? Math.min(100, (summary.creditsUsed / totalCredits) * 100) : null;

  return (
    <Card>
      <CardHeader title={labels.title} description={labels.description} />
      {summary.requests === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">{labels.calls}</p>
            <p className="mt-1 text-lg font-medium">{formatNumber(summary.requests)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{labels.credits}</p>
            <p className="mt-1 text-lg font-medium">{formatCredits(summary.creditsUsed)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{labels.share}</p>
            <p className="mt-1 text-lg font-medium">
              {share === null ? "—" : `${share.toFixed(1)}%`}
            </p>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{labels.subsetHint}</p>
    </Card>
  );
}
