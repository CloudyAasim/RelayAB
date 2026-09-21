/**
 * scripts/check-env.ts
 *
 * Build-time validator for required environment variables.
 *
 * Wired via the `prebuild` npm script (see package.json), so it runs
 * automatically before `next build` on Vercel (and locally). If any
 * required env var is missing, the build is aborted with a clear,
 * actionable error — this prevents the runtime
 *   "[relayab] Invalid configuration. ... Required: RELAY_AUTH, ..."
 * error you would otherwise see after deployment.
 *
 * Skipped in `NODE_ENV === "test"` because the test suite supplies its
 * own deterministic defaults via tests/setup.ts.
 */

const REQUIRED = [
  "RELAY_AUTH",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

const OPTIONAL_DOC: Record<string, string> = {
  RELAY_AUTH: "Master password (also the first admin login password)",
  UPSTASH_REDIS_REST_URL: "Upstash for Redis REST URL",
  UPSTASH_REDIS_REST_TOKEN: "Upstash for Redis REST token",
};

function main(): void {
  const nodeEnv = process.env.NODE_ENV ?? "";

  // Honor CI overrides (Vercel passes CI=1 during builds).
  const isCI = process.env.CI === "1" || process.env.VERCEL === "1";

  if (nodeEnv === "test") {
    console.log("[check-env] NODE_ENV=test → skipping required-env check");
    process.exit(0);
  }

  const missing = REQUIRED.filter(
    (k) => !process.env[k] || !process.env[k]!.trim(),
  );

  if (missing.length === 0) {
    const banner = isCI ? "Vercel" : "local";
    console.log(
      `[check-env] OK (${banner}): ${REQUIRED.length}/${REQUIRED.length} required env vars present.`,
    );
    process.exit(0);
  }

  // Pretty failure box.
  const lines: string[] = [
    "",
    "╭──────────────────────────────────────────────────────────────╮",
    "│  ✗  Build aborted — missing required environment variables   │",
    "╰──────────────────────────────────────────────────────────────╯",
    "",
    "  The following variables are required (see .env.example):",
    "",
    ...missing.map((k) => `    • ${k}    — ${OPTIONAL_DOC[k] ?? ""}`),
    "",
    "  How to fix on Vercel:",
    "    1. Open Vercel Dashboard → your project → Settings → Environment Variables",
    "    2. Add each missing variable for at least the Production environment",
    "    3. Re-deploy (push a new commit, or click 'Redeploy')",
    "",
    "  How to fix locally:",
    "    cp .env.example .env.local   # then edit real values in",
    "",
    "  Tip: the easiest way to set the Upstash pair is to install",
    "  Upstash for Redis via the Vercel Marketplace — it auto-injects",
    "  UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    "",
  ];

  console.error(lines.join("\n"));
  process.exit(1);
}

main();
