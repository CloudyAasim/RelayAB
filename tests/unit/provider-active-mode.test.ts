/**
 * tests/unit/provider-active-mode.test.ts
 *
 * A row holds two configurations; one of them is in effect.
 *
 * The operator asked for this after the alternative was put to them. The faces
 * decide what answers; the per-interface rules decide what happens to the
 * parameters. Both are kept, and `activeMode` says which one is live. Choosing
 * simple therefore does not delete the rules — it only stops them applying,
 * and switching back brings them straight back.
 *
 * The reason this has to live *here* rather than in the interface is that
 * "not in effect" is a fact about the request, not about the screen. If the
 * editor merely stopped rendering the rules, the engine would go on applying
 * them and the two modes would be the same configuration wearing two labels.
 * `activeSpecFor` is the single gate all three proxy paths go through, so no
 * fourth call site can forget it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeModeOf, activeSpecFor } from "@/lib/protocol/text-specs";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const spec = (protocol: string) => JSON.stringify({ specVersion: 1, protocol, parameters: {} });

describe("which configuration is in effect", () => {
  it("follows the row's own answer when it has one", () => {
    expect(activeModeOf({ activeMode: "simple", textSpecs: [spec("openai-chat")] })).toBe("simple");
    expect(activeModeOf({ activeMode: "advanced", textSpecs: [] })).toBe("advanced");
  });

  it("and a row written before the field keeps what it always did", () => {
    // Otherwise every existing provider would silently stop applying its rules
    // on upgrade — the rules would still be in the row, and doing nothing.
    expect(activeModeOf({ textSpecs: [spec("openai-chat")] })).toBe("advanced");
    expect(activeModeOf({ textSpecs: [] })).toBe("simple");
    expect(activeModeOf({})).toBe("simple");
  });
});

describe("the engine honours it, not the screen", () => {
  it("simple in effect: the rules are kept and not applied", () => {
    const provider = { activeMode: "simple", textSpecs: [spec("openai-chat")] };
    expect(activeSpecFor(provider, "openai-chat")).toBeNull();
    // Kept, not dropped: switching back is a switch, not an edit.
    expect(provider.textSpecs).toHaveLength(1);
  });

  it("advanced in effect: the rules apply", () => {
    const provider = { activeMode: "advanced", textSpecs: [spec("openai-chat")] };
    expect(activeSpecFor(provider, "openai-chat")?.protocol).toBe("openai-chat");
  });

  it("a surface with no rule is still none, either way", () => {
    const provider = { activeMode: "advanced", textSpecs: [spec("openai-chat")] };
    expect(activeSpecFor(provider, "anthropic-messages")).toBeNull();
  });

  it("and all three proxy paths go through the gate", () => {
    // A fourth call site using `specForSurface` directly would be a request
    // answering from a configuration the operator had switched off.
    for (const file of [
      "src/lib/proxy/openai.ts",
      "src/lib/proxy/anthropic.ts",
    ]) {
      const src = read(...file.split("/"));
      expect(src, `${file} bypasses the gate`).not.toMatch(
        /specForSurface\(readTextSpecs\(provider\)/,
      );
      expect(src, `${file} does not use the gate`).toMatch(/activeSpecFor\(provider,/);
    }
  });
});

describe("the choice is stored, not inferred on every read", () => {
  it("the column is migrated onto an existing database", () => {
    // A fresh `CREATE TABLE` is not enough: the deployment that matters is the
    // one with rows in it, and `ADD COLUMN` is the only migration SQLite has.
    const sql = read("src", "lib", "db", "sqlite.ts");
    expect(sql).toMatch(/\{ table: "providers", column: "active_mode", type: "TEXT" \}/);
  });

  it("a row reads back what was written, and NULL stays NULL", () => {
    const sql = read("src", "lib", "db", "sqlite.ts");
    // Back-filling NULL to "simple" would be a decision nobody made, recorded as
    // one — and it would read as an explicit choice on the next save.
    expect(sql).toMatch(
      /activeMode: row\.active_mode === "simple" \|\| row\.active_mode === "advanced"/,
    );
  });

  it("both write paths carry it", () => {
    const repo = read("src", "lib", "db", "providers.ts");
    expect(repo, "create does not write the choice").toMatch(/activeMode: input\.activeMode \?\? null,/);
    // Anchored on the value sitting immediately before `updatedAt` in the bind
    // array, not merely on the word appearing somewhere. A column added to the
    // SQL without a matching bound value is the classic way this goes wrong,
    // and both statements here are positional `?` lists.
    expect(repo, "update does not write the choice").toMatch(
      /merged\.activeMode \?\? null,\s*\n\s*merged\.updatedAt,/,
    );
    expect(repo, "the UPDATE has no column for it").toMatch(/active_mode = \?, updated_at = \?/);
    // And the update leaves it alone when the patch says nothing about it, so
    // renaming a provider does not silently flip which config is live.
    expect(repo).toMatch(
      /activeMode: patch\.activeMode === undefined \? existing\.activeMode : patch\.activeMode,/,
    );
  });

  it("the admin API accepts it, on both verbs", () => {
    // The PATCH schema is `.strict()`, so a field the editor starts sending
    // without a declaration here is refused outright — and the error reads as
    // "the whole save was rejected" rather than "one new field is unknown".
    for (const file of [
      "src/app/api/admin/providers/route.ts",
      "src/app/api/admin/providers/[id]/route.ts",
    ]) {
      const src = read(...file.split("/"));
      expect(src, `${file} does not declare the field`).toMatch(
        /activeMode: z\.enum\(\["simple", "advanced"\]\)\.nullable\(\)\.optional\(\),/,
      );
    }
  });
});

describe("the list reports what is running, not what is stored", () => {
  it("the cell is told the mode by the shared resolver", () => {
    const page = read("src", "app", "(admin)", "admin", "providers", "page.tsx");
    // A second derivation here — `textSpecs.length ? "advanced"` — is how the
    // column and the engine would come to disagree about the same row.
    expect(page).toMatch(/mode=\{activeModeOf\(p\)\}/);
  });

  it("the in-effect marker is not reachable from the stored list alone", () => {
    // The bug this column had: a provider switched to simple still holds every
    // rule it was given, so marking from `textSpecs` kept advertising three of
    // them while none was running. `hasRule` may still find them; the marker
    // for the live configuration has to be behind the mode.
    const page = read("src", "app", "(admin)", "admin", "providers", "page.tsx");
    expect(page, "the rule marker ignores the mode").toMatch(
      /mode === "advanced"[\s\S]{0,200}labels\.hasRule/,
    );
    expect(page, "a parked configuration is not shown as the plain marker").toMatch(
      /mode === "advanced"[\s\S]{0,300}labels\.rulesOff/,
    );
    // And the interfaces themselves are still listed from the faces, which are
    // in effect in both modes — the marker is the only thing that moved.
    expect(page).toMatch(/ruleMark\("openai-chat"\)/);
    expect(page).toMatch(/ruleMark\("anthropic-messages"\)/);
  });
});
