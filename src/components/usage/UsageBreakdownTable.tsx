import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { cn, formatCredits, formatNumber } from "@/lib/utils";
import type { UsageGroupRow, UsageMetric } from "@/lib/usage/report";

export interface UsageBreakdownRow extends UsageGroupRow {
  /** Display label (key name, model id, username…). */
  label: string;
  /** Secondary line, e.g. the masked key prefix. */
  sublabel?: string;
  /** Optional drill-down target. */
  href?: string;
}

interface Props {
  rows: UsageBreakdownRow[];
  emptyLabel: string;
  headers: {
    item: string;
    requests: string;
    tokens: string;
    credits: string;
    actions: string;
  };
  /** Column to bold, matching the chart/ranking metric. */
  emphasis?: UsageMetric;
  /** When set, renders a trailing drill-down column. */
  detailLabel?: string;
}

export function UsageBreakdownTable({
  rows,
  emptyLabel,
  headers,
  emphasis,
  detailLabel,
}: Props) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>
    );
  }

  const emph = (metric: UsageMetric) =>
    emphasis === metric ? "font-semibold text-foreground" : undefined;

  return (
    <Table>
      <THead>
        <TR>
          <TH>{headers.item}</TH>
          <TH className={cn("text-right", emph("requests"))}>{headers.requests}</TH>
          <TH className={cn("text-right", emph("tokens"))}>{headers.tokens}</TH>
          <TH className={cn("text-right", emph("credits"))}>{headers.credits}</TH>
          {detailLabel && <TH className="text-right">{headers.actions}</TH>}
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.id}>
            <TD>
              <div className="font-medium">{row.label}</div>
              {row.sublabel && (
                <div className="font-mono text-xs text-muted-foreground">
                  {row.sublabel}
                </div>
              )}
            </TD>
            <TD className={cn("text-right tabular-nums", emph("requests"))}>
              {formatNumber(row.requests)}
            </TD>
            <TD className={cn("text-right tabular-nums", emph("tokens"))}>
              {formatNumber(row.totalTokens)}
            </TD>
            <TD className={cn("text-right tabular-nums", emph("credits"))}>
              {formatCredits(row.creditsUsed)}
            </TD>
            {detailLabel && (
              <TD className="text-right">
                {row.href ? (
                  <Link href={row.href} className="text-sm text-primary hover:underline">
                    {detailLabel}
                  </Link>
                ) : null}
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

