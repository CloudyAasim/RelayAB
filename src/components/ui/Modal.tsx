"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider modal — for forms with many fields (e.g. provider editor). */
  wide?: boolean;
  /** Extra wide modal — for complex forms with tables. */
  extraWide?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
  extraWide,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Lock body scroll while modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4 animate-fade-in">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          "w-full rounded-lg border border-border bg-card text-card-foreground shadow-lg",
          "max-h-[90vh] overflow-y-auto",
          wide && "max-w-2xl",
          extraWide && "max-w-5xl",
          !wide && !extraWide && "max-w-lg",
        )}
      >
        <div className="flex items-start justify-between border-b border-border px-6 py-4">
          <div>
            <h2 id="modal-title" className="text-base font-semibold text-foreground">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
