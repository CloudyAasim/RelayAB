/**
 * tests/unit/provider-templates.test.ts
 *
 * The vendor templates: what a vendor is, and how each surface reaches it.
 *
 * ## Why this is worth pinning
 *
 * A template used to be a base URL, a kind and a list of model names. **The
 * route table became the answer** — the columns that came before it are only a
 * fallback for rows written before it — so a template that filled in the base
 * URL alone left the routing to whatever the form happened to default to. That
 * default is right for OpenAI and wrong for everyone else: a row created from
 * the Anthropic template sent a Chat Completions body to
 * `api.anthropic.com/chat/completions`, which is a 404.
 *
 * So a template now says **what its vendor speaks**, and these tests are about
 * that claim being true — for every template, not just the one that was
 * missing.
 */
import { describe, it, expect } from "vitest";
import {
  PROVIDER_TEMPLATES,
  getTemplateById,
  templateValues,
} from "@/lib/providers/templates";
import { extractModelEntries } from "@/lib/providers/upstream";
import {
  ROUTE_SURFACES,
  keyCarrierOfRoutes,
  modelListPathOf,
} from "@/lib/protocol/surface-routes";

describe("every template says what its vendor speaks", () => {
  it("carries a route for all four surfaces", () => {
    for (const tpl of PROVIDER_TEMPLATES) {
      for (const surface of ROUTE_SURFACES) {
        const route = tpl.routes[surface];
        expect(route, `${tpl.id} has no route for ${surface}`).toBeTruthy();
        expect(["unsupported", "passthrough", "route"]).toContain(route.kind);
      }
    }
  });

  it("never routes a surface to a dialect the vendor does not speak", () => {
    // A route is a claim: "this vendor publishes this endpoint". The only
    // vendor whose own endpoint the client can reach untouched is Google's,
    // so only the Gemini surface may be a passthrough for a Gemini vendor.
    for (const tpl of PROVIDER_TEMPLATES) {
      for (const surface of ROUTE_SURFACES) {
        const route = tpl.routes[surface];
        if (route.kind === "route") {
          expect(
            ["chat", "responses", "anthropic", "gemini"],
            `${tpl.id} routes ${surface} to something unknown`,
          ).toContain(route.dialect);
        }
      }
    }
  });

  it("has a unique id", () => {
    const ids = PROVIDER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the Google Gemini template", () => {
  const tpl = getTemplateById("google-gemini");

  it("exists", () => {
    expect(tpl, "there is no Google Gemini template").toBeTruthy();
  });

  it("points at Google's own API", () => {
    expect(tpl!.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("answers the Gemini surface the way the client asked", () => {
    // Google's own endpoint: the request goes out as it arrived and the answer
    // comes back as it arrived.
    expect(tpl!.routes["gemini-generate"]).toEqual({ kind: "passthrough" });
  });

  it("serves the OpenAI surfaces by translating them", () => {
    // Google publishes no Chat Completions and no Responses endpoint, so those
    // two surfaces are reached by the gateway rewriting the request.
    expect(tpl!.routes["openai-chat"]).toEqual({ kind: "route", dialect: "gemini" });
    expect(tpl!.routes["openai-responses"]).toEqual({ kind: "route", dialect: "gemini" });
  });

  it("does not claim an Anthropic endpoint Google does not have", () => {
    expect(tpl!.routes["anthropic-messages"]).toEqual({ kind: "unsupported" });
  });

  it("says how the key travels", () => {
    // Google's own API takes the key in `x-goog-api-key`, raw. A request that
    // carries only `Authorization: Bearer` is refused.
    expect(tpl!.keyCarrier).toBe("x-goog-api-key");
  });

  it("is a Gemini row, not an OpenAI-compatible one", () => {
    expect(templateValues(tpl!).kind).toBe("gemini");
  });
});

describe("the templates that were wrong before", () => {
  it("routes the Anthropic template's OpenAI surfaces to Anthropic", () => {
    // Anthropic publishes `/v1/messages` and nothing else. The Chat surface
    // used to be a passthrough, which sent a Chat Completions body to
    // `api.anthropic.com/chat/completions` — a 404.
    const tpl = getTemplateById("anthropic")!;
    expect(tpl.routes["anthropic-messages"]).toEqual({ kind: "passthrough" });
    expect(tpl.routes["openai-chat"]).toEqual({ kind: "route", dialect: "anthropic" });
    expect(tpl.routes["openai-responses"]).toEqual({ kind: "route", dialect: "anthropic" });
  });

  it("routes a Chat-only vendor's Responses surface to Chat", () => {
    // These vendors publish `/chat/completions` and no `/v1/responses`, so a
    // passthrough there is a 404. Translating into Chat always works.
    for (const id of ["deepseek", "minimax", "groq", "openrouter", "siliconflow", "custom"]) {
      const tpl = getTemplateById(id)!;
      expect(tpl.routes["openai-chat"], id).toEqual({ kind: "passthrough" });
      expect(tpl.routes["openai-responses"], id).toEqual({ kind: "route", dialect: "chat" });
    }
  });

  it("leaves the OpenAI template alone", () => {
    // OpenAI publishes both, so both are native — the one template that was
    // already right, and the one that must stay right.
    const tpl = getTemplateById("openai")!;
    expect(tpl.routes["openai-chat"]).toEqual({ kind: "passthrough" });
    expect(tpl.routes["openai-responses"]).toEqual({ kind: "passthrough" });
  });
});

describe("picking a template", () => {
  it("puts the vendor's routing on the form", () => {
    const picked = templateValues(getTemplateById("google-gemini")!);
    expect(picked.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(picked.kind).toBe("gemini");
    expect(picked.routes["gemini-generate"]).toEqual({ kind: "passthrough" });
  });

  it("hands the form a copy, so one template cannot change another", () => {
    const first = templateValues(getTemplateById("openai")!);
    const second = templateValues(getTemplateById("openai")!);
    first.routes["openai-chat"] = { kind: "unsupported" };
    expect(second.routes["openai-chat"]).toEqual({ kind: "passthrough" });
  });

  it("calls Azure's own kind the one the form offers", () => {
    expect(templateValues(getTemplateById("azure-openai")!).kind).toBe("custom-openai");
  });
});

describe("how a row's key travels", () => {
  it("is Google's carrier for a Gemini row", () => {
    const routes = getTemplateById("google-gemini")!.routes;
    expect(keyCarrierOfRoutes(routes)).toBe("x-goog-api-key");
  });

  it("is Bearer for everyone else", () => {
    for (const id of ["openai", "anthropic", "deepseek", "minimax", "custom"]) {
      expect(keyCarrierOfRoutes(getTemplateById(id)!.routes), id).toBe("bearer");
    }
  });

  it("puts Google's model list at /models", () => {
    // Its base URL already carries the version, so `/v1/models` there is a 404
    // that reads as "this vendor has no model list".
    expect(modelListPathOf(getTemplateById("google-gemini")!.routes)).toBe("/models");
    expect(modelListPathOf(getTemplateById("openai")!.routes)).toBe("/v1/models");
  });
});

describe("Google's model list", () => {
  it("is read, names and all", () => {
    // Google's list has no `id`: each model is named `models/<name>`, and the
    // bare name is the one that goes in the URL.
    const entries = extractModelEntries({
      models: [
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("gemini-2.5-flash");
    expect(entries[0].contextLength).toBe(1048576);
    expect(entries[0].maxOutputTokens).toBe(65536);
  });

  it("still reads the OpenAI shape", () => {
    const entries = extractModelEntries({
      data: [{ id: "gpt-5.4", context_length: 1050000, max_output_tokens: 128000 }],
    });
    expect(entries[0].id).toBe("gpt-5.4");
    expect(entries[0].contextLength).toBe(1050000);
    expect(entries[0].maxOutputTokens).toBe(128000);
  });

  it("does not mistake a bare name for a path", () => {
    const entries = extractModelEntries({ models: [{ name: "gemini-2.5-flash" }] });
    expect(entries[0].id).toBe("gemini-2.5-flash");
  });
});
