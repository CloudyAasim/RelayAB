/**
 * tests/unit/proposal-diff-names-every-writable-field.test.ts
 *
 * The confirmation screen is the last thing between a model's configuration and
 * a human approving it, and its contract is that it names the change. That
 * contract was stated in the code as an invariant and then quietly broken:
 * `MODEL_DIFF_FIELDS` never learned about `thinkingSwitchSupported`, so a
 * proposal whose only change was the thinking switch rendered no diff at all.
 * No error, no warning — an approval screen indistinguishable from an empty one.
 *
 * Nothing at runtime could catch that, so both halves are pinned here: the list
 * against the write schema, which is what stops the *next* field being forgotten,
 * and the rendered output, which is what the human actually reads.
 */
import { describe, expect, it } from "vitest";

import { MODEL_DIFF_KEYS, renderProviderDiff } from "@/lib/assistant/diff";
import { ModelConfigPatchSchema } from "@/lib/db/types";
import type { Provider } from "@/lib/db/types";

/** The single source of what a model config can hold. */
const WRITABLE_FIELDS = Object.keys(
  ModelConfigPatchSchema.shape as Record<string, unknown>,
);

/**
 * Writable, and deliberately not a field row.
 *
 * `clientId` is the key of the `modelConfigs` object, so the diff already prints
 * it as the row heading — `m:` above the fields of that model. Listing it as a
 * field as well would render `客户端模型名：m → m` under a line that already says
 * `m:`, which is the noise this list exists to avoid. The exemption is not
 * "close enough", so the test below pins that it is genuinely still shown.
 */
const SHOWN_AS_THE_ROW_KEY = ["clientId"];

function providerWith(overrides: Record<string, unknown> = {}): Provider {
  return {
    id: "p1",
    name: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimax.cn/v1",
    enabled: true,
    priority: 0,
    encryptedApiKey: "x",
    modelMapping: { m: "m" },
    modelConfigs: {
      m: {
        upstreamId: "m",
        clientId: "m",
        contextLength: 204_800,
        maxOutputTokens: 131_072,
        reasoningLevels: [],
        enabled: true,
      },
    },
    upstreamFormat: "responses",
    openaiEnabled: true,
    anthropicEnabled: true,
    anthropicBaseUrl: null,
    headers: {},
    upstreamId: null,
    ...overrides,
  } as unknown as Provider;
}

describe("the diff's field list", () => {
  it("names every field a model config write path accepts", () => {
    // The invariant diff.ts claims in its own comment. It was false for
    // `thinkingSwitchSupported`, and a field added to the schema without adding
    // it here is accepted, stored, and never shown to the person approving it.
    const missing = WRITABLE_FIELDS.filter(
      (f) => !MODEL_DIFF_KEYS.includes(f) && !SHOWN_AS_THE_ROW_KEY.includes(f),
    );
    expect(missing, `these fields would change with no diff line: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("and an exempted field is still on the screen somewhere", () => {
    // The exemption above is a claim about the renderer, so it is checked
    // against the renderer rather than trusted. A distinctive id, because the
    // assertion is that the *value* is on screen — and an id like "m" would
    // match half the diff by accident.
    const distinctive = "minimax-m2-7-thinking";
    const diff = renderProviderDiff(
      providerWith({
        modelMapping: { [distinctive]: distinctive },
        modelConfigs: {
          [distinctive]: {
            upstreamId: "m2-7",
            clientId: distinctive,
            contextLength: 204_800,
            maxOutputTokens: 131_072,
            reasoningLevels: [],
            enabled: true,
          },
        },
      }),
      { modelConfigs: { [distinctive]: { contextLength: 1 } } },
      "改上下文",
    );
    for (const key of SHOWN_AS_THE_ROW_KEY) {
      expect(diff, `${key} must still be identifiable on the screen`).toContain(
        distinctive,
      );
    }
  });

  it("and has no entry for a field that is not writable", () => {
    // The other direction: a label for something the write path drops would
    // describe a change that cannot happen, which is its own kind of lie.
    const extra = MODEL_DIFF_KEYS.filter((f) => !WRITABLE_FIELDS.includes(f));
    expect(extra, `these labels describe fields no write path accepts: ${extra.join(", ")}`)
      .toEqual([]);
  });

  it("holds up when the schema is read from the shared shape", () => {
    // Guards the guard: a schema swapped for the wrong object would make the
    // comparison above pass by comparing a list against itself.
    expect(WRITABLE_FIELDS).toContain("thinkingSwitchSupported");
    expect(WRITABLE_FIELDS.length).toBeGreaterThan(5);
  });
});

describe("a proposal that changes only the thinking switch", () => {
  // The real case: the M2 series, where the switch is the whole point and
  // nothing else about the model moves. Before the label existed this rendered
  // an empty model section, because `if (!changed.length) continue` skipped the
  // whole row.
  const diff = renderProviderDiff(
    providerWith(),
    {
      modelConfigs: {
        m: {
          upstreamId: "m",
          clientId: "m",
          contextLength: 204_800,
          maxOutputTokens: 131_072,
          reasoningLevels: [],
          reasoningEffortSupported: false,
          thinkingSwitchSupported: false,
          enabled: true,
        },
      },
    },
    "关掉 M2 的思考开关",
  );

  it("still says the model is in the diff at all", () => {
    expect(diff).toContain("m:");
  });

  it("names the switch, in the operator's units", () => {
    expect(diff).toContain("支持思考开关");
    // Before and after, or the reader cannot tell what is being claimed.
    expect(diff).toMatch(/支持思考开关：.+→/);
  });

  it("and still names the effort field when that is what moved", () => {
    // The two fail separately, so the other one must not vanish with it.
    expect(diff).toContain("支持思考等级");
  });
});

describe("a proposal that changes the switch and nothing else", () => {
  // The worst shape, and the one the original fixture hid: the row renderer
  // does `if (!changed.length) continue`, so a proposal whose only change is an
  // unlabelled field does not render a thinner diff — it renders *no diff for
  // that model at all*. The fixture above changed the effort field too, which
  // kept the row alive and would have let this case pass unnoticed.
  const onlySwitch = renderProviderDiff(
    providerWith({
      modelConfigs: {
        m: {
          upstreamId: "m",
          clientId: "m",
          contextLength: 204_800,
          maxOutputTokens: 131_072,
          reasoningLevels: [],
          reasoningEffortSupported: false,
          enabled: true,
        },
      },
    }),
    {
      modelConfigs: {
        m: {
          upstreamId: "m",
          clientId: "m",
          contextLength: 204_800,
          maxOutputTokens: 131_072,
          reasoningLevels: [],
          reasoningEffortSupported: false,
          thinkingSwitchSupported: false,
          enabled: true,
        },
      },
    },
    "关掉 M2 的思考开关",
  );

  it("produces a diff that says something happened", () => {
    // The model section itself, not merely the provider header — an empty
    // section is the exact thing that let an invisible change be approved.
    expect(onlySwitch).toContain("模型配置");
    expect(onlySwitch).toContain("支持思考开关");
  });
});
