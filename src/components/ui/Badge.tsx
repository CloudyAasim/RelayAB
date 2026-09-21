import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "purple" | "slate";

const toneClass: Record<Tone, string> = {
  neutral:
    "bg-muted text-muted-foreground border-border",
  primary:
    "bg-primary/10 text-primary border-primary/20",
  success:
    "bg-success/10 text-success border-success/20",
  warning:
    "bg-warning/10 text-warning border-warning/30",
  danger:
    "bg-destructive/10 text-destructive border-destructive/20",
  info:
    "bg-info/10 text-info border-info/20",
  purple:
    "bg-[color:oklch(0.92_0.06_310)] text-[color:oklch(0.45_0.18_310)] border-[color:oklch(0.85_0.08_310)] dark:bg-[color:oklch(0.32_0.08_310)] dark:text-[color:oklch(0.85_0.14_310)] dark:border-[color:oklch(0.42_0.1_310)]",
  slate:
    "bg-muted text-foreground/80 border-border",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Pulse dot — small colored dot that animates a "live" indicator.
 * Used next to text like "已启用" or "运行中" to convey real-time status.
 */
export function StatusDot({
  tone = "success",
  pulse = true,
  className,
}: {
  tone?: "success" | "warning" | "danger" | "info" | "neutral";
  pulse?: boolean;
  className?: string;
}) {
  const colorClass: Record<typeof tone, string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-info",
    neutral: "bg-muted-foreground",
  };
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          colorClass[tone],
          pulse && "animate-pulse",
        )}
      />
    </span>
  );
}
