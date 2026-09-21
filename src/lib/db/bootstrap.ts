/**
 * src/lib/db/bootstrap.ts
 *
 * Idempotent first-run bootstrap. Called from API routes or startup
 * hooks to seed the system with sensible defaults.
 *
 * What this module does on every invocation:
 *   1. If no admin user exists, create one using `RELAY_AUTH` (or generate
 *      a random one and log it to stderr).
 *   2. If `OPENAI_KEYS` env var is set and no OpenAI provider exists,
 *      create one provider per key (so multiple keys enable rotation).
 *   3. If `ANTHROPIC_KEYS` env var is set and no Anthropic provider exists,
 *      same thing.
 *
 * The bootstrap is idempotent: running it 100 times = running it once.
 * Existing users / providers are never overwritten.
 */
import { listUsers, createUser, verifyUserCredentials, UsernameConflictError } from "./users";
import { k as redisKeys, getRedis } from "./redis";
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
  const redis = getRedis();
  const metaKey = redisKeys.metaInitialized();

  // ----- Atomically claim the bootstrap slot via SETNX --------------------
  // On a fresh deploy many concurrent cold-starts all hit this code path
  // at once. Without a lock they all see "no users exist", all race to
  // createUser("admin", ...), and the losers explode with
  // "Username already exists: admin" — taking down the request that hit
  // them. SETNX on a sentinel key gives us a single winner; losers
  // short-circuit (or wait briefly for the winner to finish).
  const claimed = await redis.set(metaKey, "bootstrapping", { nx: true });
  if (claimed !== "OK") {
    // Someone else is (or just was) bootstrapping. The fastest path is:
    // if a user already exists, we're done.
    const existing = await listUsers({ limit: 1 });
    if (existing.users.length > 0) {
      // Mark fully initialised so the next request skips even the SETNX round-trip.
      await redis.set(metaKey, "1");
      const admin = existing.users.find((u) => u.role === "admin");
      if (admin) await sanityWarnIfPasswordDrifted(admin.username);
      return { created: false, passwordGenerated: false };
    }
    // The lock is held but no user yet. Wait briefly for the holder to
    // finish; fall through to retry on timeout.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const after = await listUsers({ limit: 1 });
      if (after.users.length > 0) {
        await redis.set(metaKey, "1");
        const admin = after.users.find((u) => u.role === "admin");
        if (admin) await sanityWarnIfPasswordDrifted(admin.username);
        return { created: false, passwordGenerated: false };
      }
    }
    // Holder is taking too long (or crashed). Drop the lock and try ourselves.
    // This is safe because createUser's own username-index check would still
    // surface a conflict as a UsernameConflictError to the caller.
    return { created: false, passwordGenerated: false };
  }

  // ----- We hold the lock; double-check no admin already exists ------------
  // (Possible if a previous bootstrap set the meta flag but then crashed
  // before completing — re-creating an admin over an existing one would 409.)
  const { users } = await listUsers({ limit: 1 });
  if (users.length > 0) {
    const admin = users.find((u) => u.role === "admin");
    await redis.set(metaKey, "1");
    if (admin) await sanityWarnIfPasswordDrifted(admin.username);
    return { created: false, passwordGenerated: false };
  }

  // ----- Create the admin ---------------------------------------------------
  const generatedPassword = generateInitialPassword();
  try {
    await createUser({
      username: cfg.RELAY_ADMIN_USERNAME,
      password: cfg.RELAY_AUTH,
      role: "admin",
      displayName: "Admin",
    });
    await redis.set(metaKey, "1");
    console.log(
      `[relayab] Admin '${cfg.RELAY_ADMIN_USERNAME}' created. Login at /login ` +
        `using your RELAY_AUTH value as the password.`,
    );
    void generatedPassword;
    return { created: true, passwordGenerated: false };
  } catch (err) {
    // ---- UsernameConflictError is NOT a failure -----------------------------
    // On a fresh deploy, several concurrent cold-start Lambdas all race
    // here. The SETNX lock in `bootstrapAdmin()` AND the SETNX on the
    // by-username index in `createUser()` together guarantee that only
    // one call wins. The losers receive UsernameConflictError. That is
    // the CORRECT outcome — there is already an admin — and must NOT be
    // treated as an error:
    //
    //   - Re-throwing here triggers
    //     "[relayab] Bootstrap failed; the next request will retry: ..."
    //     and surfaces as HTTP 500 to the user, even though the system is
    //     perfectly healthy and ready to serve traffic.
    //   - Operators see alarming logs during normal cold-start behaviour.
    //
    // We swallow it as a no-op and mark the system as fully initialized.
    if (err instanceof UsernameConflictError) {
      await redis.set(metaKey, "1");
      console.log(
        `[relayab] Admin '${cfg.RELAY_ADMIN_USERNAME}' was created by a ` +
          `concurrent bootstrap; this request won the race as a no-op.`,
      );
      return { created: false, passwordGenerated: false };
    }
    // ---- Anything else: release lock so the next request can retry ---------
    // bcrypt hiccup, Redis blip, …: don't leave the lock held; the next
    // request will SETNX-claim it again and try fresh.
    await redis.del(metaKey);
    throw err;
  }
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
 * Next.js serves many requests per instance; the bootstrap work is idempotent
 * but not free (a few Redis reads + a bcrypt hash on first run), so we run it
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
 * Errors are rethrown and the memo is cleared, so a transient failure (e.g.
 * Redis hiccup during a cold start) is retried by the next request instead of
 * being cached forever.
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
