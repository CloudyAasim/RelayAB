"use client";

/**
 * src/app/(user)/dashboard/assistant/ModelCombobox.tsx
 *
 * The model field: a picker shaped exactly like every other picker on the page,
 * with a way to type something it does not list.
 *
 * Three shapes came before this one, and the reasons they went are worth
 * keeping, because each looked reasonable:
 *
 *  - A closed `<select>`: it *is* the other pickers, and it cannot hold a model
 *    this deployment has never heard of. The value is sent as typed to an
 *    upstream the operator chose, so that model is a legitimate one.
 *  - A native suggestion list: the browser draws the popup, so it ignored the
 *    theme and was sized by the OS — a control that looked foreign beside the
 *    address and key above it.
 *  - A popover over a text field: it matched the theme, and it threw on render.
 *    The anchor has to be a *child* of the popover root, and it was a sibling;
 *    Radix resolved it against nothing and the whole page went down. `next
 *    build` and every unit test passed, because nothing here renders this.
 *
 * So: the real `<select>`, the same class list the other pickers use, and one
 * extra entry that reveals a text field. Nothing to position, nothing to portal,
 * nothing to throw.
 */
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";

/** The sentinel option that reveals the free-text field. */
const CUSTOM = "__custom__";

export function ModelCombobox({
  id,
  label,
  hint,
  value,
  options,
  placeholder,
  customLabel,
  onChange,
}: {
  id: string;
  label: string;
  /** What the options are, and how to replace them. Shown under the field. */
  hint?: string;
  value: string;
  options: string[];
  placeholder?: string;
  customLabel?: string;
  onChange: (value: string) => void;
}) {
  const known = useMemo(() => [...new Set(options.map((o) => o.trim()).filter(Boolean))], [options]);
  // A value that is not on the list is exactly the case this exists for, so it
  // starts in custom mode rather than showing as nothing selected.
  const [custom, setCustom] = useState(() => !value || !known.includes(value));

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>

      {/*
        The same element and the same class list as the pickers on the model
        page. That is the whole point: "looks like the others" is not achieved by
        approximating them.
      */}
      <select
        id={id}
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value={CUSTOM}>
          {custom && value ? `自定义：${value}` : (customLabel ?? "自定义…")}
        </option>
        {known.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>

      {custom && (
        <Input
          id={`${id}-text`}
          value={value}
          placeholder={placeholder ?? "model-name"}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      )}

      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
