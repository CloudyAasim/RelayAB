import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">{children}</table>
      </div>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function TR({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr className={cn("transition-colors hover:bg-muted/30", className)} {...rest}>
      {children}
    </tr>
  );
}

export function TH({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableCellElement> & { children: ReactNode }) {
  return (
    <th
      className={cn("px-4 py-2.5 font-medium", className)}
      {...rest}
    >
      {children}
    </th>
  );
}

/**
 * TD — table cell.
 *
 * IMPORTANT: this component must forward arbitrary HTML attributes
 * (data-*, aria-*, onClick, etc.) so that callers can attach data
 * attributes for testing / DOM queries (e.g. `data-user-id="..."`).
 *
 * Previously the component only destructured {children, className, colSpan}
 * which silently dropped any other props. That broke the admin user page
 * where the toggle action looks up the row by `[data-user-id="…"]`.
 */
export function TD({
  children,
  className,
  colSpan,
  ...rest
}: HTMLAttributes<HTMLTableCellElement> & {
  children: ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      className={cn("px-4 py-3 align-middle", className)}
      colSpan={colSpan}
      {...rest}
    >
      {children}
    </td>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Skeleton — a lightweight loading placeholder that follows the design tokens.
 * Use as: `<Skeleton className="h-4 w-32" />`.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted",
        className,
      )}
    />
  );
}
