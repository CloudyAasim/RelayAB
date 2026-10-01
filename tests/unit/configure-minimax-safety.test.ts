/**
 * tests/unit/configure-minimax-safety.test.ts
 *
 * Three defects in `scripts/configure-minimax.ts`, each of which made the
 * script report success for a provider that could never serve a request:
 *
 *  1. `--dry-run` did not prevent writes. The flag only printed a banner; both
 *     `updateProvider` and `updateMediaProvider` were called unconditionally.
 *     The documented first command ("先看会改成什么，不写入") mutated the
 *     production database.
 *  2. The media base URL was a hardcoded template constant, so a global
 *     (platform.minimax.io) key got a mainland host and every media call
 *     401'd. The chat side had been region-probed; the media side had not.
 *  3. The media branch of `verify()` only printed composed URLs and never made
 *     a request, so it reported ✓ for a provider pointed at the wrong region.
 *
 * The behavioural test drives the real database to prove the rollback the dry
 * run now depends on. The rest are source guards, because the wiring itself
 * (which call site routes through `commit()`) is the invariant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { __resetDbForTest, withTransaction } from "@/lib/db/sqlite";
import { createProvider, getProviderById, updateProvider } from "@/lib/db/providers";

const SCRIPT = readFileSync(join(process.cwd(), "scripts", "configure-minimax.ts"), "utf8");

/** Mirrors the script's `commit()` so its exact semantics are what is asserted. */
const ROLLED_BACK = Symbol("dry-run-rollback");
async function commitPreview<T>(apply: () => Promise<T>): Promise<T> {
  let previewed: T;
  try {
    await withTransaction(async () => {
      previewed = await apply();
      throw ROLLED_BACK;
    });
  } catch (err) {
    if (err === ROLLED_BACK) return previewed!;
    throw err;
  }
  throw new Error("dry-run transaction committed instead of rolling back");
}

describe("configure-minimax dry run", () => {
  it("discards the write but still reports what would have been stored", async () => {
    __resetDbForTest();
    const created = await createProvider({
      name: "MiniMax",
      kind: "openai",
      apiKey: "sk-not-a-real-key",
      enabled: true,
    });
    expect(created).not.toBeNull();
    const before = await getProviderById(created!.id);
    expect(before?.baseUrl).toBeFalsy();

    const previewed = await commitPreview(() =>
      updateProvider(created!.id, { baseUrl: "https://api.minimaxi.com/v1" }),
    );

    // The preview must describe the post-merge state, or it is useless.
    expect(previewed?.baseUrl).toBe("https://api.minimaxi.com/v1");
    // ...and none of it may have been persisted.
    const after = await getProviderById(created!.id);
    expect(after?.baseUrl).toBeFalsy();
  });

  it("leaves a pre-existing value untouched after a rolled-back update", async () => {
    __resetDbForTest();
    const created = await createProvider({
      name: "MiniMax",
      kind: "openai",
      apiKey: "sk-not-a-real-key",
      baseUrl: "https://api.minimax.cn/v1",
      enabled: true,
    });
    const previewed = await commitPreview(() =>
      updateProvider(created!.id, { baseUrl: "https://api.minimax.io/v1" }),
    );
    expect(previewed?.baseUrl).toBe("https://api.minimax.io/v1");
    const after = await getProviderById(created!.id);
    expect(after?.baseUrl).toBe("https://api.minimax.cn/v1");
  });
});

describe("configure-minimax source guards", () => {
  it("routes every provider write through commit()", () => {
    // Each write call must be wrapped. A bare `await updateProvider(` or
    // `await updateMediaProvider(` at the call site would write on a dry run.
    const bareWrites = SCRIPT.match(/await\s+update(?:Media)?Provider\(/g) ?? [];
    expect(bareWrites).toHaveLength(0);

    expect(SCRIPT).toMatch(/await\s+commit\(\(\)\s*=>\s*updateProvider\(/);
    expect(SCRIPT).toMatch(/await\s+commit\(\(\)\s*=>\s*updateMediaProvider\(/);
  });

  it("resolves the media base URL from a probed host, not a template constant", () => {
    expect(SCRIPT).not.toMatch(/baseUrl:\s*MEDIA_TEMPLATES\[/);
    expect(SCRIPT).toMatch(/baseUrl:\s*`https:\/\/\$\{mediaHost\}`/);
    // The media provider carries its own key, so it must be probed on its own.
    expect(SCRIPT).toMatch(/resolveRegion\(target\.name,\s*target\.encryptedApiKey,\s*false\)/);
  });

  it("never passes an apiKey to a provider update", () => {
    // Operator policy: a blank key means "leave it alone". Handing `apiKey`
    // to the update path at all is the risk this guards.
    const updateBlocks = SCRIPT.match(/update(?:Media)?Provider\([\s\S]*?\}\)/g) ?? [];
    for (const block of updateBlocks) {
      expect(block).not.toMatch(/apiKey\s*:/);
    }
  });

  it("verifies media providers with a live call rather than printed URLs", () => {
    const mediaVerify = SCRIPT.slice(SCRIPT.indexOf("const media = await listMediaProviders()"));
    expect(mediaVerify).toMatch(/callUpstream\(/);
    expect(mediaVerify).toMatch(/res\.status === 401 \|\| res\.status === 403/);
  });
});
