"use client";

/**
 * src/components/i18n/I18nProvider.tsx
 *
 * Performance-aware locale provider.
 *
 * Design choices:
 * 1. Three SEPARATE contexts (locale, t, setLocale) so a consumer using
 *    `useLocale()` does not re-render when only `t` is "new" or vice versa.
 *    `setLocale` is a stable callback (empty deps) so consumers that
 *    subscribe via setLocale never re-render unless locale itself changes.
 * 2. `t` is memoized PER LOCALE via a Map cache so it has a stable
 *    reference across renders when locale is unchanged.
 * 3. `setLocale()` is wrapped in `useTransition` via the consumer (LocaleSwitcher)
 *    so a click does NOT block the UI while the cookie write commits.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from "react";
import {
  translate,
  parseLocale,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  type Locale,
} from "@/lib/i18n/dict";

type TFunction = (key: string, vars?: Record<string, string | number>) => string;

// One context per "axis" — components subscribe to only what they need.
const LocaleCtx = createContext<Locale>(DEFAULT_LOCALE);
const SetLocaleCtx = createContext<(l: Locale) => void>(() => {});
const TFnCtx = createContext<TFunction>(
  (key, vars) => translate(DEFAULT_LOCALE, key, vars),
);

/**
 * Read an EXPLICIT user locale choice (cookie, then localStorage).
 *
 * Returns `null` when the visitor has never picked a language, so the
 * caller can keep the server-rendered `initialLocale` (which already
 * honors `RELAY_DEFAULT_LOCALE`) instead of clobbering it with a
 * hardcoded default. That mismatch used to cause an English flash on
 * Chinese-default deployments that happened to send an en-* header.
 */
function readStoredLocale(): Locale | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`),
  );
  if (m) return parseLocale(decodeURIComponent(m[1]));
  try {
    const fromLs = window.localStorage.getItem(LOCALE_COOKIE);
    if (fromLs) return parseLocale(fromLs);
  } catch {
    /* localStorage may be blocked */
  }
  return null;
}

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // On mount, adopt an explicit stored choice if there is one. When the
  // visitor has never chosen, we deliberately keep `initialLocale` — the
  // server already resolved it from RELAY_DEFAULT_LOCALE.
  const syncedOnceRef = useRef(false);
  useEffect(() => {
    if (syncedOnceRef.current) return;
    syncedOnceRef.current = true;
    const stored = readStoredLocale();
    if (stored && stored !== locale) setLocaleState(stored);
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof document !== "undefined") {
      const oneYear = 60 * 60 * 24 * 365;
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(l)}; path=/; max-age=${oneYear}; SameSite=Lax`;
      try {
        window.localStorage.setItem(LOCALE_COOKIE, l);
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Memoize `t` per locale. Same-locale renders return the same function
  // reference, so `useT()` consumers don't re-render unless locale changed.
  const t = useMemo<TFunction>(() => {
    const fn: TFunction = (key, vars) => translate(locale, key, vars);
    return fn;
  }, [locale]);

  return (
    <LocaleCtx.Provider value={locale}>
      <SetLocaleCtx.Provider value={setLocale}>
        <TFnCtx.Provider value={t}>
          {children}
        </TFnCtx.Provider>
      </SetLocaleCtx.Provider>
    </LocaleCtx.Provider>
  );
}

/** Returns just the current locale. Re-renders only when locale changes. */
export function useLocale(): Locale {
  return useContext(LocaleCtx);
}

/** Returns just the setter. Reference is stable across renders. */
export function useSetLocale(): (l: Locale) => void {
  return useContext(SetLocaleCtx);
}

/** Returns just the translator. Reference is stable until locale changes. */
export function useT(): TFunction {
  return useContext(TFnCtx);
}

/** Returns { locale, setLocale } without forcing re-render on `t` changes. */
export function useLocaleWithSetter(): { locale: Locale; setLocale: (l: Locale) => void } {
  const locale = useContext(LocaleCtx);
  const setLocale = useContext(SetLocaleCtx);
  return { locale, setLocale };
}

export { LOCALE_LABELS, SUPPORTED_LOCALES };
export type { Locale };
