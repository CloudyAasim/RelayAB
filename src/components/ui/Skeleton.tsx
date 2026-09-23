/**
 * Skeleton — placeholder shown while async content loads.
 *
 * Use pulse animation and a subtle base color so the layout doesn't jump.
 */
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
