/**
 * src/lib/db/settings.ts
 *
 * Admin-configurable application settings.
 *
 * Schema:
 *   TABLE settings → one row per setting (`key` is the PRIMARY KEY, `value` is
 *   TEXT NOT NULL). A key/value table means adding a setting later is a code
 *   change rather than a migration of a serialised blob.
 *
 * `AppSettings` stays a typed object at this boundary, so callers keep reading
 * `settings.publicUrl` and neither the admin UI nor `public-url.ts` needs to
 * know how the value is stored.
 *
 * A deliberate split runs through what is here. `publicUrl` and
 * `defaultContextLength` are *operational* — they change behaviour, so they
 * are typed and validated. `siteName`, `announcement` and `modelNotes` are
 * *presentation* — they only change what the docs page says. Keeping the two
 * apart is what stops a copy edit from silently becoming a routing change.
 */
import { getAll, getOne, run, withTransaction } from "./sqlite";

export interface AppSettings {
  publicUrl?: string;
  /** Shown in the header of the user-facing docs. No effect on routing. */
  siteName?: string;
  /** One line under the site name. */
  siteDescription?: string;
  /** Markdown, rendered on the docs landing page. */
  announcement?: string;
  /** Where to send people with problems. */
  supportContact?: string;
  /**
   * Per-model documentation overrides, keyed by client-visible model id.
   *
   * The *facts* — which models exist, their context window, their price —
   * are read live from the provider table and can never be edited here.
   * What an operator can set is the prose around them: a display name, a
   * note, whether to advertise the model at all, and which capability tag to
   * show. Overriding a fact from here would only put the docs at odds with
   * the gateway, so the type has no field for one.
   */
  modelNotes?: Record<string, ModelNote>;
}

export interface ModelNote {
  /** Renames the model in the docs without renaming it on the wire. */
  displayName?: string;
  /** Short paragraph: when to pick this model, what it is good at. */
  note?: string;
  /** Capability label shown as a tag, e.g. "chat" / "vision" / "fast". */
  tags?: string[];
  /** Hide from the public list without disabling the model. */
  hidden?: boolean;
}

/** Row key in `settings`; mirrors the `AppSettings` field it backs. */
const PUBLIC_URL_KEY = "publicUrl";
const SITE_NAME_KEY = "siteName";
const SITE_DESCRIPTION_KEY = "siteDescription";
const ANNOUNCEMENT_KEY = "announcement";
const SUPPORT_CONTACT_KEY = "supportContact";
const MODEL_NOTES_KEY = "modelNotes";

/** Every scalar key, so a read is one query rather than one per field. */
const SCALAR_KEYS = [
  PUBLIC_URL_KEY,
  SITE_NAME_KEY,
  SITE_DESCRIPTION_KEY,
  ANNOUNCEMENT_KEY,
  SUPPORT_CONTACT_KEY,
] as const;

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    // A hand-edited or truncated row must not take the docs page down; the
    // operator's other settings still render.
    return fallback;
  }
}

/**
 * Read the stored settings.
 *
 * An unset setting is reported as `undefined`, never an empty string, so the
 * settings form and `public-url.ts` can use plain truthiness.
 */
export async function getSettings(): Promise<AppSettings> {
  const rows = getAll<{ key: string; value: string }>("SELECT key, value FROM settings");
  if (rows.length === 0) return {};

  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: AppSettings = {};
  for (const key of SCALAR_KEYS) {
    const value = byKey.get(key)?.trim();
    if (value) out[key] = value;
  }
  const notes = parseJson<Record<string, ModelNote> | undefined>(
    byKey.get(MODEL_NOTES_KEY),
    undefined,
  );
  if (notes && Object.keys(notes).length > 0) out.modelNotes = notes;
  return out;
}

/** Write only the keys present in `settings`, then return the merged result. */
export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  return withTransaction(async () => {
    const write = (key: string, value: string): void => {
      run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    };

    for (const key of SCALAR_KEYS) {
      const value = settings[key];
      if (value !== undefined) write(key, value.trim());
    }
    if (settings.modelNotes !== undefined) {
      const notes = settings.modelNotes ?? {};
      if (Object.keys(notes).length === 0) {
        // Storing "{}" forever means the row can never be distinguished from a
        // real (empty) configuration; drop it instead.
        run("DELETE FROM settings WHERE key = ?", [MODEL_NOTES_KEY]);
      } else {
        write(MODEL_NOTES_KEY, JSON.stringify(notes));
      }
    }
    return getSettings();
  });
}
