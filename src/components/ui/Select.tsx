"use client";

/**
 * Native `<select>` with the label/hint scaffolding the other fields use.
 *
 * Native on purpose: a menu the operating system draws is searchable by typing,
 * works with a keyboard and a screen reader without extra code, and cannot drift
 * into a second visual language. Similar choices should look the same, so the
 * mode pickers and the test page's configuration pickers use this.
 */
import type { ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  /** An explanation shown on demand beside the label. */
  labelHint?: ReactNode;
  hint?: ReactNode;
}

export function Select({ label, labelHint, hint, id, className, children, ...rest }: SelectProps) {
  const sid = id ?? rest.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center gap-1.5">
          <label htmlFor={sid} className="block text-sm font-medium text-foreground">
            {label}
          </label>
          {labelHint ? <InfoHint text={labelHint} label={label} /> : null}
        </div>
      )}
      <select
        id={sid}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
