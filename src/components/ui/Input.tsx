import { cn } from "@/lib/utils";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { InfoHint } from "./InfoHint";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** An explanation shown on demand beside the label, instead of under the field. */
  labelHint?: ReactNode;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, labelHint, hint, error, id, ...rest }, ref) => {
    const inputId = id ?? rest.name;
    return (
      <div className="space-y-1.5">
        {label && (
          <div className="flex items-center gap-1.5">
            <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
              {label}
            </label>
            {labelHint ? <InfoHint text={labelHint} label={label} /> : null}
          </div>
        )}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors",
            "placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-destructive focus-visible:ring-destructive",
            className,
          )}
          {...rest}
        />
        {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  },
);
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  /** An explanation shown on demand beside the label, instead of under the field. */
  labelHint?: ReactNode;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, labelHint, hint, error, id, ...rest }, ref) => {
    const tid = id ?? rest.name;
    return (
      <div className="space-y-1.5">
        {label && (
          <div className="flex items-center gap-1.5">
            <label htmlFor={tid} className="block text-sm font-medium text-foreground">
              {label}
            </label>
            {labelHint ? <InfoHint text={labelHint} label={label} /> : null}
          </div>
        )}
        <textarea
          id={tid}
          ref={ref}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-xs transition-colors",
            "placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-destructive focus-visible:ring-destructive",
            className,
          )}
          {...rest}
        />
        {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
