/**
 * src/lib/db/bootstrap.ts
 *
 * Idempotent first-run bootstrap. Called from API routes or startup
 * hooks to seed the system with sensible defaults.
 *
 * What this module does on every invocation:
 *   1. If no admin user exists, create one using `RELAY_AUTH`.
 *   2. If `OPENAI_KEYS` env var is set and no OpenAI provider exists,
 *      create one provider per key (so multiple keys enable rotation).
 *   3. If `ANTHROPIC_KEYS` env var is set and no Anthropic provider exists,
 *      same thing.
 *
 * The bootstrap is idempotent: running it 100 times = running it once.
 * Existing users / providers are never overwritten.
 *
 * Concurrency note: the Redis version needed a SETNX sentinel, a 20×50ms
 * polling loop for the lock holder, and a manual lock release on the error
 * path — all to stop concurrent cold-starts from racing to create "admin".
 * Here a single `withTransaction()` (BEGIN IMMEDIATE) is the whole lock: the
 * second caller blocks on the write lock, then re-reads and finds the admin
 * already there. The lock is also released for free on rollback.
 */
import { listUsers, createUser, verifyUserCredentials, UsernameConflictError } from "./users";
import { getOne, run, withTransaction } from "./sqlite";
import { listProviders, createProvider, findProvidersForModel } from "./providers";
import {
  getOpenAIKeys,
  getAnthropicKeys,
  loadConfig,
  getMasterKey,
  isMasterKeyExplicit,
} from "../config";
import { generateInitialPassword } from "../crypto/password";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  adminCreated: boolean;
  adminPasswordGenerated: boolean;
  masterKeyWarning: boolean;
  openaiProvidersCreated: number;
  anthropicProvidersCreated: number;
}

// ---------------------------------------------------------------------------
// Default model mappings
// ---------------------------------------------------------------------------

const OPENAI_DEFAULT_MAPPING: Record<string, string> = {
  "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
  "gpt-4o": "gpt-4o-2024-08-06",
  "gpt-4-turbo": "gpt-4-turbo-2024-04-09",
  "gpt-3.5-turbo": "gpt-3.5-turbo-0125",
  o1: "o1-2024-12-17",
  "o1-mini": "o1-mini-2024-09-12",
};

const ANTHROPIC_DEFAULT_MAPPING: Record<string, string> = {
  "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku": "claude-3-5-haiku-20241022",
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-3-haiku": "claude-3-haiku-20240307",
};

const META_INITIALIZED = "initialized";

// ---------------------------------------------------------------------------
// Main bootstrap
// ---------------------------------------------------------------------------

/**
 * Run the full bootstrap sequence. Safe to invoke repeatedly.
 */
export async function runBootstrap(): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    adminCreated: false,
    adminPasswordGenerated: false,
    masterKeyWarning: false,
    openaiProvidersCreated: 0,
    anthropicProvidersCreated: 0,
  };

  // 1. Master-key warning (so admins see this in their server logs).
  if (!isMasterKeyExplicit()) {
    result.masterKeyWarning = true;
    console.warn(
      "[relayab] RELAY_MASTER_KEY_HEX is not set. The master key is derived " +
        "from RELAY_AUTH. Rotating RELAY_AUTH will invalidate all encrypted " +
        "upstream provider keys.",
    );
  }

  // 2. Admin user.
  const adminResult = await bootstrapAdmin();
  result.adminCreated = adminResult.created;
  result.adminPasswordGenerated = adminResult.passwordGenerated;

  // 3. Providers from env.
  result.openaiProvidersCreated = await bootstrapOpenAIProviders();
  result.anthropicProvidersCreated = await bootstrapAnthropicProviders();

  return result;
}

// ---------------------------------------------------------------------------
// Admin bootstrap
// ---------------------------------------------------------------------------

async function bootstrapAdmin(): Promise<{ created: boolean; passwordGenerated: boolean }> {
  const cfg = loadConfig();

  // ----- Single-writer section -------------------------------------------
  // BEGIN IMMEDIATE takes SQLite's write lock before the first read, so the
  // "is there already a user?" check and the insert that follows are one
  // indivisible step. A concurrent cold-start blocks here until this commits,
  // then observes the admin and returns. No sentinel key, no polling loop, no
  // manual unlock on the error path — rollback handles it.
  //
  // Cost: createUser() hashes the password with bcrypt inside this section, so
  // the write lock is held for ~250ms on first boot. That is deliberate and
  // bounded — it happens once in the database's lifetime, and it is precisely
  // the serialization the bootstrap needs. Steady-state requests are unaffected.
  return withTransaction(async () => {
    const already = getOne<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?",
      [META_INITIALIZED],
    );
    if (already) return { created: false, passwordGenerated: false };

    // Possible if a previous bootstrap wrote the meta flag but crashed before
    // completing — re-creating an admin over an existing one would 409.
    const { users } = await listUsers({ limit: 1 });
    if (users.length > 0) {
      run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", [META_INITIALIZED, "1"]);
      const admin = users.find((u) => u.role === "admin");
      if (admin) await sanityWarnIfPasswordDrifted(admin.username);
      return { created: false, passwordGenerated: false };
    }

    // ----- Create the admin ------------------------------------------------
    const generatedPassword = generateInitialPassword();
    try {
      await createUser({
        username: cfg.RELAY_ADMIN_USERNAME,
        password: cfg.RELAY_AUTH,
        role: "admin",
        displayName: "Admin",
      });
      run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [META_INITIALIZED, "1"]);
      console.log(
        `[relayab] Admin '${cfg.RELAY_ADMIN_USERNAME}' created. Login at /login ` +
          `using your RELAY_AUTH value as the password.`,
      );
      void generatedPassword;
      return { created: true, passwordGenerated: false };
    } catch (err) {
      // ---- UsernameConflictError is NOT a failure -------------------------
      // Belt and braces: the transaction already guarantees a single winner, so
      // this should be unreachable. But if a future code path adds another
      // createUser() outside the lock, a conflict still means "an admin
      // already exists", and treating that as an error would surface as an
      // HTTP 500 on a perfectly healthy system.
      if (err instanceof UsernameConflictError) {
        run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [META_INITIALIZED, "1"]);
        console.log(
          `[relayab] Admin '${cfg.RELAY_ADMIN_USERNAME}' was created by a ` +
            `concurrent bootstrap; this request won the race as a no-op.`,
        );
        return { created: false, passwordGenerated: false };
      }
      // Anything else: let it propagate. The transaction rolls back, so the
      // meta flag is not left half-written and the next request retries clean.
      throw err;
    }
  });
}

async function sanityWarnIfPasswordDrifted(username: string): Promise<void> {
  const cfg = loadConfig();
  const passwordValid = await verifyUserCredentials(username, cfg.RELAY_AUTH);
  if (!passwordValid) {
    console.warn(
      `[relayab] Admin '${username}' exists but its password does ` +
        `not match RELAY_AUTH. To reset, use: pnpm reset-password --username ${username}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider bootstrap
// ---------------------------------------------------------------------------

async function bootstrapOpenAIProviders(): Promise<number> {
  const keys = getOpenAIKeys();
  if (keys.length === 0) return 0;

  const cfg = loadConfig();
  const existing = await listProviders();
  const existingOpenAI = existing.filter((p) => p.kind === "openai");
  if (existingOpenAI.length > 0) {
    // Already bootstrapped — don't add duplicates.
    return 0;
  }

  let created = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      await createProvider({
        name: keys.length === 1 ? "OpenAI" : `OpenAI #${i + 1}`,
        kind: "openai",
        baseUrl: cfg.OPENAI_BASE_URL ?? null,
        apiKey: key,
        modelMapping: OPENAI_DEFAULT_MAPPING,
        priority: i + 1,
        enabled: true,
      });
      created++;
    } catch (err) {
      console.error(`[relayab] Failed to create OpenAI provider #${i + 1}:`, err);
    }
  }
  if (created > 0) {
    console.log(`[relayab] Bootstrapped ${created} OpenAI provider(s) from OPENAI_KEYS.`);
  }
  return created;
}

async function bootstrapAnthropicProviders(): Promise<number> {
  const keys = getAnthropicKeys();
  if (keys.length === 0) return 0;

  const cfg = loadConfig();
  const existing = await listProviders();
  const existingAnthropic = existing.filter((p) => p.kind === "anthropic");
  if (existingAnthropic.length > 0) {
    return 0;
  }

  let created = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      await createProvider({
        name: keys.length === 1 ? "Anthropic" : `Anthropic #${i + 1}`,
        kind: "anthropic",
        baseUrl: cfg.ANTHROPIC_BASE_URL ?? null,
        apiKey: key,
        modelMapping: ANTHROPIC_DEFAULT_MAPPING,
        priority: i + 1,
        enabled: true,
      });
      created++;
    } catch (err) {
      console.error(`[relayab] Failed to create Anthropic provider #${i + 1}:`, err);
    }
  }
  if (created > 0) {
    console.log(`[relayab] Bootstrapped ${created} Anthropic provider(s) from ANTHROPIC_KEYS.`);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export { OPENAI_DEFAULT_MAPPING, ANTHROPIC_DEFAULT_MAPPING };

// suppress unused
void findProvidersForModel;
void getMasterKey;

// ---------------------------------------------------------------------------
// Runtime entry point (memoized per server instance)
// ---------------------------------------------------------------------------

/**
 * In-flight / completed bootstrap for the current server instance.
 *
 * Next.js serves many requests per instance; the bootstrap work is idempotent
 * but not free (a few reads + a bcrypt hash on first run), so we run it
 * at most once per instance.
 */
let bootstrapPromise: Promise<BootstrapResult> | null = null;

/**
 * Lazily bootstrap the instance, at most once per process.
 *
 * Call this from request entry points (login route, session guard, API-key
 * auth) so a freshly deployed instance self-heals on its first request: the
 * admin user is created from `RELAY_AUTH` and providers are seeded from
 * `OPENAI_KEYS` / `ANTHROPIC_KEYS`.
 *
 * Errors are rethrown and the memo is cleared, so a transient failure (e.g. a
 * database file that is momentarily locked) is retried by the next request
 * instead of being cached forever.
 */
export async function ensureBootstrapped(): Promise<BootstrapResult> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((err) => {
      bootstrapPromise = null;
      // UsernameConflictError is NOT a failure: it means a concurrent
      // bootstrap already created the admin. (Defensive — bootstrapAdmin()
      // already swallows this, but if a future code path adds another
      // createUser() we still don't want to 500 the user.)
      if (err instanceof UsernameConflictError) {
        console.log(
          "[relayab] Bootstrap no-op (admin already created by a " +
            "concurrent cold-start).",
        );
        // Return a benign "nothing happened" result.
        return {
          adminCreated: false,
          adminPasswordGenerated: false,
          masterKeyWarning: false,
          openaiProvidersCreated: 0,
          anthropicProvidersCreated: 0,
        };
      }
      console.error(
        "[relayab] Bootstrap failed; the next request will retry:",
        err instanceof Error ? err.message : err,
      );
      throw err;
    });
  }
  return bootstrapPromise;
}

/** Test-only: forget the memoized bootstrap result. */
export function __resetBootstrapForTest(): void {
  bootstrapPromise = null;
}
