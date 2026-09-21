/**
 * scripts/list-usage.ts
 *
 * Print a quick usage summary across all users / providers / days.
 * Useful for ops to see activity without opening the admin panel.
 *
 * Usage:
 *   pnpm tsx scripts/list-usage.ts
 *   pnpm tsx scripts/list-usage.ts --user <username>
 *   pnpm tsx scripts/list-usage.ts --days 7
 */
import { aggregateByDay } from "../src/lib/quota/calculator.ts";
import { listAllApiKeys } from "../src/lib/db/keys.ts";
import { listUsageByKey } from "../src/lib/db/usage.ts";
import { getUserByUsername, listUsers } from "../src/lib/db/users.ts";
import { formatCredits } from "../src/lib/utils.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const filterUser = args.user;
  const days = Number(args.days ?? "30");

  let scopedUserId: string | undefined;
  if (filterUser) {
    const u = await getUserByUsername(filterUser);
    if (!u) {
      console.error(`User not found: ${filterUser}`);
      process.exit(1);
    }
    scopedUserId = u.id;
  }

  const allKeys = await listAllApiKeys();
  const filtered = scopedUserId
    ? allKeys.filter((k) => k.userId === scopedUserId)
    : allKeys;
  const logs = (
    await Promise.all(filtered.map((k) => listUsageByKey(k.id, { limit: 1000 })))
  ).flat();

  const buckets = aggregateByDay(logs, 0);
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toISOString()
    .slice(0, 10);
  const recent = buckets.filter((b) => b.day >= cutoff);

  console.log(`Usage over last ${days} day(s)${filterUser ? ` for user ${filterUser}` : ""}:`);
  console.log("");
  console.log("  Date       Requests    Tokens      积分");
  console.log("  ─────────  ──────────  ──────────  ──────────");
  for (const b of recent) {
    console.log(
      `  ${b.day}  ${String(b.requests).padStart(10)}  ${String(b.promptTokens + b.completionTokens).padStart(10)}  ${formatCredits(b.creditsUsed).padStart(10)}`,
    );
  }
  const totals = recent.reduce(
    (acc, b) => {
      acc.requests += b.requests;
      acc.tokens += b.promptTokens + b.completionTokens;
      acc.credits += b.creditsUsed;
      return acc;
    },
    { requests: 0, tokens: 0, credits: 0 },
  );
  console.log("  ─────────  ──────────  ──────────  ──────────");
  console.log(
    `  TOTAL     ${String(totals.requests).padStart(10)}  ${String(totals.tokens).padStart(10)}  ${formatCredits(totals.credits).padStart(10)}`,
  );

  void listUsers;
  process.exit(0);
}

main();
