/**
 * tests/unit/assistant-tool-arguments.test.ts
 *
 * The 502 that was not a server error.
 *
 * A model emitted a tool call whose `arguments` were not valid JSON. The call was
 * replayed on the next round exactly as the model wrote it, and the vendor
 * answered the *whole request* with
 *
 *     400 Assistant tool call <id>.arguments must be valid JSON
 *
 * which this deployment reported as `上游调用失败（HTTP 502）`. The model never
 * got a chance to correct itself: the request died before it was read.
 *
 * Two things are pinned here: arguments are made replayable as soon as they come
 * off the wire (and again when a stored row is replayed), and the store-side
 * redaction is structural — the old regex could turn valid JSON into invalid
 * JSON when a key-shaped *word* appeared inside a string value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeToolArguments } from "@/lib/assistant/tool-arguments";
import { redactToolCalls, toWireMessages } from "@/lib/assistant/chat";
import type { AssistantMessage } from "@/lib/assistant/schema";

const ROOT = process.cwd();
const CLIENT = readFileSync(join(ROOT, "src", "lib", "assistant", "client.ts"), "utf8");
const CHAT = readFileSync(join(ROOT, "src", "lib", "assistant", "chat.ts"), "utf8");

describe("normalizeToolArguments", () => {
  it("turns an empty string into an empty object", () => {
    // A call with no parameters; `JSON.parse("")` throws, and some vendors send
    // it as "".
    expect(normalizeToolArguments("")).toEqual({ arguments: "{}", invalid: false });
    expect(normalizeToolArguments("   ")).toEqual({ arguments: "{}", invalid: false });
    expect(normalizeToolArguments(undefined)).toEqual({ arguments: "{}", invalid: false });
  });

  it("keeps valid arguments byte for byte — the protocol replays them", () => {
    const args = '{"prompt":"一只猫","n":1}';
    expect(normalizeToolArguments(args)).toEqual({ arguments: args, invalid: false });
  });

  it("replaces truncated or non-object arguments with {} and says so", () => {
    for (const bad of ['{"prompt":"一只猫', '{"a":1,}', "[]", "5", "null", '"text"']) {
      expect(normalizeToolArguments(bad), bad).toEqual({ arguments: "{}", invalid: true });
    }
  });
});

describe("redactToolCalls is structural, not textual", () => {
  it("redacts a secret nested anywhere and keeps the JSON parseable", () => {
    const [out] = redactToolCalls([
      {
        id: "c",
        type: "function",
        function: {
          name: "t",
          arguments: JSON.stringify({ provider: { name: "X", apiKey: "sk-leaked" }, prompt: "keep" }),
        },
      },
    ]);
    expect(out.function.arguments).not.toContain("sk-leaked");
    expect(out.function.arguments).toContain('"prompt":"keep"');
    expect(JSON.parse(out.function.arguments)).toMatchObject({ provider: { apiKey: "***" } });
  });

  it("does not touch a key-shaped word inside a string value", () => {
    // The old regex matched the escaped quotes in here, ate the closing one, and
    // left unparseable JSON in the transcript — which every later turn replayed.
    const args = JSON.stringify({ note: 'she said "token":"abc" out loud' });
    const [out] = redactToolCalls([
      { id: "c", type: "function", function: { name: "t", arguments: args } },
    ]);
    expect(() => JSON.parse(out.function.arguments)).not.toThrow();
    expect(JSON.parse(out.function.arguments)).toEqual({ note: 'she said "token":"abc" out loud' });
  });

  it("leaves a call with no secret exactly as it was", () => {
    const args = JSON.stringify({ name: "X", baseUrl: "https://a.example/v1" });
    const [out] = redactToolCalls([
      { id: "c", type: "function", function: { name: "t", arguments: args } },
    ]);
    expect(out.function.arguments).toBe(args);
  });
});

describe("replaying a stored transcript", () => {
  it("never sends arguments a vendor would reject", async () => {
    const rows = [
      {
        id: "m1",
        threadId: "t",
        role: "assistant",
        content: "",
        reasoning: null,
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "generate_image", arguments: '{"prompt":"一只猫' },
          },
        ],
        toolCallId: null,
        toolName: null,
        attachments: [],
        createdAt: "2026-11-13T00:00:01.000Z",
      },
      {
        id: "m2",
        threadId: "t",
        role: "tool",
        content: "工具执行失败：…",
        reasoning: null,
        toolCalls: [],
        toolCallId: "call_1",
        toolName: "generate_image",
        attachments: [],
        createdAt: "2026-11-13T00:00:02.000Z",
      },
    ] as unknown as AssistantMessage[];

    const wire = await toWireMessages(rows, "u1");
    const assistant = wire.find((m) => m.role === "assistant") as
      | { tool_calls?: Array<{ function: { arguments: string } }> }
      | undefined;
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe("{}");
    expect(() => JSON.parse(assistant!.tool_calls![0].function.arguments)).not.toThrow();
  });
});

describe("where the guard is wired", () => {
  it("normalises on receipt, before the call can be replayed", () => {
    expect(CLIENT).toContain("normalizeToolArguments(");
    expect(CLIENT).toContain("invalidArguments");
  });

  it("does not execute a call whose arguments were lost", () => {
    // `{}` would otherwise be run as if the model had asked for it.
    expect(CHAT).toMatch(/if \(call\.invalidArguments\)/);
    expect(CHAT).toContain("assistant.message.invalidToolArguments");
  });

  it("normalises again on the way out, for rows written before the fix", () => {
    expect(CHAT).toMatch(/normalizeToolArguments\(c\.function\.arguments\)/);
  });
});
