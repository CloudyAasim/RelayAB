/**
 * scripts/reset-user-password.ts
 *
 * Reset a user's password via the CLI. Generates a new random password
 * and prints it once.
 *
 * Usage:
 *   pnpm tsx scripts/reset-user-password.ts --username <name>
 *   pnpm tsx scripts/reset-user-password.ts --username <name> --password <new>
 */
import { getUserByUsername, resetUserPassword } from "../src/lib/db/users.ts";
import { generateInitialPassword } from "../src/lib/crypto/password.ts";

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
  const username = args.username;
  if (!username) {
    console.error("Usage: reset-user-password.ts --username <name> [--password <new>]");
    process.exit(1);
  }

  const user = await getUserByUsername(username);
  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(2);
  }

  const newPassword = args.password ?? generateInitialPassword();
  const updated = await resetUserPassword(user.id, newPassword);
  if (!updated) {
    console.error("Reset failed");
    process.exit(3);
  }

  console.log("Password reset for:", user.username);
  if (!args.password) {
    console.log(`  new password: ${newPassword}  (save this; not recoverable)`);
  } else {
    console.log("  (password set to provided value)");
  }
  process.exit(0);
}

main();
