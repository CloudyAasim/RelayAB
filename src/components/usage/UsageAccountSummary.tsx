import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

export interface AccountFigure {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tone?: "primary" | "success" | "neutral" | "orange";
}

const toneClass: Record<NonNullable<AccountFigure["tone"]>, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  neutral: "bg-muted text-muted-foreground",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
};

interface Props {
  figures: AccountFigure[];
  /** Optional usage bar, e.g. remaining vs total quota. */
  progress?: { percent: number; caption: string; exhausted?: boolean };
}

/**
 * Top-of-page account block: balance and lifetime consumption side by side so
 * they are the first thing the eye lands on, merged into a single surface
 * instead of several overlapping cards.
 */
export function UsageAccountSummary({ figures, progress }: Props) {
  return (
    <Card className="mb-4 sm:mb-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.label} className="flex items-start gap-3">
            {figure.icon && (
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                  toneClass[figure.tone ?? "neutral"],
                )}
              >
                {figure.icon}
              </span>
            )}
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {figure.label}
              </div>
              <div className="mt-0.5 truncate text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {figure.value}
              </div>
              {figure.hint && (
                <div className="mt-0.5 text-xs text-muted-foreground">{figure.hint}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {progress && (
        <div className="mt-4">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                progress.exhausted ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
            <span>{Math.round(progress.percent)}%</span>
            <span>{progress.caption}</span>
          </div>
        </div>
      )}
    </Card>
  );
}
