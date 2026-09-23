/**
 * Modal — Dialog with shadcn/ui API on top of Radix Dialog.
 *
 * Provides:
 *   - Focus trap (Radix manages it)
 *   - Escape-to-close (Radix manages it)
 *   - Body scroll lock (Radix manages it)
 *   - aria-modal, aria-labelledby set correctly
 *   - Portal rendering (escapes stacking contexts)
 *
 *   <Modal open={open} onOpenChange={setOpen} title="..." description="..." wide>
 *     content
 *     <ModalFooter>
 *       <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
 *       <Button>Save</Button>
 *     </ModalFooter>
 *   </Modal>
 */
"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Modal = DialogPrimitive.Root;
const ModalTrigger = DialogPrimitive.Trigger;
const ModalClose = DialogPrimitive.Close;
const ModalPortal = DialogPrimitive.Portal;

const ModalOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
ModalOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface ModalContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Wider modal — for forms with many fields (e.g. provider editor). */
  wide?: boolean;
  /** Extra wide modal — for complex forms with tables. */
  extraWide?: boolean;
}

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(({ className, children, wide, extraWide, ...props }, ref) => (
  <ModalPortal>
    <ModalOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-background p-6 shadow-lg",
        "max-h-[90vh] overflow-y-auto rounded-lg",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        extraWide && "max-w-5xl",
        wide && "max-w-2xl",
        !wide && !extraWide && "max-w-lg",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </ModalPortal>
));
ModalContent.displayName = DialogPrimitive.Content.displayName;

function ModalHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}
ModalHeader.displayName = "ModalHeader";

const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-base font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
ModalTitle.displayName = DialogPrimitive.Title.displayName;

const ModalDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
ModalDescription.displayName = DialogPrimitive.Description.displayName;

function ModalBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("py-2", className)} {...props} />;
}
ModalBody.displayName = "ModalBody";

function ModalFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-2",
        "border-t border-border bg-muted/30 -mx-6 -mb-6 mt-2 px-6 py-3 rounded-b-lg",
        className,
      )}
      {...props}
    />
  );
}
ModalFooter.displayName = "ModalFooter";

export {
  Modal,
  ModalTrigger,
  ModalClose,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  ModalBody,
  ModalFooter,
};

/* ---------------------------------------------------------------- *
 * Legacy API shim — keep existing callers (open/onClose/title/children)
 * compiling while we migrate them to the new controlled API.
 *
 *   <Modal open={open} onClose={...} title="..." description="..." wide>
 *     children
 *   </Modal>
 *
 * Delete this once all call sites are migrated.
 * ---------------------------------------------------------------- */
interface LegacyModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  extraWide?: boolean;
}

/**
 * @deprecated Use the controlled <Modal open onOpenChange title description /> API instead.
 * This shim keeps the old call signature compiling during the migration.
 */
function LegacyModal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
  extraWide,
}: LegacyModalProps) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent wide={wide} extraWide={extraWide}>
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          {description && <ModalDescription>{description}</ModalDescription>}
        </ModalHeader>
        <ModalBody>{children}</ModalBody>
        {footer && <ModalFooter>{footer}</ModalFooter>}
      </ModalContent>
    </Modal>
  );
}

export { LegacyModal };
