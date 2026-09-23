import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}

/**
 * Card — base surface for content blocks.
 * Bordered, subtly elevated, uses the `card` token so it follows the theme.
 */
export function Card({ className, padded = true, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        padded && "p-4 sm:p-6",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 sm:mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * StatCard — small stat card for dashboard overviews.
 * Responsive: stacks on narrow screens, side-by-side on wider.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  tone = "neutral",
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  tone?: "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "orange";
  className?: string;
}) {
  const iconBg: Record<typeof tone, string> = {
    neutral: "bg-muted text-muted-foreground",
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
    info: "bg-info/10 text-info",
    orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  };
  const trendClass: Record<"up" | "down" | "flat", string> = {
    up: "text-success",
    down: "text-destructive",
    flat: "text-muted-foreground",
  };
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-3 shadow-sm transition-colors sm:p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </span>
        {icon && (
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8",
              iconBg[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:mt-3 sm:text-2xl">
        {value}
      </div>
      {(hint || trend) && (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground sm:mt-1.5 sm:text-xs">
          {trend && (
            <span className={cn("font-medium", trendClass[trend.direction])}>
              {trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"}{" "}
              {trend.value}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  );
}
