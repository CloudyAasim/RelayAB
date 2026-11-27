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

/**
 * Balance and the two policy figures on one band.
 *
 * They were three separate bordered panels, which on a phone put two 84-pixel
 * boxes between the balance and the key list — three answers to "how much can I
 * spend, and with what" stacked vertically, each mostly whitespace.
 */
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
    <div className="rounded-lg border border-border bg-card p-3 shadow-card sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Wallet className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                {t("dashboard.pool.title")}
              </span>
              <span className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {neverGranted ? t("dashboard.pool.none") : fmtOverviewRemaining(remaining)}
              </span>
              {exhausted && (
                <span className="rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                  {t("dashboard.pool.exhausted")}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {neverGranted
                ? t("dashboard.pool.noneHint")
                : t("dashboard.pool.used", { used: fmtOverviewUsed(quotaUsed) })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Meta
            icon={<ListChecks className="h-3.5 w-3.5" />}
            label={t("dashboard.allocation.modelWhitelist")}
            value={
              // The names live behind the count: printed in full they run to three
              // lines here and push the key list off the fold.
              <AllowedModelsSummary allowedModels={allowedModels} groups={modelGroups} align="start" />
            }
          />
          <Meta
            icon={<KeyRound className="h-3.5 w-3.5" />}
            label={t("dashboard.allocation.activeKeys")}
            value={maxActiveKeys > 0 ? `${activeKeyCount} / ${maxActiveKeys}` : `${activeKeyCount}`}
          />
        </div>
      </div>

      {!neverGranted && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full transition-[width] ${barTone}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {t("dashboard.pool.sharedByKeys")}
          </span>
        </div>
      )}
    </div>
  );
}

function Meta({ icon, label, value }: { icon?: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</div>
    </div>
  );
}