/**
 * src/lib/health.ts
 *
 * Pure health-check logic, kept out of the route handler so it can be unit
 * tested directly.
 *
 * SQLite is the only store (see `lib/db/sqlite.ts`): a file managed by Node's
 * built-in `node:sqlite`, with no service to start, no port to bind and no
 * password. So there is exactly one variable to check — RELAY_AUTH — and
 * `storage` is always "sqlite".
 *
 * Presence is all this can check. Whether the database file is actually
 * writable is a filesystem question, and the answer only arrives on the first
 * query; `scripts/check-env.ts` is the tool for asking it before a deploy.
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
  /**
   * Deployment revision, shortest-first.
   *
   * DOKKU_GIT_REV is the one that matters for a self-hosted box; the Vercel
   * variable is still read so a rollback to the old host keeps reporting a
   * revision rather than `null`.
   */
  VERCEL_GIT_COMMIT_SHA?: string;
  /**
   * Dokku injects the deployed commit sha automatically. This is why a Dokku
   * deployment does not need RELAY_BUILD_ID set by hand — otherwise /healthz
   * would report `revision: null` and "did my deploy land?" becomes
   * unanswerable.
   */
  DOKKU_GIT_REV?: string;
  /** Fallback build identifier set by the operator. */
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

/**
 * Decide which transport this environment would use, and what (if anything) is
 * still missing for it.
 *
 * SQLite is the only store. It is a file, so there is nothing to configure
 * and nothing to go missing — the report would otherwise be a constant. It
 * stays derived rather than hard-coded so a future store addition has exactly
 * one place to change.
 */
function resolveStorage(env: HealthEnv): {
  storage: HealthReport["storage"];
  missing: string[];
} {
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
