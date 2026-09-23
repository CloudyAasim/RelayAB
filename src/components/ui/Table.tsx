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

export function TR({ children, className, ...rest }: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr className={cn("transition-colors hover:bg-muted/30", className)} {...rest}>
      {children}
    </tr>
  );
}

export function TH({ children, className, ...rest }: HTMLAttributes<HTMLTableCellElement> & { children: ReactNode }) {
  return (
    <th className={cn("px-3 py-2.5 font-medium sm:px-4 sm:py-3", className)} {...rest}>
      {children}
    </th>
  );
}

export function TD({ children, className, colSpan, ...rest }: HTMLAttributes<HTMLTableCellElement> & { children: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td className={cn("px-3 py-3 align-middle sm:px-4 sm:py-4", className)} colSpan={colSpan} {...rest}>
      {children}
    </td>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center sm:px-6 sm:py-12">
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}
