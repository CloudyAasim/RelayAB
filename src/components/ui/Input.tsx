import { cn } from "@/lib/utils";
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, hint, error, id, ...rest }, ref) => {
    const inputId = id ?? rest.name;
    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
            {label}
          </label>
        )}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            "block w-full rounded-md border bg-white px-3 py-2 text-sm",
            "border-slate-300 placeholder:text-slate-400",
            "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            error && "border-red-400 focus:border-red-500 focus:ring-red-500",
            className,
          )}
          {...rest}
        />
        {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, hint, error, id, ...rest }, ref) => {
    const tid = id ?? rest.name;
    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={tid} className="block text-sm font-medium text-slate-700">
            {label}
          </label>
        )}
        <textarea
          id={tid}
          ref={ref}
          className={cn(
            "block w-full rounded-md border bg-white px-3 py-2 text-sm font-mono",
            "border-slate-300 placeholder:text-slate-400",
            "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500",
            error && "border-red-400 focus:border-red-500 focus:ring-red-500",
            className,
          )}
          rows={4}
          {...rest}
        />
        {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
