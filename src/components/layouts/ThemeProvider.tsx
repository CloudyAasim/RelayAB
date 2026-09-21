"use client";

/**
 * ThemeProvider — `next-themes` wrapper that:
 *   - applies the `dark` class on <html> so Tailwind's `darkMode: "class"`
 *     swaps to the dark CSS variables
 *   - defaults to the user's `prefers-color-scheme: dark` media query
 *   - persists the choice in localStorage under `relayab-theme`
 *
 * Mounted only on the client; SSR uses the system pref so the initial
 * paint doesn't flash a wrong theme.
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange={false}
      storageKey="relayab-theme"
    >
      {children}
    </NextThemesProvider>
  );
}
