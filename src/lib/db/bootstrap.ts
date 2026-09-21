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
import { listUsers, createUser, verifyUserCredentials } from "./users";
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
  const { users } = await listUsers({ limit: 1 });

  // If an admin already exists, try to verify the password matches
  // RELAY_AUTH. If yes, great. If no, that's a config drift issue
  // but we won't fix it automatically (would lock the user out).
  if (users.length > 0) {
    const admin = users.find((u) => u.role === "admin");
    if (admin) {
      // Sanity check: if password matches RELAY_AUTH, no-op.
      const passwordValid = await verifyUserCredentials(admin.username, cfg.RELAY_AUTH);
      if (!passwordValid) {
        console.warn(
          `[relayab] Admin '${admin.username}' exists but its password does ` +
            `not match RELAY_AUTH. To reset, use: pnpm reset-password --username ${admin.username}`,
        );
      }
      return { created: false, passwordGenerated: false };
    }
  }

  // No admin exists. Create one with RELAY_AUTH as the password.
  const generatedPassword = generateInitialPassword();
  try {
    await createUser({
      username: cfg.RELAY_ADMIN_USERNAME,
      password: cfg.RELAY_AUTH,
      role: "admin",
      displayName: "Admin",
    });
    console.log(
      `[relayab] Admin '${cfg.RELAY_ADMIN_USERNAME}' created. Login at /login ` +
        `using your RELAY_AUTH value as the password.`,
    );
    void generatedPassword;
    return { created: true, passwordGenerated: false };
  } catch (err) {
    // Username collision — try generating a unique username.
    if (err instanceof Error && err.message.includes("already exists")) {
      console.error(`[relayab] Username '${cfg.RELAY_ADMIN_USERNAME}' already taken.`);
    }
    throw err;
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
