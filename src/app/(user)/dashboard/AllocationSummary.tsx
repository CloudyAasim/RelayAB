"use client";

import { useT } from "@/components/i18n/I18nProvider";
import { formatCredits, formatCreditsFloor, formatCreditsCeil, formatNumber } from "@/lib/utils";
import { ListChecks, KeyRound, Wallet } from "lucide-react";

interface Props {
  quotaType: "credits" | "tokens";
  quotaLimit: number;
  quotaUsed: number;
  allowedModels: string[];
  maxActiveKeys: number;
  activeKeyCount: number;
}

export function AllocationSummary({
  quotaType,
  quotaLimit,
  quotaUsed,
  allowedModels,
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
    <div className="space-y-3">
      {/* Credit pool */}
      <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Wallet className="h-4 w-4 sm:h-5 sm:w-5" />
            </span>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {t("dashboard.pool.title")}
              </div>
              <div className="mt-1 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                {neverGranted ? t("dashboard.pool.none") : fmtOverviewRemaining(remaining)}
              </div>
              {!neverGranted && (
                <div className="mt-1 text-sm text-muted-foreground">
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
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full transition-[width] ${barTone}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
              <span>{Math.round(pct)}%</span>
              <span>{t("dashboard.pool.sharedByKeys")}</span>
            </div>
          </div>
        )}
      </div>

      {/* Policy info */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          icon={<ListChecks className="h-4 w-4" />}
          label={t("dashboard.allocation.modelWhitelist")}
          value={allowedModels.length > 0 ? allowedModels.join(", ") : t("dashboard.allocation.allModels")}
          hint={t("dashboard.allocation.modelWhitelistHint")}
        />
        <Field
          icon={<KeyRound className="h-4 w-4" />}
          label={t("dashboard.allocation.activeKeys")}
          value={maxActiveKeys > 0 ? `${activeKeyCount} / ${maxActiveKeys}` : `${activeKeyCount}`}
          hint={maxActiveKeys > 0 ? t("dashboard.allocation.activeKeysHintCapped") : t("dashboard.allocation.activeKeysHintUncapped")}
        />
      </div>
    </div>
  );
}

function Field({ icon, label, value, hint }: { icon?: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm font-medium text-foreground break-words">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
