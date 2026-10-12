/**
 * tests/unit/assistant-proposal-validated-first.test.ts
 *
 * A proposal that cannot be applied was still offered for approval.
 *
 * The administrator approved a media-provider change and got
 *
 *   配置不合法：async.poll.statusMap."":wait: must be "ok", "fail" or "wait" …
 *
 * — a genuine catch. The `statusMap` entry did not parse, and the whole
 * proposal died at the apply, after the click. The proposal was spent and the
 * administrator's approval with it, and neither of them had been told anything
 * was wrong before then.
 *
 * The check was never missing from the system. Both admin media-provider
 * endpoints have dry-run `validateMediaSpecs` before the write, because a spec
 * that does not parse should be rejected in the panel rather than on a live
 * request. It was missing from the assistant's two media tools — and from all
 * five, in fact: no propose tool checked its payload at propose time, so every
 * schema rule, spec rule and page rule only ever ran after the one click that
 * cannot be taken back.
 *
 * These tests hold the shape rather than one instance of it. The instance is
 * the `statusMap`; the shape is "checked at approval instead of before it",
 * and that has now produced three separate incidents — the unknown-key
 * rejection (`upstreamFormat`), the free-model gate, and this.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkProposal, isProposalKind } from "@/lib/assistant/proposal-validation";

const ROOT = process.cwd();
const TOOLS = readFileSync(join(ROOT, "src", "lib", "assistant", "tools.ts"), "utf-8");
const ROUTE = readFileSync(
  join(ROOT, "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
  "utf-8",
);

/** Every tool handler that creates a pending action. */
function proposeHandlers(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /^(?:export )?async function (propose[A-Za-z]+)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(TOOLS)) !== null) {
    const start = m.index;
    const next = TOOLS.slice(start + 1).search(/\n(?:export )?(?:async )?function [A-Za-z]/);
    const end = next < 0 ? TOOLS.length : start + 1 + next;
    out.push({ name: m[1], body: TOOLS.slice(start, end) });
  }
  return out;
}

const handlers = proposeHandlers();

describe("every propose tool checks its payload before offering it", () => {
  it("finds the propose tools at all, so this is not vacuous", () => {
    // Put first on purpose. Without a non-empty list every loop below runs zero
    // times and the file goes green while testing nothing.
    expect(handlers.length, "no propose_* handler found in tools.ts").toBeGreaterThanOrEqual(5);
  });

  it.each(handlers.map((h) => [h.name, h.body] as const))(
    "%s runs the shared check",
    (_name, body) => {
      // Before `createAssistantAction`, not after: the whole point is that a
      // payload that cannot be applied never becomes something to approve.
      const gate = body.indexOf("checkProposal(");
      const action = body.indexOf("createAssistantAction(");
      expect(gate, "no proposal check at all").toBeGreaterThan(-1);
      expect(action, "creates no action, so there is nothing to order").toBeGreaterThan(-1);
      expect(gate, "the check runs after the action already exists").toBeLessThan(action);
    },
  );

  it.each(handlers.map((h) => [h.name, h.body] as const))(
    "%s refuses rather than offering it",
    (_name, body) => {
      expect(body).toMatch(/if \(!gate\.ok\) return fail\(gate\.message!\);/);
    },
  );

  it.each(handlers.map((h) => [h.name, h.body] as const))(
    "%s hands the warnings on rather than half the gate",
    (_name, body) => {
      // The admin endpoints return warnings alongside errors, because a spec
      // that is merely unusual is worth reading even when it is legal. A tool
      // that refuses on errors and drops those is showing half of it.
      expect(body, "the check's warnings are discarded").toContain("gate.warnings");
    },
  );
});

describe("the apply path uses the same check", () => {
  it("calls checkProposal rather than parsing on its own", () => {
    // Two implementations of "what a proposal may contain" is how a `statusMap`
    // ended up validated in the admin panel and in neither of the assistant's
    // two media tools. One function, two call sites, no third copy.
    expect(ROUTE).toContain("checkProposal(");
    expect(ROUTE, "the route still declares its own schemas").not.toMatch(
      /^(?:export )?const \w*Args?Schema = z\./m,
    );
  });

  it("and keeps the re-check, because the proposal and the approval can be a day apart", () => {
    // The variable is named for what it holds rather than for where it is
    // used, so this asks about the shape and not about the name.
    expect(ROUTE).toMatch(/if \(!\w+\.ok\) \{[\s\S]{0,400}setAssistantActionStatus/);
  });

  it("and refuses an unknown kind rather than guessing a schema", () => {
    // `kind` is a plain string in SQLite, so an older row can hold something
    // this module has no rule for.
    expect(ROUTE).toContain("isProposalKind(claimed.kind)");
    expect(isProposalKind("media_provider.update")).toBe(true);
    expect(isProposalKind("provider.delete")).toBe(false);
  });
});

describe("the check itself refuses the payload that started this", () => {
  /**
   * A video spec that is valid in every respect except the `statusMap` under
   * test, so a refusal can only have come from the map.
   *
   * Written out rather than taken from a template because the point is that
   * this shape passes. The first version of this fixture had no
   * `response.items` and no `{{taskId}}` in the poll path, and its
   * "well-formed one passes" case failed for two reasons that had nothing to do
   * with what it was checking — which is the same lesson as the guard above,
   * one layer down.
   */
  const videoSpec = (statusMap: Record<string, string>) => [
    {
      specVersion: 1,
      capability: "video.generate",
      displayName: "Agnes Video",
      models: ["agnes-video-2.5-flash"],
      transport: { method: "POST", path: "/v1/videos", contentType: "application/json" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: {
        taskId: "$.video_id",
        status: "$.status",
        items: [
          { kind: "url", value: { $fetch: { path: "$.video_id", url: "/v1/files/{{taskId}}" } } },
        ],
        successCount: { $const: 1 },
      },
      async: {
        submitTaskId: "$.video_id",
        poll: { path: "/agnesapi?video_id={{taskId}}", statusMap },
      },
    },
  ];

  it("a statusMap whose values are not ok/fail/wait", () => {
    // The one that actually happened: an entry mapping a vendor state to
    // something that is not a verdict.
    const result = checkProposal("media_provider.create", {
      name: "Agnes",
      models: { "agnes-video-2.5-flash": { upstreamId: "agnes-video-2.5-flash" } },
      specs: videoSpec({ Success: "ok", Processing: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/statusMap/);
    // Verbatim: the assistant fixes what it is told, so it has to be told the
    // whole list and nothing paraphrased.
    expect(result.message).toMatch(/我先没有生成提案/);
  });

  it("a statusMap with no catch-all, which is the same class of hang", () => {
    const result = checkProposal("media_provider.update", {
      specs: videoSpec({ Success: "ok", Fail: "fail" }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/catch-all/);
  });

  it("a well-formed one passes", () => {
    // Otherwise the test above could be satisfied by refusing everything.
    const result = checkProposal("media_provider.update", {
      specs: videoSpec({ Success: "ok", Fail: "fail", "": "wait" }),
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeTruthy();
  });

  it("and an unknown field is refused by the same call", () => {
    // The `upstreamFormat` incident, in the media shape it would take today.
    const result = checkProposal("media_provider.update", { specz: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/提案本身的问题/);
  });

  it("doc pages carry the rules that are about the list, not one page", () => {
    const page = { id: "voices", title: "音色", body: "…" };
    const dupes = checkProposal("doc_pages.update", { docPages: [page, { ...page }] });
    expect(dupes.ok).toBe(false);
    expect(dupes.message).toMatch(/重复/);
  });
});