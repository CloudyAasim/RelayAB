/**
 * scripts/rotate-master-key.ts
 *
 * Rotate the AES master key used to encrypt upstream provider API keys.
 *
 * ⚠️  WARNING: This script must be run CAREFULLY:
 *   1. Set OLD_RELAY_MASTER_KEY_HEX (current key) and RELAY_MASTER_KEY_HEX (new).
 *   2. Run this script — it re-encrypts all provider keys with the new key.
 *   3. After successful run, drop OLD_RELAY_MASTER_KEY_HEX from env.
 *   4. Redeploy.
 *
 * If the script crashes mid-way, run it again — it is idempotent (it
 * only re-encrypts rows whose current ciphertext cannot be decrypted
 * with the new key).
 *
 * Usage:
 *   OLD_RELAY_MASTER_KEY_HEX=<old> RELAY_MASTER_KEY_HEX=<new> \
 *     pnpm tsx scripts/rotate-master-key.ts
 */
import { encryptSecret, decryptSecret } from "../src/lib/crypto/secrets.ts";
import { listProviders, updateProvider } from "../src/lib/db/providers.ts";

async function main(): Promise<void> {
  const oldKey = process.env.OLD_RELAY_MASTER_KEY_HEX;
  const newKey = process.env.RELAY_MASTER_KEY_HEX;
  if (!oldKey || !newKey) {
    console.error(
      "Both OLD_RELAY_MASTER_KEY_HEX and RELAY_MASTER_KEY_HEX must be set.",
    );
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error("Old and new keys are identical — nothing to do.");
    process.exit(0);
  }

  // Override config temporarily so our lib uses the OLD key for decryption.
  process.env.RELAY_MASTER_KEY_HEX = oldKey;
  const { __resetConfigForTest: resetConfig } = await import(
    "../src/lib/config.js"
  );
  resetConfig();

  const providers = await listProviders();
  console.log(`Re-encrypting ${providers.length} provider key(s)…`);

  let reEncrypted = 0;
  let skipped = 0;
  for (const p of providers) {
    // Try decrypting with the old key.
    let plaintext: string;
    try {
      plaintext = decryptSecret(p.encryptedApiKey);
    } catch {
      // Either already on the new key, or corrupted. Try with new key.
      process.env.RELAY_MASTER_KEY_HEX = newKey;
      resetConfig();
      try {
        decryptSecret(p.encryptedApiKey);
        skipped++;
        console.log(`  [skip] ${p.name} (${p.id}): already on new key`);
        continue;
      } catch {
        console.error(`  [FAIL] ${p.name} (${p.id}): cannot decrypt with either key`);
        continue;
      }
    }

    // Re-encrypt with the new key.
    process.env.RELAY_MASTER_KEY_HEX = newKey;
    resetConfig();
    const newCt = encryptSecret(plaintext);
    await updateProvider(p.id, { apiKey: plaintext });
    reEncrypted++;
    void newCt;
    console.log(`  [ok]   ${p.name} (${p.id}): re-encrypted`);
  }

  console.log("");
  console.log(`Done. Re-encrypted: ${reEncrypted}, Skipped: ${skipped}`);
  console.log(
    "Next step: update Vercel env to use the new RELAY_MASTER_KEY_HEX, then redeploy.",
  );
  process.exit(0);
}

main();
