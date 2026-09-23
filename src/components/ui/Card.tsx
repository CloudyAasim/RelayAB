/**
 * Card — surface container with backward-compat header and shadcn-style compound.
 *
 * Legacy API (still supported for existing callers):
 *   <Card>
 *     <CardHeader title="…" description="…" action={…} />
 *     …content…
 *   </Card>
 *
 * New shadcn-style compound (use for new code):
 *   <Card>
 *     <CardHeaderNew>
 *       <CardTitle>…</CardTitle>
 *       <CardDescription>…</CardDescription>
 *     </CardHeaderNew>
 *     <CardContent>…</CardContent>
 *   </Card>
 */
import { cn } from "@/lib/utils";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

/** Card root container. */
const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

/**
 * Legacy CardHeader — accepts the old (title, description, action) props.
 * Kept so existing pages continue to compile.
 */
function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:mb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
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

/* --- New shadcn-style compound components --- */

const CardHeaderNew = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col gap-1.5 p-4 sm:p-6", className)}
      {...props}
    />
  ),
);
CardHeaderNew.displayName = "CardHeaderNew";

const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("text-base font-semibold leading-none tracking-tight sm:text-lg", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("text-xs text-muted-foreground sm:text-sm", className)}
      {...props}
    />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("p-4 pt-0 sm:p-6 sm:pt-0", className)}
      {...props}
    />
  ),
);
CardContent.displayName = "CardContent";

const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-center p-4 pt-0 sm:p-6 sm:pt-0", className)}
      {...props}
    />
  ),
);
CardFooter.displayName = "CardFooter";

/**
 * StatCard — small stat card for dashboard overviews.
 * Responsive: stacks on narrow screens, side-by-side on wider.
 */
interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  tone?: "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "orange";
}

const iconToneClass: Record<NonNullable<StatCardProps["tone"]>, string> = {
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

function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  tone = "neutral",
  className,
  ...rest
}: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-3 shadow-sm transition-colors sm:p-5",
        className,
      )}
      {...rest}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </span>
        {icon && (
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8",
              iconToneClass[tone],
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

export {
  Card,
  CardHeader,
  CardHeaderNew,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  StatCard,
};
