/**
 * tests/unit/text-protocol.test.ts
 *
 * The text provider spec: validation, the four presets, and the parameter
 * policy that makes request parameters actually controllable.
 */
import { describe, it, expect } from "vitest";
import {
  parseTextSpec,
  readTextSpec,
  isTextProtocol,
  TEXT_PROTOCOLS,
  type TextSpec,
} from "@/lib/protocol/text-spec";
import { TEXT_PROTOCOL_PRESETS, protocolPreset, TEXT_PROTOCOL_LABELS } from "@/lib/protocol/text-protocols";
import { applyParameterPolicy, resolveParameterRules, getAt } from "@/lib/protocol/parameter-policy";
import { isValidSpecMapping } from "@/lib/protocol/text-spec-mapping";

const ok = (raw: unknown) => {
  const r = parseTextSpec(raw);
  expect(r.ok, JSON.stringify(r.ok ? "" : r.errors)).toBe(true);
  return (r as { ok: true; spec: TextSpec; warnings: string[] });
};
const bad = (raw: unknown): string[] => {
  const r = parseTextSpec(raw);
  expect(r.ok, `expected this to be rejected`).toBe(false);
  return (r as { ok: false; errors: string[] }).errors;
};

describe("a spec has to say which protocol it is", () => {
  it("and one of exactly the four we ship", () => {
    expect([...TEXT_PROTOCOLS]).toEqual([
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "gemini-generate",
    ]);
    for (const p of TEXT_PROTOCOLS) expect(isTextProtocol(p), p).toBe(true);
    expect(isTextProtocol("openai-completions")).toBe(false);
    expect(isTextProtocol(7)).toBe(false);
  });

  it("a version, so a future one cannot be read as this one", () => {
    expect(bad({ protocol: "openai-chat" }).join()).toMatch(/specVersion/);
    expect(bad({ specVersion: 2, protocol: "openai-chat" }).join()).toMatch(/specVersion/);
    expect(ok({ specVersion: 1, protocol: "openai-chat" }).ok).toBe(true);
  });

  it("an object, not an array or a string", () => {
    expect(bad([]).join()).toMatch(/JSON object/);
    expect(bad("openai-chat").join()).toMatch(/JSON object/);
  });
});

describe("a text spec may not reach outside the request", () => {
  it("the media operators that perform a call are refused", () => {
    // `$fetch` turns a mapping into a program that makes an HTTP request. A text
    // spec describes a body; that is the whole difference.
    const errors = bad({
      specVersion: 1,
      protocol: "openai-chat",
      request: { answer: { $fetch: { url: "https://elsewhere" } } },
    });
    expect(errors.join()).toMatch(/\$fetch/);
  });

  it("and so are the multipart ones", () => {
    for (const op of ["$file", "$dataUrl"]) {
      const errors = bad({
        specVersion: 1,
        protocol: "openai-chat",
        request: { image: { [op]: "x" } },
      });
      expect(errors.join(), op).toMatch(new RegExp(op.replace("$", "\\$")));
    }
  });

  it("while the ordinary operators are fine", () => {
    for (const node of [
      { $const: 1 },
      { $firstPresent: ["$.a", "$.b"] },
      { $ifPresent: { "$.a": "$" } },
      { $merge: { a: "$.b" } },
      { $enum: { "$.size": { map: { s1024: "1024x1024" } } } },
      { $toString: "$.n" },
      { a: { $const: 1 }, b: "$.c" },
      ["$.a", { $const: 2 }],
    ]) {
      expect(isValidSpecMapping(node), JSON.stringify(node)).toBe(true);
    }
  });

  it("an operator sitting beside plain fields is refused, because its meaning would depend on key order", () => {
    expect(isValidSpecMapping({ $const: 1, sibling: "$.a" })).toBe(false);
  });
});

describe("parameter rules have to be usable", () => {
  const withRule = (rule: unknown) => ({ specVersion: 1, protocol: "openai-chat", parameters: { p: rule } });

  it("mode is one of the six, and the six are the whole vocabulary", () => {
    expect(ok(withRule({ mode: "passthrough" })).ok).toBe(true);
    expect(bad(withRule({ mode: "maybe" })).join()).toMatch(/mode must be one of/);
  });

  it("default and force need a value, or they do nothing and look like they work", () => {
    expect(bad(withRule({ mode: "default" })).join()).toMatch(/no value/);
    expect(bad(withRule({ mode: "force" })).join()).toMatch(/no value/);
  });

  it("clamp needs a bound, and the bounds have to make a range", () => {
    expect(bad(withRule({ mode: "clamp" })).join()).toMatch(/neither min nor max/);
    expect(bad(withRule({ mode: "clamp", min: 2, max: 1 })).join()).toMatch(/empty range/);
    expect(ok(withRule({ mode: "clamp", min: 0, max: 2 })).ok).toBe(true);
  });

  it("rename needs a destination", () => {
    expect(bad(withRule({ mode: "rename" })).join()).toMatch(/no "to"/);
    expect(ok(withRule({ mode: "rename", to: "extra_body.thinking" })).ok).toBe(true);
  });
});

describe("reading a provider's spec off a row", () => {
  it("no spec is not an error", () => {
    expect(readTextSpec({ textSpec: null })).toBeNull();
    expect(readTextSpec({})).toBeNull();
  });

  it("and neither is unreadable or invalid json — the request still goes through", () => {
    // Silently degrading to "no policy" is the safe failure: a provider with a
    // broken spec forwards what the client sent, which is what it did before
    // specs existed. Refusing every request would take a documentation mistake
    // out of production.
    expect(readTextSpec({ textSpec: "{not json" })).toBeNull();
    expect(readTextSpec({ textSpec: '{"specVersion":9,"protocol":"nope"}' })).toBeNull();
  });

  it("a valid one comes back parsed", () => {
    const spec = readTextSpec({
      textSpec: JSON.stringify({ specVersion: 1, protocol: "openai-chat", parameters: { a: { mode: "drop" } } }),
    });
    expect(spec?.protocol).toBe("openai-chat");
  });
});

describe("the four presets", () => {
  it("are all valid specs", () => {
    for (const protocol of TEXT_PROTOCOLS) {
      const parsed = parseTextSpec(protocolPreset(protocol));
      expect(parsed.ok, `${protocol}: ${JSON.stringify(parsed.ok ? "" : parsed.errors)}`).toBe(true);
    }
  });

  it("each has a label and a hint, because a dropdown of slugs helps nobody", () => {
    for (const protocol of TEXT_PROTOCOLS) {
      expect(TEXT_PROTOCOL_LABELS[protocol].zh.length).toBeGreaterThan(0);
      expect(TEXT_PROTOCOL_LABELS[protocol].hint.length).toBeGreaterThan(10);
    }
  });

  it("anthropic renames the two fields that differ from the OpenAI spelling", () => {
    const spec = TEXT_PROTOCOL_PRESETS["anthropic-messages"];
    expect(spec.parameters?.stop).toEqual({ mode: "rename", to: "stop_sequences" });
    expect(spec.parameters?.max_completion_tokens).toEqual({ mode: "rename", to: "max_tokens" });
  });

  it("gemini puts sampling under generationConfig, where its API keeps them", () => {
    const spec = TEXT_PROTOCOL_PRESETS["gemini-generate"];
    expect(spec.parameters?.temperature).toEqual({
      mode: "rename",
      to: "generationConfig.temperature",
    });
    // And a parameter Gemini has no notion of is dropped rather than invented.
    expect(spec.parameters?.reasoning_effort).toEqual({ mode: "drop" });
  });

  it("a preset handed out is a copy, so editing one provider does not edit the other", () => {
    const a = protocolPreset("openai-chat");
    a.parameters!.temperature = { mode: "drop" };
    expect(protocolPreset("openai-chat").parameters?.temperature?.mode).toBe("clamp");
    expect(TEXT_PROTOCOL_PRESETS["openai-chat"].parameters?.temperature?.mode).toBe("clamp");
  });
});

describe("the policy decides what the upstream sees", () => {
  const run = (body: Record<string, unknown>, parameters: TextSpec["parameters"]) =>
    applyParameterPolicy(body, { parameters }).body;
  it("anything it does not name is forwarded", () => {
    // The load-bearing default. A gateway that drops what it does not recognise
    // loses parameters every time a vendor ships one, silently.
    const out = run({ seed: 42, somethingNew: "x" }, { temperature: { mode: "drop" } });
    expect(out.seed).toBe(42);
    expect(out.somethingNew).toBe("x");
  });

  it("a spec with no parameters at all changes nothing", () => {
    const body = { model: "m", messages: [], seed: 1 };
    expect(applyParameterPolicy(body, undefined).body).toEqual(body);
    expect(applyParameterPolicy(body, {}).body).toEqual(body);
  });

  it("drop means drop, even when the client was explicit", () => {
    const out = run({ temperature: 0.9 }, { temperature: { mode: "drop" } });
    expect("temperature" in out).toBe(false);
  });

  it("default fills a gap and never overrides a client", () => {
    const p = { temperature: { mode: "default" as const, value: 0.7 } };
    expect(run({}, p).temperature).toBe(0.7);
    expect(run({ temperature: 0.1 }, p).temperature).toBe(0.1);
  });

  it("force overrides, and that is the only mode that can", () => {
    const p = { reasoning_effort: { mode: "force" as const, value: "high" } };
    expect(run({ reasoning_effort: "low" }, p).reasoning_effort).toBe("high");
    expect(run({}, p).reasoning_effort).toBe("high");
  });

  it("clamp holds the client's own value inside the bounds", () => {
    const p = { temperature: { mode: "clamp" as const, min: 0, max: 1 } };
    expect(run({ temperature: 5 }, p).temperature).toBe(1);
    expect(run({ temperature: -1 }, p).temperature).toBe(0);
    expect(run({ temperature: 0.5 }, p).temperature).toBe(0.5);
  });

  it("clamp leaves a non-number alone rather than turning it into one", () => {
    const out = run({ temperature: "high" }, { temperature: { mode: "clamp", max: 1 } });
    expect(out.temperature).toBe("high");
  });

  it("rename moves the value and removes it from where it was", () => {
    const out = run({ stop: ["\n"] }, { stop: { mode: "rename", to: "stop_sequences" } });
    expect(out.stop_sequences).toEqual(["\n"]);
    expect("stop" in out).toBe(false);
  });

  it("rename to a nested path creates the objects on the way", () => {
    const out = run({ reasoning_effort: "high" }, {
      reasoning_effort: { mode: "rename", to: "extra_body.thinking.type" },
    });
    expect(getAt(out, "extra_body.thinking.type")).toBe("high");
    expect("reasoning_effort" in out).toBe(false);
  });

  it("renaming a parameter the client did not send does nothing", () => {
    const out = run({ a: 1 }, { b: { mode: "rename", to: "c" } });
    expect(out).toEqual({ a: 1 });
  });

  it("and the original body is never mutated", () => {
    const body = { temperature: 5, stop: ["x"] };
    applyParameterPolicy(body, {
      parameters: {
        temperature: { mode: "clamp", max: 1 },
        stop: { mode: "rename", to: "stop_sequences" },
      },
    });
    expect(body).toEqual({ temperature: 5, stop: ["x"] });
  });

  it("every decision is reported, so the page can show which rule won", () => {
    const { decisions } = applyParameterPolicy(
      { temperature: 5, reasoning_effort: "low" },
      {
        parameters: {
          temperature: { mode: "clamp", max: 1 },
          reasoning_effort: { mode: "force", value: "high" },
        },
      },
    );
    const byName = new Map(decisions.map((d) => [d.name, d]));
    expect(byName.get("temperature")?.action).toBe("clamped");
    expect(byName.get("reasoning_effort")?.action).toBe("forced");
  });
});

describe("a per-model rule beats the provider's", () => {
  const provider = { parameters: { temperature: { mode: "clamp" as const, max: 2 } } };

  it("so one vendor can be strict for most models and permissive for one", () => {
    const rules = resolveParameterRules(provider, { "model-x": { temperature: { mode: "passthrough" } } }, "model-x");
    expect(rules.temperature.mode).toBe("passthrough");
    expect(resolveParameterRules(provider, { "model-x": { temperature: { mode: "passthrough" } } }, "m2")
      .temperature.mode).toBe("clamp");
  });

  it("and an unconfigured model keeps the provider's rules", () => {
    expect(resolveParameterRules(provider, undefined, "any").temperature.mode).toBe("clamp");
    expect(resolveParameterRules(undefined, undefined, "any")).toEqual({});
  });
});
