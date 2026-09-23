"use client";

/**
 * src/components/i18n/LocaleSwitcher.tsx
 *
 * Locale dropdown. Uses useTransition so that:
 *  - the locale change itself doesn't block input events
 *  - React can keep the previous UI rendered briefly while re-rendering
 *
 * After setting locale, calls router.refresh() to re-render server components
 * with the new locale.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleLocaleChange = (next: Locale) => {
    // The dictionary ships in the client bundle, so re-labelling the UI needs
    // no server work and must not wait for any. Previously `setLocale` and
    // `router.refresh()` were in the *same* transition, which held the new
    // language back until the RSC round trip finished — on a slow server the
    // language appeared to "not switch" at all.
    setLocale(next);
    // Only the server-rendered text (error banners, flash messages) needs the
    // refresh, so it stays non-urgent and off the critical path.
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className={`text-muted-foreground transition-opacity ${isPending ? "opacity-50" : ""}`}>
        🌐
      </span>
      <select
        aria-label={t("footer.language")}
        value={locale}
        onChange={(e) => handleLocaleChange(e.target.value as Locale)}
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
