"use client";

/**
 * src/components/i18n/LocaleSwitcher.tsx
 *
 * Locale dropdown. Uses useTransition so that:
 *  - the locale change itself doesn't block input events
 *  - React can keep the previous UI rendered briefly while re-rendering
 */
import { useTransition } from "react";
import {
  useLocaleWithSetter,
  useT,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "./I18nProvider";

export function LocaleSwitcher() {
  const t = useT();
  const { locale, setLocale } = useLocaleWithSetter();
  const [isPending, startTransition] = useTransition();
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className={`text-muted-foreground transition-opacity ${isPending ? "opacity-50" : ""}`}>
        🌐
      </span>
      <select
        aria-label={t("footer.language")}
        value={locale}
        onChange={(e) => {
          const next = e.target.value as Locale;
          startTransition(() => setLocale(next));
        }}
        className="rounded border border-input bg-background px-1.5 py-0.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
