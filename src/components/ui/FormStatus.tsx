/**
 * The two lines every editing form ends with: what went wrong, and what the
 * button below it does.
 *
 * They used to be spelled out per form — one screen used an icon and a tinted
 * box, another a bare red paragraph; one footer had `border-t border-border`,
 * another `border-t` alone. Same job, two looks. These are the one look.
 */
"use client";

import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function FormStatus({
  error,
  saved,
  savedText,
  className,
}: {
  error?: string | null;
  /** Show the success line. Ignored while `error` is set. */
  saved?: boolean;
  savedText?: string;
  className?: string;
}) {
  if (!error && !saved) return null;

  if (error) {
    return (
      <div
        role="alert"
        className={cn(
          "flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
          className,
        )}
      >
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-all">{error}</span>
      </div>
    );
  }

  return (
    <p className={cn("flex items-center gap-2 text-sm text-success", className)}>
      <CheckCircle2 className="h-4 w-4" />
      {savedText}
    </p>
  );
}

export function FormFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex justify-end gap-2 border-t border-border pt-3", className)}>{children}</div>
  );
}
