/**
 * scripts/check-env.ts
 *
 * Optional environment-variable validator (manual diagnostic only).
 *
 * No longer wired into any automatic build hook. Run manually with:
 *     pnpm tsx scripts/check-env.ts
 *
 * `/healthz` is the canonical runtime check — it reports the same state as the
 * client that `getRedis()` actually builds. This script is a convenience for
 * catching a typo before the first request.
 *
 * Skipped in `NODE_ENV === "test"` because the test suite supplies its
 * own deterministic defaults via tests/setup.ts.
 */

/** Always needed, whatever the database transport is. */
const REQUIRED = ["RELAY_AUTH"] as const;

const OPTIONAL_DOC: Record<string, string> = {
  RELAY_AUTH: "Master password (also the first admin login password)",
  REDIS_URL: "Self-hosted Redis/Valkey, e.g. redis://:<password>@127.0.0.1:6379",
  UPSTASH_REDIS_REST_URL: "Upstash for Redis REST URL (hosted alternative)",
  UPSTASH_REDIS_REST_TOKEN: "Upstash for Redis REST token (hosted alternative)",
};

function has(name: string): boolean {
  const v = process.env[name];
  return Boolean(v && v.trim());
}

/**
 * Which database transport this environment selects, mirroring
 * `resolveRedisTransport()` in src/lib/db/redis.ts.
 */
function databaseState(): { ok: boolean; detail: string } {
  const url = has("REDIS_URL") ? process.env.REDIS_URL!.trim() : "";

  if (url) {
    if (url.startsWith("redis://") || url.startsWith("rediss://")) {
      return { ok: true, detail: "tcp (ioredis)" };
    }
    // Misconfigured: present but not a connection string. This is the case
    // that used to slip through, because the old check only asked whether
    // UPSTASH_* was set and never looked at REDIS_URL at all.
    return {
      ok: false,
      detail: "REDIS_URL is set but does not start with redis:// or rediss://",
    };
  }

  const restUrl = ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "KV_URL"].find(has);
  const restToken = [
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_TOKEN",
    "KV_REST_API_READ_ONLY_TOKEN",
  ].find(has);

  if (restUrl && restToken) return { ok: true, detail: "upstash (rest)" };
  if (restUrl || restToken) {
    return {
      ok: false,
      detail: "Upstash pair is half-configured (need both URL and token)",
    };
  }

  return { ok: false, detail: "no database configured" };
}

function main(): void {
  const nodeEnv = process.env.NODE_ENV ?? "";
  const isCI = process.env.CI === "1";

  if (nodeEnv === "test") {
    console.log("[check-env] NODE_ENV=test → skipping required-env check");
    process.exit(0);
  }

  const missing = REQUIRED.filter((k) => !has(k));
  const db = databaseState();

  if (missing.length === 0 && db.ok) {
    const banner = isCI ? "ci" : "local";
    console.log(
      `[check-env] OK (${banner}): ${REQUIRED.length}/${REQUIRED.length} required env vars present, database = ${db.detail}.`,
    );
    process.exit(0);
  }

  const lines: string[] = [
    "",
    "╭──────────────────────────────────────────────────────────────╮",
    "│  ✗  Incomplete configuration — the app will not serve requests │",
    "╰──────────────────────────────────────────────────────────────╯",
    "",
  ];

  if (missing.length > 0) {
    lines.push("  Missing required variables:", "");
    for (const k of missing) lines.push(`    • ${k}    — ${OPTIONAL_DOC[k] ?? ""}`);
    lines.push("");
  }

  if (!db.ok) {
    lines.push("  Database: " + db.detail, "");
  }

  lines.push(
    "  How to fix (self-hosted Debian — see deploy/env.production.example):",
    "    1. cp deploy/env.production.example /opt/relayab/.env.production",
    "    2. Set RELAY_AUTH (openssl rand -hex 32)",
    "    3. Set REDIS_URL to your Valkey/Redis connection string",
    "    4. sudo systemctl restart relayab",
    "",
    "  Locally:",
    "    cp .env.example .env.local   # then edit real values in",
    "",
    "  Not using a database? Set EMULATE_VERCEL_LOCAL=1 to run against the",
    "  in-memory store (development only — nothing is persisted).",
    "",
  );

  console.error(lines.join("\n"));
  process.exit(1);
}

main();
