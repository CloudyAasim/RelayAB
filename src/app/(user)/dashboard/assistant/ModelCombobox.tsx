"use client";

/**
 * src/app/(user)/dashboard/assistant/ModelCombobox.tsx
 *
 * A text field with a dropdown, in this product's clothes.
 *
 * A native suggestion list was tried first and looked nothing like the rest of
 * the form: the browser draws that popup, so it does not follow the theme, it
 * is sized by the OS, and in some browsers it is a plain grey list. Every other
 * control here is a bordered `h-9` field on the app's own tokens.
 *
 * So the field is an `Input` — same class list as every other field, so it
 * lines up with the address and key fields above it — and the list is a
 * `Popover`, which already carries `--popover` and the app's radius, border and
 * shadow. Two shapes came before this one and both are wrong here: a closed
 * picker cannot hold a value it does not list, and the model is sent as typed
 * to an upstream the operator chose.
 *
 * Filtering as you type, arrow keys, Enter, Escape — the list behaves like the
 * rest of the interface rather than like the OS.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/Popover";
import { cn } from "@/lib/utils";

export function ModelCombobox({
  id,
  label,
  hint,
  value,
  options,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  /** What the options are, and how to replace them. Shown under the field. */
  hint?: string;
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // A prefix matches, so `minimax` finds `MiniMax-M3` without the operator
  // having to remember the capitalisation.
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const all = [...new Set(options.filter((o) => o.trim()))];
    if (!q) return all;
    const hits = all.filter((o) => o.toLowerCase().includes(q));
    // The typed value stays in the list even when nothing matches, so the field
    // never disagrees with the menu under it.
    return hits.length > 0 ? hits : [value, ...all.filter((o) => o !== value)];
  }, [options, value]);

  useEffect(() => setActive(0), [value, open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>

      {/*
        An `Anchor`, not a `Trigger`. A trigger would put a focusable field
        inside a `role="button"` — two interactive elements nested in each
        other — and the arrow would take focus away from it. The anchor gives
        the popover something to position against, and the width to match,
        without adding a control.

        It has to be *inside* `Popover`. Radix's anchor resolves against its
        context, and used outside the root it throws on render — which took the
        whole page down rather than just this field.
      */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="relative">
          <Input
            id={id}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setOpen(true);
                setActive((i) => {
                  const next = e.key === "ArrowDown" ? i + 1 : i - 1;
                  const n = filtered.length;
                  return ((next % n) + n) % n;
                });
              } else if (e.key === "Enter" && open) {
                // Enter sends, unless the list is open and something is
                // highlighted — otherwise the operator cannot choose one.
                e.preventDefault();
                if (filtered[active]) pick(filtered[active]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            className="pr-9"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            autoComplete="off"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => setOpen((o) => !o)}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
          >
            <ChevronsUpDown className="h-4 w-4" />
          </button>
          </div>
        </PopoverAnchor>

        <PopoverContent
          id={`${id}-list`}
          align="start"
          sideOffset={4}
          className="max-h-64 w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">{hint}</p>
          ) : (
            <ul ref={listRef} role="listbox" className="space-y-0.5">
              {filtered.map((option, i) => (
                <li key={option} role="option" aria-selected={option === value}>
                  <button
                    type="button"
                    data-active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(option)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                      i === active
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/60",
                    )}
                  >
                    <span className="truncate">{option}</span>
                    {option === value && <Check className="ml-auto h-4 w-4 shrink-0" aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>

      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
