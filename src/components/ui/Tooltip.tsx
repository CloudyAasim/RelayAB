/**
 * Tooltip — shadcn/ui style with Radix UI primitives.
 *
 * Look — the Breeze skeleton: hairline border, one soft `shadow-float`,
 * `rounded-lg` corners. A tooltip stays compact (`px-3 py-2`), so it uses
 * less padding than the larger floating panels.
 *
 *   <TooltipProvider>
 *     <Tooltip>
 *       <TooltipTrigger>Hover me</TooltipTrigger>
 *       <TooltipContent>Tooltip text</TooltipContent>
 *     </Tooltip>
 *   </TooltipProvider>
 */
"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-float",
      "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95",
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
