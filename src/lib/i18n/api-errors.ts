/**
 * src/lib/i18n/api-errors.ts
 *
 * Maps the machine-readable `error.code` values that route handlers return
 * onto UI translation keys.
 *
 * Route handlers respond with `{ ok: false, error: { code, message } }` where
 * `message` is a developer-facing English string. Rendering that string
 * directly put English error text inside an otherwise Chinese UI, so
 * user-facing forms resolve the code through the active locale instead and
 * only fall back to the server text for codes we don't know.
 */
import type { TFunction } from "./types";

/**
 * Known error code → translation key. Codes absent from this map fall back
 * to the server's message (better a readable sentence than a raw code).
 */
const CODE_TO_KEY: Record<string, string> = {
  // auth / session
  unauthenticated: "apiError.unauthenticated",
  forbidden: "apiError.forbidden",
  user_not_found: "apiError.userNotFound",
  user_disabled: "apiError.userDisabled",
  // change-password
  wrong_current_password: "settings.password.errorWrongCurrent",
  password_mismatch: "settings.password.errorMismatch",
  password_too_short: "apiError.passwordTooShort",
  password_too_long: "apiError.passwordTooLong",
  password_unchanged: "settings.password.errorUnchanged",
  // user API keys
  max_keys_reached: "apiError.maxKeysReached",
  not_found: "apiError.notFound",
  bad_request: "apiError.badRequest",
  bad_json: "apiError.badRequest",
  // generic
  internal_error: "apiError.internal",
  update_failed: "apiError.internal",
  delete_failed: "apiError.internal",
};

/**
 * Resolve a route-handler error into a localized message.
 *
 * @param t         translator bound to the active locale
 * @param code      `error.code` from the API response
 * @param fallback  the server's own `error.message` (used when the code is unknown)
 */
export function apiErrorMessage(
  t: TFunction,
  code: string | undefined,
  fallback?: string,
): string {
  const key = code ? CODE_TO_KEY[code] : undefined;
  if (key) {
    const localized = t(key);
    // translate() returns the key itself when a string is missing; prefer
    // the server message in that case so we never show a raw i18n key.
    if (localized !== key) return localized;
  }
  return fallback ?? t("common.failed");
}
