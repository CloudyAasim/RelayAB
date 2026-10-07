/**
 * tests/unit/assistant-media-spec-reference.test.ts
 *
 * The assistant could not read the two things a media spec is written from.
 *
 * Asked to bring a media provider up to date, it gathered the drift report, saw
 * that the TTS spec was missing a `voices` field, correctly concluded that the
 * empty `/v1/audio/voices` was the cause — and then stopped. It could not act:
 *
 *  - The **protocol** lives in `docs/模型适配协议/README.md`. `read_docs` resolves
 *    i18n keys, so the admin page rendered it and the tool returned the sentence
 *    that announces it ("下面就是协议本身…可整份复制给 AI") followed by nothing. The
 *    model read a page pointing at content that was not in it, and said so.
 *  - The **templates** are a module value. `list_media_providers` reports drift
 *    against them, but abbreviates each value at 60 characters — so the missing
 *    field arrived as `模板={"remote":{"auth":{"type":"bearer"},"request":{"voice_typ…`.
 *
 * So it asked the user to paste JSON. The gap was not a missing document; it was
 * a missing door onto two documents that were already in the process.
 *
 * The second half of this file guards the thing that would have sent the fix the
 * wrong way: the drift report used to say "click 套用模板 in the admin UI", and
 * doing exactly that walks the ASR spec's file path back from `$.file` to
 * `$.image` — a bug found, fixed and verified twice in one day.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import type { AuthedUser } from "@/lib/auth/session";

const admin: AuthedUser = { id: "u-admin", username: "admin", role: "admin", timezone: "utc" };
const regular: AuthedUser = { id: "u-plain", username: "plain", role: "user", timezone: "utc" };

const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

const call = (args: Record<string, unknown>, user: AuthedUser = admin) =>
  executeTool("get_media_spec_reference", JSON.stringify(args), { user, relayKey: "sk-relay-x" });

interface Payload {
  ok: boolean;
  content: string;
}
const callJson = async (args: Record<string, unknown>, user: AuthedUser = admin) => {
  const res = (await call(args, user)) as Payload;
  expect(res.ok, res.content.slice(0, 300)).toBe(true);
  return JSON.parse(res.content) as Record<string, never>;
};

describe("the media spec reference is reachable", () => {
  it("is offered to an administrator", () => {
    expect(toolDefinitions(true).map((t) => t.function.name)).toContain("get_media_spec_reference");
  });

  it("and not to a regular user", () => {
    // It describes this deployment's media surface, which is admin-only for the
    // same reason `list_media_providers` is.
    expect(toolDefinitions(false).map((t) => t.function.name)).not.toContain(
      "get_media_spec_reference",
    );
  });

  it("and the dispatch refuses a regular user who asks anyway", async () => {
    const res = (await call({ what: "templates" }, regular)) as Payload;
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/管理员/);
  });
});

describe("what=\"templates\": the template values, whole", () => {
  it("returns the TTS spec with a complete `voices` declaration", async () => {
    const out = await callJson({ what: "templates", capability: "audio.tts" });
    const templates = out.templates as unknown as Array<{
      id: string;
      specs: Array<{ capability: string; voices?: Record<string, never> }>;
    }>;
    expect(templates.length).toBeGreaterThan(0);

    const spec = templates.flatMap((t) => t.specs).find((s) => s.capability === "audio.tts");
    expect(spec, "no audio.tts template came back").toBeTruthy();
    expect(spec!.voices, "the template has no voices block to copy").toBeTruthy();

    const remote = (spec!.voices as unknown as { remote: Record<string, never> }).remote;
    expect(remote.transport).toMatchObject({ method: "POST", path: "/v1/get_voice" });
    // The field the drift report could not show: it needs more than the 60
    // characters that report abbreviates to, so its absence there is not evidence
    // of anything.
    expect(JSON.stringify(remote).length).toBeGreaterThan(60);
    expect(JSON.stringify(remote)).toContain("voice_type");
  });

  it("is filterable by capability, and says what exists when it cannot", async () => {
    const out = await callJson({ what: "templates", capability: "image.generate" });
    const specs = (out.templates as unknown as Array<{ specs: Array<{ capability: string }> }>).flatMap(
      (t) => t.specs,
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.capability).toBe("image.generate");

    const miss = (await call({ what: "templates", capability: "audio.nope" })) as Payload;
    expect(miss.ok).toBe(false);
    // The error lists what there is, so one wrong guess does not end the search.
    expect(miss.content).toContain("audio.tts");
  });

  it("warns that a template is a starting point and not the truth", async () => {
    const out = await callJson({ what: "templates" });
    expect(String(out.note)).toMatch(/起点|正确/);
    expect(String(out.note)).toMatch(/specEdits/);
  });
});

describe("what=\"protocol\": the protocol document", () => {
  it("returns real text and says how long the whole thing is", async () => {
    const out = await callJson({ what: "protocol" });
    // One window, not the document: 76 KB in a single tool result is a large
    // fraction of a turn spent on a reference the model needs a section of.
    expect(String(out.text).length).toBeGreaterThan(1000);
    expect(Number(out.total)).toBeGreaterThan(String(out.text).length);
    expect(String(out.text).length).toBeLessThanOrEqual(40_000);
    expect(out.nextOffset).toBeDefined();
    // And the window starts where the section written for this job is, not at
    // the file's first paragraph.
    expect(String(out.text)).toContain("## 0. 给 AI 的操作说明");
  });

  it("pages, and the pages cover the whole document with no gap", async () => {
    const first = await callJson({ what: "protocol", limit: 4000 });
    expect(String(first.text).length).toBe(4000);
    expect(Number(first.nextOffset)).toBe(4000);

    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 200; guard++) {
      const page = await callJson({ what: "protocol", offset, limit: 4000 });
      seen.push(String(page.text));
      const next = page.nextOffset;
      if (next === undefined) break;
      expect(Number(next)).toBeGreaterThan(offset);
      offset = Number(next);
    }
    expect(seen.join("").length, "paging did not reach the end").toBe(Number(first.total));
  });

  it("and the last page does not advertise another one", async () => {
    // `nextOffset: 0` on the final window would send the model back to the start
    // of a 76 KB document, forever.
    const out = await callJson({ what: "protocol", offset: 999_000 });
    expect(String(out.text)).toBe("");
    expect(out.nextOffset).toBeUndefined();
  });
});

describe("the drift report points at the template instead of at the button", () => {
  it("names the tool that can return the value", () => {
    expect(TOOLS).toContain("get_media_spec_reference(what=");
  });

  it("and no longer tells the model to re-apply the template wholesale", () => {
    // It used to, verbatim: "后台「媒体服务商」里点「套用模板」保存，即可把这份拷贝换成当前模板。"
    // The ASR spec's `request.file.$file.path` reads `$.image` in the template and
    // `$.file` in the stored copy, because the client puts the audio in `file`. That
    // difference was found, fixed by proposal and verified — and the instruction
    // was to undo it.
    expect(TOOLS).not.toContain("点「套用模板」保存，即可把这份拷贝换成当前模板");
    expect(TOOLS).toMatch(/不要整份套用模板/);
  });

  it("and says the abbreviated values are not the whole value", () => {
    // The paths are capped at 60 characters each. Without saying so, a truncated
    // JSON fragment reads as the field's complete content.
    expect(TOOLS).toMatch(/60 字符/);
  });
});

describe("specEdits advertises what it can actually write", () => {
  it("says any top-level field, not only the three it lists", async () => {
    // `applySpecEdits` shallow-merges whatever keys arrive, so `voices` was always
    // writable. The schema listed three others and the model concluded from that
    // it could not touch the field the fix required.
    const def = toolDefinitions(true).find(
      (t) => t.function.name === "propose_media_provider_update",
    )!;
    const specEdits = (
      def.function.parameters as {
        properties: { specEdits: { description: string } };
      }
    ).properties.specEdits;
    expect(specEdits.description).toMatch(/任何/);
    expect(specEdits.description).toMatch(/voices/);
    expect(specEdits.description).toMatch(/浅合并/);
  });
});