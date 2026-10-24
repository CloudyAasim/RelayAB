/**
 * tests/unit/proxy-conversion-fidelity.test.ts
 *
 * What the conversion chain carries, and what it used to drop.
 *
 * ## The failure mode this file exists for
 *
 * A conversion that loses part of the request produces an answer — a confident,
 * well-formed answer to a *different* question. Nothing in the response says
 * so: the status is 200, the text reads normally, and the client has no way to
 * know that the picture it attached never reached the model.
 *
 * That is worse than an error, so the two things that used to go missing are
 * pinned here:
 *
 *  - **images** — a multimodal question that loses its picture;
 *  - **structured output** — a client that asked for JSON and got prose.
 */
import { describe, it, expect } from "vitest";
import {
  chatToResponsesRequest,
  responsesToChatRequest,
} from "@/lib/proxy/converters/chat";
import { responsesToAnthropicRequest } from "@/lib/proxy/converters/anthropic";
import { responsesToGeminiRequest } from "@/lib/protocol/gemini";

const DATA_URL = "data:image/png;base64,AAAB";

describe("a Chat request becomes a pivot request", () => {
  it("carries the picture", () => {
    // The picture is part of the question. Dropping it leaves the model
    // answering as if it had never been asked.
    const pivot = chatToResponsesRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: DATA_URL } },
          ],
        },
      ],
    } as never);

    const content = (pivot.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]
      .content;
    expect(content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: DATA_URL },
    ]);
  });

  it("carries a picture given as a plain address", () => {
    const pivot = chatToResponsesRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }],
        },
      ],
    } as never);

    const content = (pivot.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]
      .content;
    expect(content).toEqual([
      { type: "input_image", image_url: "https://example.test/a.png" },
    ]);
  });

  it("carries the structured-output instruction", () => {
    const pivot = chatToResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema: { type: "object" }, strict: true },
      },
    } as never);

    expect(pivot.text).toEqual({
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: true,
      },
    });
  });
});

describe("a pivot request becomes a Chat request", () => {
  it("carries the structured-output instruction back", () => {
    const chat = responsesToChatRequest({
      model: "m",
      input: "hi",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object" },
          strict: true,
        },
      },
    } as never);

    expect(chat.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
  });

  it("and the plain JSON mode", () => {
    const chat = responsesToChatRequest({
      model: "m",
      input: "hi",
      text: { format: { type: "json_object" } },
    } as never);
    expect(chat.response_format).toEqual({ type: "json_object" });
  });
});

describe("a pivot request becomes an Anthropic request", () => {
  it("carries the picture as bytes", () => {
    // Anthropic takes the bytes; the pivot's data URL is the bytes written out.
    const anthropic = responsesToAnthropicRequest({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: DATA_URL },
          ],
        },
      ],
    } as never);

    const messages = anthropic.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
    ]);
  });

  it("carries a picture given as an address", () => {
    const anthropic = responsesToAnthropicRequest({
      model: "m",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.test/a.png" }],
        },
      ],
    } as never);

    const messages = anthropic.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
    ]);
  });

  it("keeps a text-only message in the plain string form", () => {
    // Anthropic's own clients send a string, and that is still what the vendor
    // expects for a message with no blocks.
    const anthropic = responsesToAnthropicRequest({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    } as never);

    const messages = anthropic.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toBe("hi");
  });
});

describe("a pivot request becomes a Gemini request", () => {
  it("carries the picture as bytes", () => {
    const gemini = responsesToGeminiRequest({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: DATA_URL },
          ],
        },
      ],
    });

    expect(gemini.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "what is this" },
          { inlineData: { mimeType: "image/png", data: "AAAB" } },
        ],
      },
    ]);
  });
});
