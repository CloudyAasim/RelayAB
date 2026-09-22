/**
 * src/lib/i18n/api-errors.ts
 */
import type { TFunction } from "./types";

const CODE_TO_KEY: Record<string, string> = {
  // auth / session
  unauthenticated: "apiError.unauthenticated",
  forbidden: "apiError.forbidden",
  user_not_found: "apiError.userNotFound",
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
  // admin user actions
  self_delete: "apiError.selfDelete",
};

export function apiErrorMessage(
  t: TFunction,
  code: string | undefined,
  fallback?: string,
): string {
  const key = code ? CODE_TO_KEY[code] : undefined;
  if (key) {
    const localized = t(key);
    if (localized !== key) return localized;
  }
  return fallback ?? t("common.failed");
}
