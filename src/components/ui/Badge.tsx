/**
 * Badge — a small status pill.
 *
 * Look — the Breeze skeleton: no border, one pale surface and the tone's own
 * colour for the text, `rounded-full` corners and `text-xs`. The same
 * convention the StatCard tones use, so a badge and a stat tile read as one
 * system.
 *
 * The pale surfaces are `bg-x/10`: the theme colours in `tailwind.config.ts`
 * are functions, so an opacity modifier on one of them is a colour mix of the
 * same variable — which means the tint follows the light/dark switch.
 *
 * `whitespace-nowrap` is not decoration. A badge is a pill: one line, always.
 * Without it, Chinese text in a column the browser had squeezed to fifty-odd
 * pixels broke between characters, and 「按上游用量」 rendered as four glyphs
 * stacked one under the other — a pill that had become a column of text.
 * `cn` is tailwind-merge, so a caller that genuinely needs a wrapping badge
 * can still say so.
 */
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "purple" | "slate" | "orange";

const toneClass: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary:
    "bg-primary/10 text-primary",
  success:
    "bg-success/10 text-success",
  // The warning token is a light amber, so it is too pale to be text on a
  // near-white surface: the light mode reads as ink on sand, the dark mode
  // as the amber itself (the convention used elsewhere in the app).
  warning:
    "bg-warning/15 text-warning-foreground dark:text-warning",
  danger:
    "bg-destructive/10 text-destructive",
  info:
    "bg-info/10 text-info",
  purple:
    "bg-[color:oklch(0.92_0.06_310)] text-[color:oklch(0.45_0.18_310)] dark:bg-[color:oklch(0.32_0.08_310)] dark:text-[color:oklch(0.85_0.14_310)]",
  slate: "bg-secondary text-secondary-foreground",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** A tooltip, for a badge whose label says less than it stands for. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
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
  tone?: "success" | "warning" | "danger" | "info" | "neutral" | "orange";
  pulse?: boolean;
  className?: string;
}) {
  const colorClass: Record<typeof tone, string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-info",
    neutral: "bg-muted-foreground",
    orange: "bg-orange-500",
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
