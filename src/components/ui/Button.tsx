/**
 * Button — shadcn/ui style with CVA variants.
 *
 * Variants (shadcn canonical):
 *   - default / primary  : primary filled (alias: primary)
 *   - destructive       : danger filled
 *   - outline           : bordered
 *   - secondary         : muted surface
 *   - ghost             : transparent
 *   - link              : underlined text
 *
 * Sizes:
 *   - default / md      : h-9 px-4 (alias: md)
 *   - sm                : h-8 px-3
 *   - lg                : h-10 px-6
 *   - icon              : h-9 w-9 (square)
 */
import { cn } from "@/lib/utils";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<VariantProps<typeof buttonVariants>, "variant" | "size"> {
  variant?: ButtonVariant | "primary";
  size?: ButtonSize | "md";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...rest }, ref) => {
    // Map legacy aliases to canonical shadcn variants.
    const resolvedVariant = variant === "primary" ? "default" : variant;
    const resolvedSize = size === "md" ? "default" : size;
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(buttonVariants({ variant: resolvedVariant, size: resolvedSize }), className)}
        {...rest}
      >
        {loading && (
          <span
            aria-hidden
            className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
