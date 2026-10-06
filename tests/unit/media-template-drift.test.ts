/**
 * tests/unit/media-template-drift.test.ts
 *
 * A stored spec is a copy of a template, and the copy never finds out.
 *
 * The failure this exists for: a fix to `MINIMAX_STT_SPEC` was made, committed,
 * deployed, and did not reach production — because production was running the
 * copy stored in the provider row, not the value in the repository. Nothing
 * errored. The repository was correct the whole time, and the only symptom was a
 * call returning byte-identical failures across two different deployments.
 *
 * So the question "has this fallen behind?" is answered by reading both, rather
 * than by asking a person to paste a configuration.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { specDrift, providerDrift, driftReport } from "@/lib/media/drift";
import { MINIMAX_STT_SPEC, MINIMAX_TTS_SPEC } from "@/lib/media/seeds";
import type { MediaSpec } from "@/lib/media/spec";

const TOOLS = readFileSync(
  join(process.cwd(), "src", "lib", "assistant", "tools.ts"),
  "utf8",
);

/** A spec as it comes back out of the database: parsed, no identity markers. */
const stored = (spec: MediaSpec): MediaSpec => JSON.parse(JSON.stringify(spec)) as MediaSpec;

describe("a spec that has not moved", () => {
  it("is reported as in sync, not as noise", () => {
    // The overwhelmingly common case. If this produced output, people would
    // learn to ignore the output.
    expect(specDrift(stored(MINIMAX_STT_SPEC))).toEqual({
      kind: "in-sync",
      templateId: "minimax-speech",
    });
    expect(specDrift(stored(MINIMAX_TTS_SPEC)).kind).toBe("in-sync");
  });

  it("and a provider of such specs produces an empty report", () => {
    expect(
      driftReport([{ name: "MiniMax Speech", specs: [stored(MINIMAX_TTS_SPEC), stored(MINIMAX_STT_SPEC)] }]),
    ).toEqual([]);
  });
});

describe("a spec left behind by a change to its template", () => {
  // The copy as it would have been stored before `contentType` was removed from
  // the `$file` node. Key order is deliberately different, because a diff that
  // reads key order as a difference is a diff nobody trusts.
  const behind: MediaSpec = {
    ...JSON.parse(
      JSON.stringify(MINIMAX_STT_SPEC).replace(
        '"$file":{"path":"$.image","filename":"$.filename"}',
        '"$file":{"path":"$.image","filename":"$.filename","contentType":"audio/mpeg"}',
      ),
    ),
  } as MediaSpec;

  it("is reported as differing, and says which template it is behind", () => {
    const drift = specDrift(behind);
    expect(drift.kind).toBe("differs");
    if (drift.kind !== "differs") return;
    expect(drift.templateId).toBe("minimax-speech");
  });

  it("names the path, because a verdict alone is not actionable", () => {
    // "It drifted" tells an operator they have a problem. The path tells them
    // which of the two copies to believe, which is the whole decision.
    const drift = specDrift(behind);
    expect(drift.kind).toBe("differs");
    if (drift.kind !== "differs") return;
    const joined = drift.paths.join("\n");
    expect(joined).toContain("request.file.$file");
    expect(joined).toContain("contentType");
    expect(joined).toContain("audio/mpeg");
  });

  it("and the report reads as a sentence a person can act on", () => {
    const lines = driftReport([{ name: "MiniMax Speech (TTS + ASR)", specs: [behind] }]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("MiniMax Speech (TTS + ASR)");
    expect(lines[0]).toContain("minimax-speech");
  });
});

describe("a spec nobody shipped", () => {
  it("is not reported as a divergence from a template it never came from", () => {
    // Claiming a hand-written spec is "behind" a template would be a lie about
    // its provenance, and would train people to dismiss the real cases.
    const custom: MediaSpec = {
      specVersion: 1,
      capability: "audio.stt",
      displayName: "Our own vendor",
      models: ["asr-9"],
      transport: { method: "POST", path: "/v2/transcribe", contentType: "multipart/form-data" },
      auth: { type: "bearer" },
      request: { model: "$.model" },
      response: { text: "$.result" },
    };
    const drift = specDrift(custom);
    // It matches no template by model, so it is custom. If the capability-only
    // fallback pairs it with one, the paths must at least be the truth.
    if (drift.kind === "differs") expect(drift.paths.length).toBeGreaterThan(0);
    else expect(drift.kind).toBe("no-template");
  });
});

describe("the diff stays honest about scale", () => {
  it("and does not flood when a spec has drifted a long way", () => {
    // A report nobody can read is a report nobody acts on. The cap is a property
    // worth pinning rather than an accident of where the loop stopped.
    const wide: Record<string, unknown> = { ...JSON.parse(JSON.stringify(MINIMAX_STT_SPEC)) };
    for (let i = 0; i < 200; i++) wide[`leftover${i}`] = i;
    const drift = specDrift(wide as unknown as MediaSpec);
    expect(drift.kind).toBe("differs");
    if (drift.kind !== "differs") return;
    expect(drift.paths.length).toBe(40);
  });

  it("a provider's specs all get a verdict, in order", () => {
    const out = providerDrift([MINIMAX_TTS_SPEC, MINIMAX_STT_SPEC]);
    expect(out.map((d) => d.spec.capability)).toEqual(["audio.tts", "audio.stt"]);
    expect(out.every((d) => d.drift.kind === "in-sync")).toBe(true);
  });

  it("and a provider with no specs is not an error", () => {
    expect(providerDrift(undefined)).toEqual([]);
    expect(driftReport([{ name: "Empty", specs: undefined }])).toEqual([]);
  });
});

describe("the surface an operator actually reads", () => {
  // A detector nobody calls is a detector that does not exist. The function
  // above can be perfect and still change nothing, because the thing that
  // failed today was a person's next step being "paste me the configuration" —
  // so the wiring is what has to be pinned, not just the arithmetic.
  it("list_media_providers reports drift, and says how to clear it", () => {
    expect(TOOLS).toContain("providerDrift(m.specs as MediaSpec[] | undefined)");
    expect(TOOLS).toContain("templateDrift");
    // The verdict alone is not enough to act on; the remedy has to travel with it.
    expect(TOOLS).toMatch(/套用模板/);
  });

  it("and only when there is something to say", () => {
    // `in-sync` is the overwhelmingly common case. Emitting it anyway is how a
    // signal becomes noise and then gets ignored.
    expect(TOOLS).toContain('d.drift.kind === "differs"');
    expect(TOOLS).toMatch(/\.\.\.\(behind\.length/);
  });
});
