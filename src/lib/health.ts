/**
 * src/lib/health.ts
 *
 * Pure health-check logic, kept out of the route handler so it can be unit
 * tested directly.
 *
 * "Required" depends on where the data actually lives:
 *   - RELAY_AUTH is ALWAYS required.
 *   - A database is required only when a real store is in use. Outside
 *     production the default is an in-process mock
 *     (`EMULATE_VERCEL_LOCAL=1`), which needs nothing.
 *
 * The store is a local SQLite file by default (see `lib/db/sqlite.ts`), so
 * `storage` is normally "sqlite" and there is nothing to configure — no port,
 * no password, no service. "upstash" appears only when someone has explicitly
 * pointed the app at a hosted Redis, which remains a supported alternative.
 */

export interface HealthEnv {
  RELAY_AUTH?: string;
  /**
   * Path to the SQLite file. Being unset is normal — the store defaults to
   * `./data/relayab.db` under the working directory — so its absence must not
   * be reported as a missing variable.
   */
  RELAY_DB_PATH?: string;
  NODE_ENV?: string;
  EMULATE_VERCEL_LOCAL?: string;
  /**
   * Vercel-provided short SHA of the running deployment.
   *
   * Only present on Vercel. Off Vercel the revision falls through to
   * DOKKU_GIT_REV and then RELAY_BUILD_ID.
   */
  VERCEL_GIT_COMMIT_SHA?: string;
  /**
   * Dokku injects the deployed commit sha automatically. This is why a Dokku
   * deployment does not need RELAY_BUILD_ID set by hand — otherwise /healthz
   * would report `revision: null` and "did my deploy land?" becomes
   * unanswerable.
   */
  DOKKU_GIT_REV?: string;
  /** Fallback build identifier set by the operator when running off Vercel. */
  RELAY_BUILD_ID?: string;
}

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "unconfigured";
  storage: "sqlite";
  required: number;
  configured: number;
  missing?: string[];
  /** Short SHA (or operator-supplied build id) of the running build, or null. */
  revision: string | null;
}

/**
 * Presence check for an env var.
 *
 * Any non-empty value counts as configured. An earlier version additionally
 * required tokens to be longer than 10 characters ("looks like a token"),
 * which made `/healthz` report `degraded` for short-but-valid tokens and broke
 * the contract the tests encode: present == configured. Whether a database
 * file is actually writable is not something a health check can decide by
 * looking at a string — the client surfaces that at request time.
 */
function hasValue(val?: string): boolean {
  return Boolean(val?.trim());
}

function isTcpUrl(url: string): boolean {
  return url.startsWith("redis://") || url.startsWith("rediss://");
}

/**
 * Decide which transport this environment would use, and what (if anything) is
 * still missing for it.
 *
 * Mirrors the store selection in `lib/db/sqlite.ts`. When the two drifted,
 * `/healthz` reported `ok` for a half-configured box while every data route
 * threw — the report is only useful if it cannot disagree with the client that
 * actually got built.
 */
function resolveStorage(env: HealthEnv): {
  storage: HealthReport["storage"];
  missing: string[];
} {
  // SQLite is the only store. It is a file, so there is nothing to configure
  // and nothing to go missing — the report would be a constant otherwise,
  // but it stays derived rather than hard-coded so that a future store
  // addition has one place to change.
  void env;
  return { storage: "sqlite", missing: [] };
}

export function computeHealth(env: HealthEnv): HealthReport {
  const { storage, missing: storageMissing } = resolveStorage(env);

  const missing: string[] = [];
  if (!hasValue(env.RELAY_AUTH)) missing.push("RELAY_AUTH");
  missing.push(...storageMissing);

  // The database needs no configuration, so RELAY_AUTH is the only variable.
  const required = 1;
  const configured = required - missing.length;
  const status: HealthReport["status"] =
    missing.length === 0
      ? "ok"
      : missing.length >= required
        ? "unconfigured"
        : "degraded";

  const rawSha = env.VERCEL_GIT_COMMIT_SHA?.trim() || env.DOKKU_GIT_REV?.trim();
  // Short SHA only — never expose the full 40-char commit hash on a public
  // endpoint, and never include it in error paths.
  const revision =
    (rawSha && rawSha.length >= 7 ? rawSha.slice(0, 7) : null) ??
    env.RELAY_BUILD_ID?.trim() ??
    null;

  return {
    ok: missing.length === 0,
    status,
    storage,
    required,
    configured,
    missing: missing.length > 0 ? missing : undefined,
    revision,
  };
}
