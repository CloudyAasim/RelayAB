/**
 * tests/unit/assistant-config.test.ts
 *
 * The one rule the assistant's configuration is read by, called directly.
 *
 * This is where the two reported bugs actually lived. "The model I picked is
 * gone after a refresh" and "the assistant works without a model" are the same
 * defect seen from two sides: the configuration was held in component state on
 * one path and in the database on the other, and the gap between them was filled
 * with whatever model the server happened to find first. So the rule that
 * decides "which model, and can I send yet" is one pure function, and it is
 * tested by calling it — no regex over source, no click in a browser.
 */
import { describe, it, expect } from "vitest";
import {
  ASSISTANT_REASONING_SUGGESTIONS,
  modelParamsForRequest,
  resolveAssistantConfig,
  resolveMode,
  resolveModel,
  type AssistantReasoningEffort,
} from "@/lib/assistant/config";

/** A fully configured key-path row, the shape an existing deployment has. */
const keyRow = {
  credentialMode: null as "key" | null,
  model: "gpt-4o",
  accountModel: null as string | null,
  encryptedApiKey: "enc:…",
  baseUrl: "https://api.example.com/v1",
};

describe("which mode a row is in", () => {
  it("no row at all is the account path, and is not ready", () => {
    // Nothing has been configured, so there is no key-path configuration to
    // honour, and the account path needs nothing but a model. It does not have
    // one, so the turn is refused — which is the entire point: an unconfigured
    // assistant used to answer anyway.
    expect(resolveMode(null)).toBe("account");
    const config = resolveAssistantConfig(null);
    expect(config.model).toBe("");
    expect(config.ready).toBe(false);
    expect(config.missing).toBe("no-model");
  });

  it("a row written before the mode existed is the key path", () => {
    // Every pre-existing row has a base URL, a key and a model in it. Reading
    // NULL as "account" would silently move those people to a different upstream
    // the next time they opened the page.
    expect(resolveMode(keyRow)).toBe("key");
    expect(resolveModel(keyRow)).toBe("gpt-4o");
  });

  it("and an explicit mode is taken at its word", () => {
    expect(resolveMode({ ...keyRow, credentialMode: "account" })).toBe("account");
    expect(resolveModel({ ...keyRow, credentialMode: "account" })).toBe("");
    expect(resolveModel({ ...keyRow, credentialMode: "account", accountModel: "deepseek" })).toBe(
      "deepseek",
    );
  });
});

describe("the model survives being read back", () => {
  it("each mode reads its own model and ignores the other's", () => {
    // Two model fields, one active. The rule has to be "the active mode's", or
    // filling in the field that is not on screen would decide the answer.
    const both = { ...keyRow, credentialMode: "account" as const, accountModel: "deepseek" };
    expect(resolveModel({ ...both, credentialMode: "key" })).toBe("gpt-4o");
    expect(resolveModel(both)).toBe("deepseek");
  });

  it("a blank model is blank, not ready, on both paths", () => {
    for (const row of [
      { ...keyRow, model: "" },
      { ...keyRow, model: "   " },
      { ...keyRow, credentialMode: "account" as const, accountModel: null },
      { ...keyRow, credentialMode: "account" as const, accountModel: "" },
    ]) {
      const config = resolveAssistantConfig(row);
      expect(config.model).toBe("");
      expect(config.ready).toBe(false);
      expect(config.missing).toBe("no-model");
    }
  });
});

describe("the key path still needs what it uses", () => {
  it("a complete row is ready", () => {
    const config = resolveAssistantConfig(keyRow);
    expect(config.ready).toBe(true);
    expect(config.missing).toBeNull();
    expect(config.hasApiKey).toBe(true);
  });

  it("and each missing piece is named rather than lumped together", () => {
    expect(resolveAssistantConfig({ ...keyRow, baseUrl: "" }).missing).toBe("no-upstream");
    expect(resolveAssistantConfig({ ...keyRow, encryptedApiKey: "" }).missing).toBe("no-key");
  });

  it("but the account path needs neither, because it uses neither", () => {
    // Asking the account path for an address or a key it does not use is how a
    // person ends up staring at a field that cannot help them.
    const config = resolveAssistantConfig({
      credentialMode: "account",
      accountModel: "deepseek",
      baseUrl: "",
      encryptedApiKey: "",
    });
    expect(config.ready).toBe(true);
    expect(config.missing).toBeNull();
    expect(config.hasApiKey).toBe(false);
  });

  it("and the account path with a model but no key is still ready", () => {
    expect(resolveAssistantConfig({ ...keyRow, credentialMode: "account", accountModel: "x" }).ready).toBe(
      true,
    );
  });
});

describe("the parameters are one setting, on both paths", () => {
  it("read from the row whichever mode is active", () => {
    const row = {
      ...keyRow,
      temperature: 0.3,
      maxOutputTokens: 1024,
      topP: 0.9,
      contextLength: 128000,
      reasoningEffort: "high" as const,
      // The switch alongside the level: same row, same read, both paths. They
      // are two answers to two questions and a config that kept only one of them
      // would still pass the level assertions above.
      thinkingType: "adaptive" as const,
    };
    for (const mode of ["account", "key"] as const) {
      const config = resolveAssistantConfig({ ...row, credentialMode: mode });
      expect(config.params, mode).toEqual({
        contextLength: 128000,
        maxOutputTokens: 1024,
        temperature: 0.3,
        topP: 0.9,
        reasoningEffort: "high",
        thinkingType: "adaptive",
      });
    }
  });

  it("absent ones are null, never zero", () => {
    const { params } = resolveAssistantConfig(keyRow);
    expect(params).toEqual({
      contextLength: null,
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      reasoningEffort: null,
      thinkingType: null,
    });
  });

  it("and only the configured ones reach the request", () => {
    expect(modelParamsForRequest(resolveAssistantConfig(keyRow).params)).toEqual({});
    expect(
      modelParamsForRequest(
        resolveAssistantConfig({ ...keyRow, temperature: 0, topP: 0.7, maxOutputTokens: 512 }).params,
      ),
    ).toEqual({ maxTokens: 512, temperature: 0, topP: 0.7 });
  });
});

/**
 * The thinking level, which is not a number and not a scale of our own.
 *
 * "Not set" and "the lowest level" have to stay different answers: the first
 * leaves the decision — and the bill — with the model, the second takes it away.
 * That is why the option list starts with a blank rather than with `minimal`.
 */
describe("the thinking level", () => {
  it("is the model's own spelling, not one of ours", () => {
    // The regression this replaced: a closed list of four. The levels are
    // published per model — some have four, some three, some an off switch,
    // some nothing at all — so a list is a suggestion and the field is free.
    // Typed as a plain string, and a vendor's own word survives the round trip
    // whether or not anybody here has heard of it.
    expect(modelParamsForRequest({ ...EMPTY, reasoningEffort: "high" })).toEqual({
      reasoningEffort: "high",
    });
    expect(
      modelParamsForRequest({ ...EMPTY, reasoningEffort: "xhigh" as AssistantReasoningEffort }),
    ).toEqual({ reasoningEffort: "xhigh" });
    expect(modelParamsForRequest({ ...EMPTY, reasoningEffort: "off" })).toEqual({
      reasoningEffort: "off",
    });
    expect(modelParamsForRequest({ ...EMPTY, reasoningEffort: null })).toEqual({});
    // Read back from a row, so the storage spelling is covered too.
    expect(
      modelParamsForRequest(resolveAssistantConfig({ ...keyRow, reasoningEffort: "medium" }).params),
    ).toEqual({ reasoningEffort: "medium" });
  });

  it("offers the common spellings as suggestions, and nothing more", () => {
    // A starting point for a person who does not want to look it up, and
    // explicitly not a contract: the option list is a convenience, the text
    // field is the answer. Five steps, because a four-step default left the
    // top of the range unreachable for any model that has one.
    expect([...ASSISTANT_REASONING_SUGGESTIONS]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

const EMPTY = {
  contextLength: null,
  maxOutputTokens: null,
  temperature: null,
  topP: null,
  reasoningEffort: null,
  thinkingType: null,
} as const;
