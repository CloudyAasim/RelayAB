/**
 * Shared i18n types. Lives in its own module so helpers like
 * `api-errors.ts` can depend on the translator's shape without importing
 * the React provider (which would drag client-only code into server bundles).
 */
export type TFunction = (
  key: string,
  vars?: Record<string, string | number>,
) => string;
