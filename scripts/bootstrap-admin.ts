/**
 * scripts/bootstrap-admin.ts
 *
 * Create the first admin user via a local script. Use this when:
 * - You can't set BOOTSTRAP_ADMIN_* env vars (e.g. on an existing deploy)
 * - You want a CLI-friendly bootstrap
 *
 * Usage:
 *   pnpm tsx scripts/bootstrap-admin.ts --username admin --password <password>
 *
 * Or use the npm script:
 *   pnpm bootstrap-admin --username admin --password <password>
 */
import { createUser } from "../src/lib/db/users.ts";
import { generateInitialPassword } from "../src/lib/crypto/password.ts";

// Parse CLI args manually (no extra dep).
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
  const password = args.password ?? generateInitialPassword();

  if (!username) {
    console.error("Usage: bootstrap-admin.ts --username <name> [--password <pw>]");
    process.exit(1);
  }

  try {
    const user = await createUser({
      username,
      password,
      role: "admin",
      displayName: username,
    });
    console.log("Admin created:");
    console.log(`  username: ${user.username}`);
    console.log(`  role:     ${user.role}`);
    console.log(`  id:       ${user.id}`);
    if (!args.password) {
      console.log(`  password: ${password}  (save this; not recoverable)`);
    }
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(2);
  }

  // Ensure redis connection closes cleanly.
  process.exit(0);
}

main();
