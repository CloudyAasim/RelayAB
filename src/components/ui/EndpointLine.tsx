"use client";

import { cn } from "@/lib/utils";

/**
 * "Which URL is this call going to", shown the same way everywhere.
 *
 * The test page used to answer that question in four slightly different boxes
 * (padding, border tint, whether the method was shown, whether the code wrapped),
 * one per panel. A reader should not have to re-learn the box each time.
 */
export function EndpointLine({
  label,
  method = "POST",
  url,
  className,
}: {
  label: string;
  method?: string;
  url: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-border bg-muted/30 p-2", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <code className="break-all text-xs text-foreground">
        {method} {url}
      </code>
    </div>
  );
}
