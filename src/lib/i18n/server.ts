/**
 * src/lib/i18n/server.ts
 *
 * Server-side translation helper.
 * Reads the `relayab_locale` cookie (or falls back to `RELAY_DEFAULT_LOCALE`)
 * and returns a `t(key, vars)` function bound to that locale.
 *
 * Use in Server Components:
 *   const { t, locale } = await getT();
 *   return <h1>{t("login.pageTitle")}</h1>;
 */
import { cookies } from "next/headers";
import {
  translate,
  parseLocale,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  type Locale,
} from "./dict";
import { loadConfig } from "../config";
import { apiErrorMessage } from "./api-errors";

export { LOCALE_COOKIE };

/**
 * Resolve the active locale for a server component.
 *
 * Resolution order:
 *   1. `relayab_locale` cookie (explicit user choice via the footer switcher).
 *   2. `RELAY_DEFAULT_LOCALE` env var (operator's project default).
 *
 * Accept-Language is deliberately NOT consulted. RelayAB's primary audience
 * is Chinese-speaking, and "the browser said en" is a poor proxy for "the
 * operator wants an English UI" — it surprised operators whose browsers
 * ship with an en-* Accept-Language. Deployments that prefer English set
 * `RELAY_DEFAULT_LOCALE=en`.
 *
 * Visitors can always override via the footer language switcher, which
 * writes the cookie consulted in step 1.
 */
export async function getServerLocale(): Promise<Locale> {
  const c = await cookies();
  const fromCookie = c.get(LOCALE_COOKIE)?.value;
  if (fromCookie) return parseLocale(fromCookie);

  // Operator-configured default.
  try {
    const cfg = loadConfig();
    return parseLocale(cfg.RELAY_DEFAULT_LOCALE);
  } catch {
    // loadConfig can fail at module init time on certain test paths; fall
    // back to the hardcoded default locale in that case.
    return DEFAULT_LOCALE;
  }
}

export async function getT(): Promise<{ t: (key: string, vars?: Record<string, string | number>) => string; locale: Locale }> {
  const locale = await getServerLocale();
  return {
    locale,
    t: (key, vars) => translate(locale, key, vars),
  };
}

/**
 * Localize a machine-readable API error code in a server context (route
 * handlers, server actions). Mirrors the client-side `apiErrorMessage` helper
 * so server-generated messages (flash banners) speak the same language as the
 * UI that renders them.
 */
export async function apiErrorText(code: string, fallback?: string): Promise<string> {
  const { t } = await getT();
  return apiErrorMessage(t, code, fallback);
}

// Convenience for sync contexts (rare).
export function tSync(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  return translate(locale, key, vars);
}

export { DEFAULT_LOCALE, type Locale };
