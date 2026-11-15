"use client";

/**
 * A small (i) badge that holds the explanation a field would otherwise print
 * under itself.
 *
 * The rule the UI follows is "let the layout speak": a screen should not be a
 * column of grey sentences. Explanations that answer "how does this behave" —
 * not "what is this field" — belong on demand, next to the label they explain,
 * and the reader who does not need them never sees them.
 *
 * Hover and keyboard focus both open it; a click toggles it so a touch screen
 * has a way in as well (Radix's tooltip has no tap gesture of its own).
 *
 * A tooltip, not a popover: this component is used inside the settings sheet,
 * and a popover's portal sits outside the dialog's DOM. Radix Dialog treats a
 * pointerdown there as "outside" and would close the sheet under the reader.
 */
import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

export function InfoHint({
  text,
  label,
  className,
}: {
  /** The explanation. Long is fine — it is not on screen until asked for. */
  text: ReactNode;
  /** Accessible name; defaults to "Help". */
  label?: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={150}>
      {/*
        Only hover and click open it: `true` from Radix is a focus event, and the
        sheet focuses its first control when it opens — which made the badge
        greet every reader with a tooltip they did not ask for. `false` is still
        accepted, so Escape and a click outside close it.
      */}
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
      >
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label ?? t("common.help")}
            // Open, not toggle: hovering already opened it, so a click that\n            // toggled would close what the pointer just revealed.\n            onClick={() => setOpen(true)}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onBlur={() => setOpen(false)}
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          >
            <Info className="h-3.5 w-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[18rem] whitespace-normal text-xs leading-relaxed"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
