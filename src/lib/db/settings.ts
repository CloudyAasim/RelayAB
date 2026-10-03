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
   * Show the model catalogue on the *public* docs page, before sign-in.
   *
   * A relay that publishes its catalogue is normal, and the public docs are
   * where someone evaluating it looks first. But a self-hosted private relay
   * may not want its vendor list readable by anyone, so this is the operator's
   * call rather than a default.
   */
  publicCatalog?: boolean;
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
  /**
   * Documentation the operator wrote, rendered *inside* the built-in chapters.
   *
   * Stored as a JSON blob under one key, like `modelNotes`: this is prose that
   * changes rarely, is read whole, and has no query shape. Splitting it into
   * rows would buy nothing and cost a table.
   *
   * Deliberately not a way to edit the built-in pages. Those are the pages
   * that describe the protocol, and a page that says something else about the
   * same subject is worse than a missing one. This is for the things only the
   * operator knows: their usage policy, their rate limits, which model to pick.
   */
  docPages?: DocPage[];
}

export interface DocPage {
  /** Slug, unique across the pages. Also the anchor on the page. */
  id: string;
  title: string;
  /** Markdown. Rendered with the same audited path the rest of the docs use. */
  body: string;
  /**
   * Which built-in chapter this page belongs to.
   *
   * The point of the field. A page parked in its own chapter at the end of the
   * outline is an appendix; a page filed under the chapter it is about is part
   * of the document — the reader who wants to know the rate limit is already
   * on the endpoints page, and the answer is there.
   *
   * Absent, or set to `notes`, means the dedicated chapter at the end.
   */
  section?: string;
  /**
   * Draft: written but not shown. The point of a draft is that the outline
   * does not change while it is being written, so a half-finished page never
   * appears in a reader's navigation.
   */
  hidden?: boolean;
  /** Sort order within its chapter; ties fall back to the title. */
  order?: number;
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
const PUBLIC_CATALOG_KEY = "publicCatalog";
const MODEL_NOTES_KEY = "modelNotes";
const DOC_PAGES_KEY = "docPages";

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

  const pages = parseJson<DocPage[] | undefined>(byKey.get(DOC_PAGES_KEY), undefined);
  if (pages && Array.isArray(pages) && pages.length > 0) out.docPages = pages;

  // Stored as a string because the column is TEXT and everything else here is
  // a string; parsed into a boolean at the boundary so callers get a real one.
  const pub = byKey.get(PUBLIC_CATALOG_KEY)?.trim();
  if (pub === "true") out.publicCatalog = true;

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
    if (settings.publicCatalog !== undefined) {
      write(PUBLIC_CATALOG_KEY, settings.publicCatalog ? "true" : "false");
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
    if (settings.docPages !== undefined) {
      const pages = settings.docPages ?? [];
      if (pages.length === 0) {
        // Same reasoning as modelNotes: an empty array and an absent row are
        // different facts, and storing "[]" would lose that.
        run("DELETE FROM settings WHERE key = ?", [DOC_PAGES_KEY]);
      } else {
        write(DOC_PAGES_KEY, JSON.stringify(pages));
      }
    }
    return getSettings();
  });
}
