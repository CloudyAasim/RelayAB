/**
 * Toaster — mount once in the root layout.
 *
 * The Toaster renders the toast viewport (managed via Radix ToastProvider
 * + ToastContextProvider). Pages use useToast() to push toasts.
 */
"use client";

import { ToastContextProvider } from "@/components/ui/Toast";

export function Toaster({ children }: { children: React.ReactNode }) {
  return <ToastContextProvider>{children}</ToastContextProvider>;
}
