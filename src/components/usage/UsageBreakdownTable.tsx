import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatCredits, formatNumber } from "@/lib/utils";
import type { UsageGroupRow } from "@/lib/usage/report";

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
  /** When set, renders a trailing drill-down column. */
  detailLabel?: string;
}

export function UsageBreakdownTable({ rows, emptyLabel, headers, detailLabel }: Props) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>
    );
  }

  return (
    <Table>
      <THead>
        <TR>
          <TH>{headers.item}</TH>
          <TH className="text-right">{headers.requests}</TH>
          <TH className="text-right">{headers.tokens}</TH>
          <TH className="text-right">{headers.credits}</TH>
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
            <TD className="text-right tabular-nums">{formatNumber(row.requests)}</TD>
            <TD className="text-right tabular-nums">{formatNumber(row.totalTokens)}</TD>
            <TD className="text-right tabular-nums">{formatCredits(row.creditsUsed)}</TD>
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
