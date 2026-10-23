/**
 * Switch — an on/off control, in the Breeze idiom.
 *
 * **Why a switch and not a checkbox.** A checkbox says "include this"; a
 * switch says "this is on". KDE's Breeze Ocean introduces switch toggles for
 * exactly this reason, and the distinction is not cosmetic: the pages in this
 * app that used a checkbox for "enabled" made the reader work out whether the
 * box meant "currently on" or "please tick me" — and on a form full of
 * checkboxes, "enabled" in a box is genuinely ambiguous.
 *
 * **How it looks.** Breeze is flat: no gradients, one soft shadow, a
 * monochrome thumb. The track is a rounded rectangle rather than a pill,
 * because that is what Breeze draws, and the thumb is square-ish for the same
 * reason. The colours come from the theme (`--primary`, `--muted`), so the
 * switch follows the light/dark switch with everything else.
 *
 * The control is keyboard- and screen-reader-correct by construction: it is a
 * Radix switch, so it is focusable, toggles with Space, and announces
 * "on"/"off" — none of which a styled `<input type="checkbox">` gives you
 * for free.
 */
import { cn } from "@/lib/utils";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-md border border-input",
      "bg-muted transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-[4px] bg-background shadow-xs ring-0",
        "transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };

/**
 * SwitchField — a setting as a row: what it is, what it does, and the switch.
 *
 * **Why the explanation sits next to the switch and not above it.** A switch
 * with a name and no sentence is a control the reader has to interpret from
 * context; a switch with a sentence is a decision they can make. The
 * description says what turning it on *does* — in this app's case, usually
 * "what happens to the things that already exist", which is the part people
 * actually want to know before they flip it.
 *
 * The switch sits on the right at every breakpoint, so the eye finds the
 * controls by scanning one column instead of re-finding them in each row.
 */
export function SwitchField({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  id: string;
  label: string;
  /** One sentence: what is on, and what turning it off means. */
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {label}
        </label>
        {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="mt-0.5"
      />
    </div>
  );
}
