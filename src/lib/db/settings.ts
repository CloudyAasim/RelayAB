/**
 * src/lib/db/settings.ts
 *
 * Admin-configurable application settings.
 *
 * Schema:
 *   TABLE settings → one row per setting (`key` is the PRIMARY KEY, `value` is
 *   TEXT NOT NULL). The Redis version kept these in a single `relay:settings`
 *   HASH; a key/value table is the same idea, and it means adding a setting
 *   later is a code change rather than a migration of a serialised blob.
 *
 * `AppSettings` stays a typed object at this boundary, so every caller keeps
 * reading `settings.publicUrl` and none of the admin UI or `public-url.ts`
 * needs to know how the value is stored.
 */
import { getOne, run, withTransaction } from "./sqlite";

export interface AppSettings {
  publicUrl?: string;
}

/** Row key in `settings`; mirrors the `AppSettings` field it backs. */
const PUBLIC_URL_KEY = "publicUrl";

/**
 * Read the stored settings.
 *
 * An unset setting is reported as `undefined`, never an empty string, so the
 * settings form and `public-url.ts` can use plain truthiness. That is the same
 * normalisation the Redis version got from `raw.publicUrl || undefined`, and it
 * is why the empty-hash case collapses to `{}` here too.
 */
export async function getSettings(): Promise<AppSettings> {
  const row = getOne<{ value: string }>("SELECT value FROM settings WHERE key = ?", [
    PUBLIC_URL_KEY,
  ]);
  if (!row) return {};
  return { publicUrl: row.value || undefined };
}

/**
 * Write only the keys present in `settings`, then return the merged result.
 *
 * Upsert instead of "read, then insert or update": the Redis version's HSET was
 * already a one-shot write that needed no existence check, and this is its SQL
 * equivalent. Keys left `undefined` are skipped, so a partial patch cannot wipe
 * a setting the caller did not mention.
 *
 * The write and the read-back share one transaction. A concurrent admin update
 * cannot slip between them and make the returned object disagree with what is
 * on disk — the returned value is exactly the post-write state.
 */
export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  return withTransaction(async () => {
    if (settings.publicUrl !== undefined) {
      run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [PUBLIC_URL_KEY, settings.publicUrl],
      );
    }
    return getSettings();
  });
}
