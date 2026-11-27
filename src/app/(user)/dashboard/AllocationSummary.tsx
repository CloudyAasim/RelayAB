"use client";

import { useT } from "@/components/i18n/I18nProvider";
import { AllowedModelsSummary } from "@/components/models/AllowedModelsSummary";
import { formatCredits, formatCreditsFloor, formatCreditsCeil, formatNumber } from "@/lib/utils";
import type { ModelGroup } from "@/lib/admin/model-groups";
import { ListChecks, KeyRound, Wallet } from "lucide-react";

interface Props {
  quotaType: "credits" | "tokens";
  quotaLimit: number;
  quotaUsed: number;
  allowedModels: string[];
  /** The catalogue's kinds, so the whitelist can be shown grouped by kind. */
  modelGroups: ModelGroup[];
  maxActiveKeys: number;
  activeKeyCount: number;
}

export function AllocationSummary({
  quotaType,
  quotaLimit,
  quotaUsed,
  allowedModels,
  modelGroups,
  maxActiveKeys,
  activeKeyCount,
}: Props) {
  const t = useT();
  const unitLabel = t("admin.keys.create.quotaType." + quotaType);

  const fmt = (n: number) =>
    quotaType === "tokens" ? `${formatNumber(n)} ${unitLabel}` : `${formatCredits(n)} ${unitLabel}`;
  const fmtOverviewRemaining = (n: number) =>
    quotaType === "tokens" ? `${formatNumber(n)} ${unitLabel}` : `${formatCreditsFloor(n)} ${unitLabel}`;
  const fmtOverviewUsed = (n: number) =>
    quotaType === "tokens" ? `${formatNumber(n)} ${unitLabel}` : `${formatCreditsCeil(n)} ${unitLabel}`;

  const remaining = Math.max(0, quotaLimit - quotaUsed);
  const pct = quotaLimit > 0 ? Math.min(100, (quotaUsed / quotaLimit) * 100) : 0;
  const exhausted = quotaLimit > 0 && quotaUsed >= quotaLimit;
  const neverGranted = quotaLimit === 0;

  const barTone = exhausted ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary";

  return (
    <div className="space-y-2">
      {/* Credit pool */}
      <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" />
            </span>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {t("dashboard.pool.title")}
              </div>
              <div className="mt-0.5 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {neverGranted ? t("dashboard.pool.none") : fmtOverviewRemaining(remaining)}
              </div>
              {!neverGranted && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("dashboard.pool.used", { used: fmtOverviewUsed(quotaUsed) })}
                </div>
              )}
            </div>
          </div>
          {exhausted && (
            <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
              {t("dashboard.pool.exhausted")}
            </span>
          )}
        </div>

        {!neverGranted && (
          <div className="mt-2.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full transition-[width] ${barTone}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>{Math.round(pct)}%</span>
              <span>{t("dashboard.pool.sharedByKeys")}</span>
            </div>
          </div>
        )}
      </div>

      {/* Policy info */}
      {/*
        Two up on a phone too. Stacked, they were two 84-pixel panels between
        the balance and the key list, each holding a label, a value and a
        hint — and the page's actual keys started a third of a screen down.
      */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <Field
          icon={<ListChecks className="h-4 w-4" />}
          label={t("dashboard.allocation.modelWhitelist")}
          value={
            // The names live behind the count: printed in full they run to three
            // lines in this half-width panel and push the key list off the fold.
            <AllowedModelsSummary allowedModels={allowedModels} groups={modelGroups} align="start" />
          }
        />
        <Field
          icon={<KeyRound className="h-4 w-4" />}
          label={t("dashboard.allocation.activeKeys")}
          value={maxActiveKeys > 0 ? `${activeKeyCount} / ${maxActiveKeys}` : `${activeKeyCount}`}
        />
      </div>
    </div>
  );
}

function Field({ icon, label, value, hint }: { icon?: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
