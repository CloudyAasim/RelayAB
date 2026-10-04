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
