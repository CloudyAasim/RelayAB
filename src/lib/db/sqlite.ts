/**
 * src/lib/db/sqlite.ts
 *
 * SQLite connection management, schema and row↔entity mapping.
 *
 * Replaces the previous Redis-backed store. The database is a single file
 * managed by Node's built-in `node:sqlite` (Node >= 22.5) -no service to
 * install, no port to bind, no password to configure, and no container
 * networking to get wrong. Backup is "copy the file".
 *
 * Design notes:
 * - Entities are defined once as Zod schemas in `types.ts`. Tables mirror
 *   those fields one-to-one, and every read runs the row back through the
 *   same schema. That replaces the hand-written `hashTo*` deserialisers the
 *   Redis version needed (Upstash auto-parses JSON, so every field had to be
 *   decoded defensively) with a single `parse` call.
 * - Structured values (`allowedModels`, `modelMapping`, `modelConfigs`,
 *   `headers`, `models`, `specs`) are stored as JSON text. SQLite has no map
 *   type, and these are read whole and written whole -never queried into.
 * - Booleans are stored as INTEGER 0/1. `node:sqlite` has no boolean binding,
 *   so `toRow`/`fromRow` normalise explicitly rather than letting a truthy
 *   number leak into the entity.
 * - Timestamps stay ISO strings, matching what the Zod schemas and the whole
 *   app already use. `createdAt`/`updatedAt` remain text so every existing
 *   comparison and sort keeps working unchanged.
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ApiKeySchema,
  ProviderSchema,
  UserSchema,
  UsageLogSchema,
  type ApiKey,
  type Provider,
  type User,
  type UsageLog,
} from "./types";
import type { MediaProvider } from "../media/spec";

/**
 * `node:sqlite` is a Node builtin (>= 22.5), but the bundlers in this project
 * predate it and try to resolve it from npm: the Vitest run dies with
 * "Failed to load url sqlite" and the Next build chokes on it too.
 *
 * It is therefore declared external in two places — `server.deps.external` in
 * vitest.config.ts and `webpack.externals` in next.config.ts. The import is
 * static rather than a dynamic createRequire so that both bundlers can see it
 * and externalise it explicitly, instead of one of them being bypassed.
 */
export type Database = InstanceType<typeof DatabaseSync>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Applied in order on every open; each statement is idempotent
 * (`IF NOT EXISTS`), so this doubles as the migration mechanism. There is no
 * released SQLite schema yet, so `schema_version` is bookkeeping for the first
 * change that will need it rather than a used facility today.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  timezone       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_login_at  TEXT,
  quota_type     TEXT NOT NULL,
  quota_limit    INTEGER NOT NULL,
  quota_used     INTEGER NOT NULL DEFAULT 0,
  max_active_keys INTEGER NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  expires_at     TEXT,
  force_disabled INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  last_used_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS providers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL,
  base_url           TEXT,
  encrypted_api_key  TEXT NOT NULL,
  model_mapping      TEXT NOT NULL DEFAULT '{}',
  model_configs      TEXT NOT NULL DEFAULT '{}',
  enabled            INTEGER NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,
  headers            TEXT NOT NULL DEFAULT '{}',
  upstream_format    TEXT NOT NULL DEFAULT 'responses',
  openai_enabled     INTEGER NOT NULL DEFAULT 1,
  anthropic_enabled  INTEGER NOT NULL DEFAULT 0,
  anthropic_base_url TEXT,
  text_specs         TEXT,
  active_mode        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  enabled           INTEGER NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  models            TEXT NOT NULL DEFAULT '{}',
  specs             TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id                TEXT PRIMARY KEY,
  api_key_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  model             TEXT NOT NULL,
  upstream_model    TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  credits_used      INTEGER NOT NULL DEFAULT 0,
  images            INTEGER,
  capability        TEXT,
  status            TEXT NOT NULL,
  error_message     TEXT,
  billing_mode      TEXT,
  cached_prompt_tokens INTEGER,
  cache_write_tokens   INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_logs_key     ON usage_logs(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user    ON usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);

-- Running per-key totals. Kept as a separate table rather than recomputed with
-- a SUM over usage_logs on every request: the proxy path reads it on every
-- single call, and the Redis version relied on HINCRBY for the same reason.
CREATE TABLE IF NOT EXISTS usage_totals (
  api_key_id        TEXT PRIMARY KEY,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  credits_used      INTEGER NOT NULL DEFAULT 0,
  images            INTEGER NOT NULL DEFAULT 0,
  requests          INTEGER NOT NULL DEFAULT 0
);

-- Small key/value bag (currently just publicUrl). A table rather than a
-- settings blob so adding a setting does not need a schema change.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Whether the one-time bootstrap has run. The Redis version claimed the slot
-- with SETNX; here an INSERT that violates the primary key is the same trick
-- expressed in SQL, and it is race-free inside a transaction.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Login failure counters for the throttle in lib/auth/login-throttle.ts.
-- A table of its own rather than a settings row: it is written on every failed
-- login and must never collide with application data. expires_at is epoch
-- seconds so the rolling window is a plain integer comparison.
CREATE TABLE IF NOT EXISTS login_throttle (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The AI assistant runs on the *user's own* upstream key rather than on the
-- admin's providers, so the configuration is per user: one row per person,
-- absent until they set it up. encrypted_api_key uses the same master key as
-- provider keys, which is why a database backup is as sensitive as ever.
CREATE TABLE IF NOT EXISTS assistant_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_url           TEXT NOT NULL,
  encrypted_api_key  TEXT NOT NULL,
  model              TEXT NOT NULL,
  protocol           TEXT NOT NULL DEFAULT 'openai',
  extra_headers      TEXT NOT NULL DEFAULT '{}',
  -- The model's own parameters. Nullable throughout, and nullable is the
  -- default: absent means "do not send it", so a row written before these
  -- columns existed keeps making exactly the requests it used to.
  context_length     INTEGER,
  max_output_tokens  INTEGER,
  temperature        REAL,
  top_p              REAL,
  -- How hard the model thinks, as the effort level a vendor publishes.
  -- Text rather than a number, because minimal/low/medium/high is the spelling
  -- the APIs use and a scale of our own would need inventing values for it.
  -- Nullable, like the rest, so "not sent" stays a real answer.
  reasoning_effort   TEXT,
  -- Whether the model thinks, as the vendor's own switch. A separate column
  -- from reasoning_effort because the two are different fields on the wire for
  -- the vendors that have both, and a request that carries only the effort can
  -- never turn thinking off. Nullable, like every other parameter here: absent
  -- means the vendor decides, which on one of these models is its deepest and
  -- most expensive level rather than "off".
  thinking_type      TEXT,
  -- Which credential the next turn spends, and the model the account path
  -- uses. Nullable on purpose: a row written before these existed has a key, a
  -- base URL and a model in it, which is exactly what "key" means, so NULL is
  -- read as the key path and nobody is moved.
  credential_mode    TEXT,
  account_model      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- The one credential the assistant may spend on a user's behalf, authorised by
-- their *session* rather than by a pasted secret.
--
-- It points at an ordinary api_keys row on purpose. Usage and quota are
-- accounted per key (usage_logs.api_key_id is NOT NULL, usage_totals is keyed by
-- it), so the alternative — attributing assistant calls to no key at all —
-- would mean reworking the per-request hot path. Reusing a real row keeps every
-- existing check, whitelist and ledger entry working unchanged.
--
-- What makes it different from the other three kinds of row in this file is
-- that its plaintext is never generated, never stored and never shown: the
-- assistant holds the ApiKey object itself and calls the proxy in-process, so
-- there is no bearer token anywhere for anyone to copy. That is also why
-- "rebuild" is the only way to change it — there is nothing to re-read.
--
-- One row per user: the primary key *is* the "at most one" rule, so the limit
-- cannot drift from the data the way a checked-in counter could. Absent means
-- never created, and enabled defaults to 0, so the feature is off until the
-- user turns it on.
CREATE TABLE IF NOT EXISTS assistant_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Media the assistant produced, kept so the conversation can show it.
--
-- Without this the only thing a generated image or a spoken line ever was, both
-- to the reader and to the model, was a line of text: the upstream URL for
-- images, and a byte count for audio, whose bytes were then thrown away. Audio
-- has no URL at all, so there was nothing for a <audio> tag to point at and no
-- way to get one without paying for the same synthesis twice.
--
-- The bytes column is null when the upstream already gave us a durable link, which is
-- the normal case for images and video; the route then redirects rather than
-- proxying, so nothing large is stored. It is only populated for results that
-- have no URL of their own - audio, and images the vendor returned inline.
CREATE TABLE IF NOT EXISTS assistant_artifacts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  url          TEXT,
  bytes        BLOB,
  content_type TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_artifacts_thread ON assistant_artifacts(thread_id);

-- Conversations. Threads are per user so one person's history can never be
-- read through another's id, and messages cascade with the thread.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_user ON assistant_threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tool_calls    TEXT,
  tool_call_id  TEXT,
  tool_name     TEXT,
  attachments   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages(thread_id, created_at);

-- Changes the assistant wants to make, waiting for a human.
--
-- The assistant never writes provider configuration directly. It records an
-- intent here; the admin sees a rendered diff and decides. The args column is
-- the exact payload that will be applied, diff is the human-readable preview,
-- and the status moves pending -> applied / rejected / failed. Making the
-- step a row rather than a client-side dialog means a page refresh cannot lose
-- a pending change, and the applied payload is auditable after the fact.
CREATE TABLE IF NOT EXISTS assistant_actions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  target_id   TEXT,
  summary     TEXT NOT NULL,
  args        TEXT NOT NULL,
  diff        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  result      TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_user ON assistant_actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_status ON assistant_actions(status, created_at DESC);
`;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let db: Database | null = null;

const DB_GLOBAL_KEY = "__relayabSqlite";
type RelayGlobal = typeof globalThis & {
  [DB_GLOBAL_KEY]?: Database;
};

function resolvePath(): string {
  // RELAY_DB_PATH lets tests point at a temp file and lets the systemd unit
  // place the database outside the release directory so `git pull` and a
  // rebuild can never touch it. `:memory:` is honoured for tests.
  const configured = process.env.RELAY_DB_PATH?.trim();
  if (configured) return configured;

  // Default next to the repo, which is where the systemd unit runs from.
  // Single-node deployments can point RELAY_DB_PATH at a dedicated volume.
  return `${process.cwd()}/data/relayab.db`;
}

/**
 * The shared connection.
 *
 * Pinned to `globalThis` for the same reason the Redis client was: `next dev`
 * re-evaluates modules on every hot update, and a fresh `DatabaseSync` per
 * reload would leak file handles until the process runs out.
 */
export function getDb(): Database {
  const g = globalThis as RelayGlobal;
  if (db) return db;
  if (g[DB_GLOBAL_KEY]) {
    db = g[DB_GLOBAL_KEY];
    return db;
  }

  const path = resolvePath();
  if (path !== ":memory:") {
    // The directory may not exist on a fresh install; failing here with ENOENT
    // would surface as an opaque error on the first query.
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      throw new Error(
        `[relayab] Cannot create the directory for the database at ${dirname(path)}. ` +
          `RELAY_DB_PATH is set to ${path}. Inside a container this must be a ` +
          `mounted volume, not a host path — e.g. /data/relayab.db created by ` +
          `\`dokku storage:mount <app> /home/dokku/data/<app>:/data\`. ` +
          `A database left in the container's own filesystem is erased on every ` +
          `rebuild. (underlying error: ${err instanceof Error ? err.message : err})`,
      );
    }
  }

  const conn = new DatabaseSync(path);

  // WAL keeps readers from blocking the writer, which matters because the
  // proxy writes a usage row while a dashboard may be reading aggregates.
  // `busy_timeout` turns a lock collision into a short wait instead of an
  // immediate SQLITE_BUSY error.
  if (path !== ":memory:") {
    conn.exec("PRAGMA journal_mode = WAL");
  }
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec("PRAGMA busy_timeout = 5000");
  // Durability default is FULL; NORMAL is the usual WAL compromise and is
  // still crash-safe (only a power loss can lose the last commit).
  conn.exec("PRAGMA synchronous = NORMAL");

  conn.exec(SCHEMA);
  for (const col of ADDED_COLUMNS) addColumnIfMissing(conn, col);
  // Recorded for the first migration that needs it; harmless while unused.
  conn.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (1)").run();

  db = conn;
  g[DB_GLOBAL_KEY] = conn;
  return conn;
}

/**
 * Columns added after the first release.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, so a
 * deployed database would keep the old shape and every query naming one of
 * these would fail at runtime — long after the build that introduced it had
 * gone green, and only on the deployment that actually had old data. Adding a
 * column is the one migration SQLite has no `IF NOT EXISTS` for, so the table
 * is asked instead.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  // Files the user attached to a message. A JSON array of artefact references,
  // beside `content` rather than inside it, for the same reason tool artefacts
  // are not: the model's context and the stored transcript should not grow by
  // however large someone's screenshot is.
  { table: "assistant_messages", column: "attachments", type: "TEXT" },
  // The provider's wire protocol, as one JSON document. `TEXT` and not a
  // validated blob: the shape is an operator-authored tree, and `parseTextSpec`
  // is the authority on it. Null means "no protocol, forward everything".
  { table: "providers", column: "text_spec", type: "TEXT" },
  // Replaces the single `text_spec`: one entry per compatibility interface the
  // provider serves. Kept as a separate migration because `ADD COLUMN` cannot
  // drop the old one, and a row that still has a single document is read as a
  // one-entry list — so a provider configured before this is not orphaned.
  { table: "providers", column: "text_specs", type: "TEXT" },
  // Which of the two configurations is in effect. Nullable on purpose: NULL
  // means "this row predates the choice, keep doing what it did", which is not
  // the same statement as 'simple' and must not be back-filled to it.
  { table: "providers", column: "active_mode", type: "TEXT" },
  // What the upstream served from, and wrote into, its own prompt cache. Two
  // columns rather than one because they are opposite events that look alike in
  // a usage table, and because only the read is a discount. Nullable so "this
  // vendor reported no cache" stays distinguishable from "0 cached".
  { table: "usage_logs", column: "cached_prompt_tokens", type: "INTEGER" },
  { table: "usage_logs", column: "cache_write_tokens", type: "INTEGER" },
  // The assistant's model parameters. All four nullable and all four default
  // to null, so upgrading cannot change the requests an existing assistant
  // makes — the failure mode of a defaulted sampling parameter is a model
  // that quietly answers differently after a deploy.
  { table: "assistant_settings", column: "context_length", type: "INTEGER" },
  { table: "assistant_settings", column: "max_output_tokens", type: "INTEGER" },
  { table: "assistant_settings", column: "temperature", type: "REAL" },
  { table: "assistant_settings", column: "top_p", type: "REAL" },
  { table: "assistant_settings", column: "reasoning_effort", type: "TEXT" },
  // Whether the model thinks at all, as opposed to how hard. A separate column
  // because on several vendors the two are different fields: MiniMax tunes depth
  // with `reasoning_effort` but switches thinking with `thinking.type`, and a
  // request that can only carry the first can never turn thinking off. Folding
  // them into one value would have to invent a vocabulary the vendors do not
  // share.
  { table: "assistant_settings", column: "thinking_type", type: "TEXT" },
  // Which credential the assistant spends, and the model it spends it on for
  // the account path. Both nullable so that upgrading cannot move anybody: NULL
  // reads as the key path, which is what every existing row is.
  { table: "assistant_settings", column: "credential_mode", type: "TEXT" },
  { table: "assistant_settings", column: "account_model", type: "TEXT" },
];

function addColumnIfMissing(
  conn: Database,
  { table, column, type }: { table: string; column: string; type: string },
): void {
  const existing = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (existing.length === 0 || existing.some((c) => c.name === column)) return;
  // The table and column names are literals in ADDED_COLUMNS, never input.
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Test-only: drop the cached handle so the next call reopens. */
export function __resetDbForTest(): void {
  const g = globalThis as RelayGlobal;
  try {
    g[DB_GLOBAL_KEY]?.close();
  } catch {
    // Already closed, or never opened -nothing to do.
  }
  db = null;
  delete g[DB_GLOBAL_KEY];
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside an IMMEDIATE transaction.
 *
 * IMMEDIATE (not DEFERRED) so the write lock is taken up front: a deferred
 * transaction that upgrades mid-way can fail with SQLITE_BUSY_SNAPSHOT, which
 * is exactly the race the bootstrap and quota paths hit when two requests land
 * at once.
 *
 * Nested calls join the outer transaction rather than failing, so a helper can
 * be reused from inside a larger atomic block.
 */
let txDepth = 0;
export async function withTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
  const conn = getDb();
  if (txDepth > 0) return await fn();

  conn.exec("BEGIN IMMEDIATE");
  txDepth++;
  try {
    const result = await fn();
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      // Rollback failing means the transaction was already aborted; the
      // original error is the one worth surfacing.
    }
    throw err;
  } finally {
    txDepth--;
  }
}

// ---------------------------------------------------------------------------
// Row -entity mapping
// ---------------------------------------------------------------------------

/** node:sqlite has no boolean binding; normalise explicitly. */
export const toDbBool = (v: boolean): number => (v ? 1 : 0);
export const fromDbBool = (v: unknown): boolean => Number(v) === 1;

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt column must not take down the whole read. Fall back and let
    // the Zod schema apply its own defaults/validation.
    return fallback;
  }
}

export function rowToUser(row: Record<string, unknown>): User {
  return UserSchema.parse({
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    displayName: row.display_name,
    timezone: row.timezone ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
    quotaType: row.quota_type,
    quotaLimit: row.quota_limit,
    quotaUsed: row.quota_used,
    maxActiveKeys: row.max_active_keys,
    allowedModels: parseJson<string[]>(String(row.allowed_models ?? "[]"), []),
  });
}

export function rowToApiKey(row: Record<string, unknown>): ApiKey {
  return ApiKeySchema.parse({
    id: row.id,
    userId: row.user_id,
    label: row.label,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    expiresAt: row.expires_at ?? null,
    forceDisabled: fromDbBool(row.force_disabled),
    enabled: fromDbBool(row.enabled),
    allowedModels: parseJson<string[]>(String(row.allowed_models ?? "[]"), []),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  });
}

export function rowToProvider(row: Record<string, unknown>): Provider {
  return ProviderSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url ?? null,
    encryptedApiKey: row.encrypted_api_key,
    modelMapping: parseJson<Record<string, string>>(String(row.model_mapping ?? "{}"), {}),
    modelConfigs: parseJson(String(row.model_configs ?? "{}"), {}),
    enabled: fromDbBool(row.enabled),
    priority: row.priority,
    headers: parseJson<Record<string, string>>(String(row.headers ?? "{}"), {}),
    upstreamFormat: row.upstream_format,
    openaiEnabled: fromDbBool(row.openai_enabled),
    anthropicEnabled: fromDbBool(row.anthropic_enabled),
    anthropicBaseUrl: row.anthropic_base_url ?? null,
    // A row written before the list existed holds one document. Folded into a
    // one-entry list here, at the boundary, so nothing downstream needs to know
    // the old shape ever existed — and `ADD COLUMN` cannot drop the column, so
    // it stays readable either way.
    textSpecs: (() => {
      const list = parseJson<string[]>(String(row.text_specs ?? "[]"), []);
      if (list.length) return list;
      const legacy = row.text_spec;
      return typeof legacy === "string" && legacy ? [legacy] : [];
    })(),
    // NULL here is "this row was written before the choice existed", and it is
    // left NULL rather than back-filled: `activeModeOf` gives those rows the
    // behaviour they always had, and writing "simple" here would read as an
    // explicit choice nobody made.
    activeMode: row.active_mode === "simple" || row.active_mode === "advanced" ? row.active_mode : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function rowToUsageLog(row: Record<string, unknown>): UsageLog {
  return UsageLogSchema.parse({
    id: row.id,
    apiKeyId: row.api_key_id,
    userId: row.user_id,
    providerId: row.provider_id,
    model: row.model,
    upstreamModel: row.upstream_model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    creditsUsed: row.credits_used,
    // `images` and `capability` are optional on the entity: absent for chat
    // calls, so a NULL column must stay `undefined` rather than becoming 0.
    ...(row.images === null || row.images === undefined ? {} : { images: row.images }),
    ...(row.capability === null || row.capability === undefined
      ? {}
      : { capability: row.capability }),
    status: row.status,
    errorMessage: row.error_message ?? null,
    // Absent, not 0: a row from a vendor that reports no cache is not a row
    // that hit 0% of its cache.
    ...(typeof row.cached_prompt_tokens === "number"
      ? { cachedPromptTokens: row.cached_prompt_tokens }
      : {}),
    ...(typeof row.cache_write_tokens === "number"
      ? { cacheWriteTokens: row.cache_write_tokens }
      : {}),
    billingMode: row.billing_mode ?? undefined,
    createdAt: row.created_at,
  });
}

export function rowToMediaProvider(row: Record<string, unknown>): MediaProvider {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    encryptedApiKey: String(row.encrypted_api_key),
    enabled: fromDbBool(row.enabled),
    priority: Number(row.priority ?? 0),
    models: parseJson(String(row.models ?? "{}"), {}),
    specs: parseJson(String(row.specs ?? "[]"), []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  } as MediaProvider;
}

// ---------------------------------------------------------------------------
// Small query helpers
// ---------------------------------------------------------------------------

/** `SELECT` returning at most one row, already parsed. */
export function getOne<T>(
  sql: string,
  params: readonly unknown[] = [],
  map: (row: Record<string, unknown>) => T = (r) => r as T,
): T | null {
  const row = getDb().prepare(sql).get(...(params as never[]));
  return row ? map(row as Record<string, unknown>) : null;
}

/** `SELECT` returning every row, already parsed. */
export function getAll<T>(
  sql: string,
  params: readonly unknown[] = [],
  map: (row: Record<string, unknown>) => T = (r) => r as T,
): T[] {
  return getDb()
    .prepare(sql)
    .all(...(params as never[]))
    .map((r) => map(r as Record<string, unknown>));
}

/** Number of rows an `UPDATE`/`DELETE` touched. */
export function run(sql: string, params: readonly unknown[] = []): number {
  const result = getDb().prepare(sql).run(...(params as never[]));
  return Number(result.changes ?? 0);
}
