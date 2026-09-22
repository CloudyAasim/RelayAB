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
        padded && "p-6",
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
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Card — small stat card for dashboard overviews.
 *   <StatCard label="活跃 Key" value="3" icon={<Key />} trend="+1" />
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
        "rounded-lg border border-border bg-card p-5 shadow-sm transition-colors",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {icon && (
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md",
              iconBg[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
      {(hint || trend) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
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
