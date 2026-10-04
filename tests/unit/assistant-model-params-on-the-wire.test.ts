/**
 * The model parameters, checked against the request that is actually built.
 *
 * Every other guard for this feature reads the source and matches a shape. That
 * is enough to catch a deleted line and useless for catching the failure that
 * matters: four columns, four boxes, a save that writes them all, and a request
 * that carries none of them — a feature that looks complete and changes nothing,
 * with the model answering exactly as before and nothing on screen to say why.
 *
 * So this file calls the client with a transport that captures the body and
 * asserts on the captured object. If a parameter stops reaching the wire, this
 * fails; no amount of matching source text would notice.
 */
import { describe, it, expect } from "vitest";
import { callAssistantModel, type CallModelOptions } from "@/lib/assistant/client";

/** A one-chunk SSE stream: enough for `readTurn` to return a turn. */
function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = [
    ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const DONE = {
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

/** Run one turn and hand back the body the client would have posted. */
async function capture(
  overrides: Partial<CallModelOptions> = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  await callAssistantModel({
    model: "some-model",
    messages: [{ role: "user", content: "hi" }],
    transport: async ({ body }) => {
      captured = body as Record<string, unknown>;
      return sse([DONE]);
    },
    ...overrides,
  });
  expect(captured, "the transport was never called").not.toBeNull();
  return captured as unknown as Record<string, unknown>;
}

describe("what actually goes on the wire", () => {
  it("a configured parameter is sent", async () => {
    const body = await capture({
      maxTokens: 4096,
      temperature: 0.3,
      topP: 0.9,
      reasoningEffort: "high",
    });
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
    expect(body.reasoning_effort).toBe("high");
  });

  it("an unset parameter is not sent at all", async () => {
    // The point of the whole design. `temperature: undefined` is still a key in
    // the JSON body once serialised, and a key the upstream fills in is a
    // default this system chose rather than one the caller did.
    const body = await capture();
    for (const key of ["temperature", "top_p", "max_tokens", "reasoning_effort"]) {
      expect(Object.keys(body), `${key} was sent unchosen`).not.toContain(key);
    }
  });

  it("a configured zero is sent, because zero is a real setting", async () => {
    // The reason the guards upstream say `!= null` and not "truthy": 0 is the
    // most deterministic temperature there is, and a truthiness test drops it —
    // the request would then carry no temperature at all, which is the opposite
    // of what was asked for.
    const body = await capture({ temperature: 0, topP: 0 });
    expect(body.temperature).toBe(0);
    expect(body.top_p).toBe(0);
  });

  it("and the parameters survive serialisation, not just object construction", async () => {
    // The body is JSON.parse-able and the keys are present, which is the last
    // place an `undefined` could have turned into `null` on the way out.
    const body = await capture({ maxTokens: 256, temperature: 0.7 });
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    expect(wire.max_tokens).toBe(256);
    expect(wire.temperature).toBe(0.7);
  });

  it("tools still ride along with the parameters", async () => {
    const body = await capture({
      temperature: 0.2,
      tools: [
        {
          type: "function",
          function: { name: "do_thing", description: "d", parameters: { type: "object" } },
        },
      ],
    });
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0.2);
  });
});
