/**
 * tests/unit/assistant-media-spec-roundtrip.test.ts
 *
 * The admin pressed approve and it failed with "Invalid media provider
 * configuration", three times, with nothing further.
 *
 * Two things were wrong, and they compounded:
 *
 *  1. `list_media_providers` showed the model a *summary* of each spec —
 *     `capability`, `displayName`, and `method`/`path` hoisted out of the
 *     `transport` object they actually live in, with `request`, `response`,
 *     `auth` and the rest omitted. The model then proposed specs in exactly
 *     that shape, because it had only ever seen that shape. A spec like that
 *     cannot work: it has no request mapping and no response mapping, so
 *     nothing upstream is ever called.
 *
 *  2. The validator knew exactly what was wrong — `MediaProviderValidationError`
 *     carries an `issues` list — and the apply route threw all of it away,
 *     keeping only the class name. So the admin got a refusal with no reason,
 *     and the model got a refusal with no reason, and the second could only
 *     guess again.
 *
 * This file pins the round trip: what the tool shows, and what the validator
 * accepts, have to be the same thing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { validateMediaSpecs, parseMediaSpec } from "@/lib/media/spec";
import { applySpecEdits, executeTool } from "@/lib/assistant/tools";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { getAssistantAction } from "@/lib/db/assistant";
import { createMediaProvider } from "@/lib/db/media-providers";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import {
  MINIMAX_IMAGE_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_STT_SPEC,
  OPENAI_TTS_SPEC,
  OPENAI_STT_SPEC,
} from "@/lib/media/seeds";

const STORED = [
  MINIMAX_IMAGE_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_STT_SPEC,
  OPENAI_TTS_SPEC,
  OPENAI_STT_SPEC,
] as unknown as Record<string, unknown>[];

function errorsOf(specs: unknown[]): string[] {
  return validateMediaSpecs(specs).errors;
}

describe("what the model is shown is what it must send back", () => {
  it("the stored specs validate", () => {
    expect(errorsOf(STORED)).toEqual([]);
  });

  it("the summary shape does not, and that is the whole problem", () => {
    // Exactly the shape `list_media_providers` used to hand over.
    const summary = STORED.map((s) => ({
      capability: s.capability,
      displayName: s.displayName,
      method: (s.transport as { method?: string } | undefined)?.method,
      path: (s.transport as { path?: string } | undefined)?.path,
      models: s.models ?? null,
    }));
    expect(errorsOf(summary).length).toBeGreaterThan(0);
  });

  it("a spec with no transport is refused rather than half-accepted", () => {
    // A media spec without a path is a spec that calls nothing, which reads as
    // "configured" in a list and fails on first use.
    const parsed = parseMediaSpec({ capability: "image.generate", displayName: "x", method: "POST", path: "/v1/x" });
    expect(parsed.ok).toBe(false);
  });
});

describe("the refusal explains itself", () => {
  it("carries issues, which is the part that was being thrown away", () => {
    const errors = errorsOf([{ capability: "image.generate" }]);
    expect(errors.length).toBeGreaterThan(0);
    // Something a person can act on, not a class name.
    for (const e of errors) {
      expect(e.length).toBeGreaterThan(4);
      expect(e).not.toBe("Invalid media provider configuration");
    }
  });

  it("names what is missing, so the model can fix it rather than guess again", () => {
    const errors = errorsOf([{ capability: "image.generate", method: "POST", path: "/v1/x" }]).join(" ");
    expect(errors).toMatch(/transport|request|response|spec/i);
  });
});

describe("editing a spec without retyping it", () => {
  // The failure that motivated this: the model was told to copy the spec
  // verbatim, produced four tool calls in a row of ~15 KB each, and every one
  // was invalid JSON — `_request` where the field is `request`, head and tail
  // intact and the middle mangled. The arguments parsed to `{}`, so the tool
  // said "缺少 providerId" and the admin saw a refusal with no reason.
  //
  // Asking a model to echo a document back is not a reliable operation. Sending
  // the edit and merging it here is.
  const [IMAGE, VIDEO, TTS] = STORED;

  it("changes only the field named, and leaves the rest of the spec alone", () => {
    const { specs, error } = applySpecEdits([IMAGE, VIDEO, TTS], [
      { index: 1, displayName: "改过的名字" },
    ]);
    expect(error).toBeUndefined();
    expect((specs[1] as Record<string, unknown>).displayName).toBe("改过的名字");
    // The blocks that were being lost, and the neighbours, untouched.
    expect((specs[1] as Record<string, unknown>).transport).toEqual(VIDEO.transport);
    expect((specs[1] as Record<string, unknown>).request).toEqual(VIDEO.request);
    expect((specs[1] as Record<string, unknown>).response).toEqual(VIDEO.response);
    expect(specs[0]).toEqual(IMAGE);
    expect(specs[2]).toEqual(TTS);
  });

  it("the merged result is what the validator accepts", () => {
    // The point of merging rather than retyping: a rename cannot corrupt the
    // parts of the document the rename did not touch.
    const { specs, error } = applySpecEdits(STORED, [{ index: 1, displayName: "改过的名字" }]);
    expect(error).toBeUndefined();
    expect(errorsOf(specs)).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    // The provider's own row, read on the next turn, must be unchanged until
    // the admin approves.
    const before = JSON.stringify(STORED);
    applySpecEdits(STORED, [{ index: 0, displayName: "改过的名字" }]);
    expect(JSON.stringify(STORED)).toBe(before);
  });

  it("an index outside the list is refused rather than creating a spec", () => {
    // Silently appending would be the worst outcome: a capability that appears
    // in the list and has never been configured.
    const { error } = applySpecEdits(STORED, [{ index: 99, displayName: "x" }]);
    expect(error).toMatch(/越界/);
  });

  it("an edit with no index is refused, and says what it wanted", () => {
    const { error } = applySpecEdits(STORED, [{ displayName: "x" }]);
    expect(error).toMatch(/index/);
  });

  it("the tool offers the patch, and says why", () => {
    const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");
    expect(TOOLS).toMatch(/specEdits/);
    expect(TOOLS).toMatch(/不要把整个 specs 数组重发一遍|重发极易在传输中损坏/);
  });

  it("and the prompt says so before any tool is chosen", () => {
    const PROMPTS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "prompts.ts"), "utf-8");
    expect(PROMPTS).toMatch(/specEdits/);
    expect(PROMPTS).toMatch(/不要把整个 specs 数组重发一遍/);
  });
});

describe("what actually reaches the approval", () => {
  // The load-bearing property. A merge that happens and is then thrown away —
  // or stored under a key the apply route's strict schema rejects — is the same
  // failure with more code in it.
  let store: InMemoryCookieStore;
  let user: User;

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "spec-edit",
      password: "correct horse battery",
      displayName: "spec-edit",
      role: "admin",
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();
  });

  afterEach(() => {
    currentStore = null;
  });

  it("stores the merged array, not the edits", async () => {
    const provider = await createMediaProvider({
      name: "Media",
      baseUrl: "https://upstream.test",
      apiKey: "vendor",
      models: { "image-01": { upstreamId: "image-01", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });

    const result = await executeTool(
      "propose_media_provider_update",
      JSON.stringify({
        providerId: provider.id,
        summary: "改个名字",
        specEdits: [{ index: 0, displayName: "改过的名字" }],
      }),
      { user: { ...user, timezone: "shanghai" } } as never,
    );
    expect(result.ok, result.content.slice(0, 200)).toBe(true);

    const actionId = (result.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
    const action = await getAssistantAction(user.id, actionId);
    const args = JSON.parse(action!.args);

    // The key the apply route understands...
    expect(args).toHaveProperty("specs");
    // ...and not the one it would reject.
    expect(args).not.toHaveProperty("specEdits");

    expect(args.specs[0].displayName).toBe("改过的名字");
    // The blocks that were being lost are present, because they were never
    // retyped.
    expect(args.specs[0].transport).toEqual(MINIMAX_IMAGE_SPEC.transport);
    expect(args.specs[0].request).toEqual(MINIMAX_IMAGE_SPEC.request);
    expect(args.specs[0].response).toEqual(MINIMAX_IMAGE_SPEC.response);
    // And what is stored is something the validator accepts.
    expect(errorsOf(args.specs)).toEqual([]);
  });
});

describe("the read tool stops teaching the wrong shape", () => {
  const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

  it("never hands over a shape that is not the shape", () => {
    // The summary hoisted `method` and `path` out of `transport` and dropped
    // everything that makes a spec work. A model shown only that will propose
    // only that, and it will not validate. A summary may be *smaller*; what it
    // must not be is *different* — so `transport` comes through whole.
    const fn = TOOLS.slice(TOOLS.indexOf("async function listMediaProvidersTool"));
    expect(fn.slice(0, 2000)).not.toMatch(/method: s\.transport\?\.method/);
    expect(fn.slice(0, 2000)).toContain("transport: (s as MediaSpec).transport");
  });

  it("and still hands over the whole spec when it is asked twice", () => {
    // The default is smaller, not different: a model that is about to edit a spec
    // gets exactly the payload that was always here, byte for byte. Without this
    // the summary would be the only way to read a spec, and "which shape does a
    // spec have" would have two answers.
    const fn = TOOLS.slice(TOOLS.indexOf("async function listMediaProvidersTool"));
    expect(fn.slice(0, 2000)).toContain("specForTheModel(s)");
    expect(TOOLS).toMatch(/full: \{[\s\S]{0,40}"boolean"/);
  });

  it("tells the model to copy a spec rather than compose one", () => {
    // Both the read that shows them and the write that validates them.
    expect(TOOLS).toMatch(/与 list_media_providers 返回的形状逐字一致/);
    expect(TOOLS).toMatch(/整份复制，再只改/);
  });

  it("and the prompt says so in words, before any tool is chosen", () => {
    const PROMPTS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "prompts.ts"), "utf-8");
    expect(PROMPTS).toMatch(/不要自己编/);
    // The reason, not just the rule: a spec without a request/response mapping
    // saves cleanly and then calls nothing.
    expect(PROMPTS).toMatch(/调用不了任何东西/);
  });
});

describe("the refusal reaches the person who pressed approve", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
    "utf-8",
  );

  it("uses the issues, which are the only actionable part of the error", () => {
    expect(ROUTE).toMatch(/err instanceof MediaProviderValidationError[\s\S]{0,160}err\.issues\.join/);
  });

  it("uses the issues for a validation error, not the class name", () => {
    // The last catch is the one that wraps the apply; the first is the admin
    // guard. A validation error has to be answered from `issues` — the class
    // name is what the admin saw, and it is what the model saw, and it is the
    // reason the second attempt was another guess.
    const at = ROUTE.lastIndexOf("} catch (err) {");
    const catchBlock = ROUTE.slice(at, ROUTE.indexOf("export async function GET", at));
    const validation = catchBlock.indexOf("instanceof MediaProviderValidationError");
    const join = catchBlock.indexOf("err.issues.join");
    const bare = catchBlock.indexOf("err.message");
    expect(validation, "no validation branch").toBeGreaterThan(-1);
    expect(join, "the issues are not used").toBeGreaterThan(validation);
    // The generic fallback is fine and necessary for every other error; what
    // matters is that it is second.
    expect(bare, "the generic message is gone entirely").toBeGreaterThan(join);
  });
});
