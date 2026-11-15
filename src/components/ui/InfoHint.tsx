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
 * Why this is hand-wired rather than `<Tooltip><TooltipTrigger>…` and nothing
 * else: hovering a 16px icon and moving towards the tooltip leaves the icon,
 * and a tooltip that closes on that exit is a tooltip that flashes once and
 * disappears — the exact report this file answers. So the badge keeps itself
 * open while the pointer is on the icon **or on the tooltip**, with a short
 * grace period between the two, and a click pins it for touch screens (where
 * there is no hover and Radix's tooltip has no tap gesture of its own).
 *
 * A tooltip, not a popover: this component is used inside the settings sheet,
 * and a popover's portal sits outside the dialog's DOM. Radix Dialog treats a
 * pointerdown there as "outside" and would close the sheet under the reader.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

/** How long the pointer may be away before the tooltip closes. */
const CLOSE_GRACE_MS = 160;

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
  /** The pointer is on the icon or on the tooltip. */
  const hovering = useRef(false);
  /** A click opened it; only an explicit close dismisses it. */
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLButtonElement | null>(null);

  const cancelClose = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const closeSoon = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (!hovering.current && !pinned.current) setOpen(false);
    }, CLOSE_GRACE_MS);
  };

  const enter = () => {
    hovering.current = true;
    cancelClose();
    setOpen(true);
  };

  const leave = () => {
    hovering.current = false;
    closeSoon();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      const inTooltip = (event.target as Element | null)?.closest?.('[role="tooltip"]');
      if (inTooltip) return;
      pinned.current = false;
      if (!hovering.current) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      pinned.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => cancelClose, []);

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          // `false` from Radix is its own pointer bookkeeping as often as it is
          // Escape; the bookkeeping is what used to close the tooltip while the
          // pointer was still on it. Escape is handled by the key listener, so
          // ignore this when the tooltip was pinned by a click (touch screens
          // have no hover to keep it alive).
          if (!next && !pinned.current && !hovering.current) setOpen(false);
        }}
      >
        <TooltipTrigger asChild>
          <button
            ref={root}
            type="button"
            aria-label={label ?? t("common.help")}
            aria-expanded={open}
            onClick={() => {
              pinned.current = true;
              setOpen(true);
            }}
            onPointerEnter={enter}
            onPointerLeave={leave}
            onBlur={() => {
              hovering.current = false;
              closeSoon();
            }}
            className={cn(
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
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
          sideOffset={6}
          className="max-w-[18rem] whitespace-normal text-xs leading-relaxed"
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
