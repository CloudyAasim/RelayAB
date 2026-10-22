/**
 * Progress — a bar that says how far along something is.
 *
 * KDE has had this widget for twenty years, and it has two modes worth
 * copying: a **determinate** bar that fills to a known percentage, and an
 * **indeterminate** one that slides — for work where the total is unknown but
 * the wait is real. A generation job is the second kind: the upstream gives
 * no percentage, and a bar that sits still reads as a stuck screen.
 *
 * Flat, like everything else in Breeze: a thin track, a rounded fill, one
 * colour, no gradient and no glow. The label above it says what is happening
 * and the hint below says how long the wait usually is — the two things a
 * person actually wants to know while they are waiting.
 */
import { cn } from "@/lib/utils";
import { type CSSProperties } from "react";

export function Progress({
  /** 0–100, or null for "working, but we cannot say how far along it is". */
  value,
  label,
  hint,
  className,
}: {
  value?: number | null;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const indeterminate = value === null || value === undefined;
  const clamped = indeterminate ? 0 : Math.max(0, Math.min(100, value));

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium text-foreground">{label}</p>
          {!indeterminate && (
            <p className="text-xs tabular-nums text-muted-foreground">{clamped}%</p>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(indeterminate ? {} : { "aria-valuenow": clamped })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {indeterminate ? (
          <div className="h-full w-1/3 animate-progress-slide rounded-full bg-primary" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${clamped}%`, ...({} as CSSProperties) }}
          />
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
