/**
 * tests/unit/docs-thinking-shape.test.ts
 *
 * The catalogue said "not declared" for every model with an empty levels list.
 * That is true of one of the three cases an empty list can mean, and it was the
 * answer for all of them — including models that visibly think on every reply.
 *
 * The tests below pin the four shapes against the real models that prompted the
 * split, and pin the component to using the decision rather than re-deriving it
 * from the list length, which is how the wrong answer came back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { thinkingShape, type ThinkingFields } from "@/lib/docs/thinking";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const COMPONENT = read("src", "components", "docs", "ModelCatalog.tsx");
const DICT = read("src", "lib", "i18n", "dict.ts");

function model(fields: Partial<ThinkingFields>): ThinkingFields {
  return {
    reasoningLevels: [],
    reasoningEffortSupported: null,
    thinkingSwitchSupported: null,
    ...fields,
  };
}

describe("a model that takes levels", () => {
  it("shows the vendor's own words", () => {
    expect(thinkingShape(model({ reasoningLevels: ["low", "medium", "high", "xhigh", "max"] }))).toBe(
      "levels",
    );
  });

  it("is still 'levels' when it also cannot be switched off", () => {
    // MiniMax-M3.1: `reasoning_effort` really does change the depth, and
    // `thinking: disabled` is a 400. The list outranks the switch, because the
    // list is the answer to the question this row asks.
    expect(
      thinkingShape(
        model({
          reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
          reasoningEffortSupported: null,
          thinkingSwitchSupported: false,
        }),
      ),
    ).toBe("levels");
  });
});

describe("a model that thinks but cannot shift", () => {
  it("with a switch and no gears is not 'undeclared'", () => {
    // MiniMax-M3: the vendor states outright that other models ignore
    // `reasoning_effort`, and the switch is `thinking: adaptive | disabled`.
    // An on/off is not a gear, so the levels list stays empty — and empty used to
    // mean "this model has declared no thinking levels", which is false.
    expect(
      thinkingShape(model({ reasoningEffortSupported: false, thinkingSwitchSupported: true })),
    ).toBe("switchOnly");
  });

  it("with neither is not 'undeclared' either", () => {
    // The M2 series: it takes `disabled` and reasons anyway. There is no control
    // to offer, and there is also no missing declaration — the model always
    // thinks, and saying nothing was wrong about that.
    expect(
      thinkingShape(model({ reasoningEffortSupported: false, thinkingSwitchSupported: false })),
    ).toBe("alwaysOn");
  });

  it("and an undeclared switch is not the same as one that cannot close", () => {
    // This is the shape the row got wrong, and it got it wrong while carrying a
    // comment saying it must not. `null` means nobody has said; "always on" is a
    // claim about what a vendor will do. Reaching it from an absent field
    // asserts it on the vendor's behalf, and it is the shape a model is left in
    // whenever somebody fills one field and forgets the other.
    expect(
      thinkingShape(model({ reasoningEffortSupported: false, thinkingSwitchSupported: null })),
    ).toBe("effortOnly");
  });
});

describe("a model nobody has described", () => {
  it("is the only thing that is actually undeclared", () => {
    expect(thinkingShape(model({}))).toBe("undeclared");
  });

  it("stays undeclared when only one of the two was answered", () => {
    // One `false` on its own is not a claim about the other field. Reading the
    // second from the first is what would grey out a switch nobody has ruled on.
    // And the reverse — a switch declared with no ruling on the levels — is its
    // own shape, because a switch with no declared levels is a real model.
    expect(thinkingShape(model({ reasoningEffortSupported: false }))).toBe("effortOnly");
    expect(thinkingShape(model({ thinkingSwitchSupported: false }))).toBe("undeclared");
    expect(thinkingShape(model({ thinkingSwitchSupported: true }))).toBe("undeclared");
  });
});

describe("the row itself", () => {
  it("asks the decision rather than re-reading the list length", () => {
    // The bug was one condition. If the component grows its own copy of it, the
    // two can disagree and the tests above stop describing the page.
    expect(COMPONENT).toMatch(/value=\{reasoningText\(m, thinkingShape\(m\), t\)\}/);
    expect(COMPONENT).not.toMatch(
      /reasoningLevels\.length > 0[\s\S]{0,120}reasoningNone/,
    );
  });

  it("has a word for each of the four empty-list cases, not one", () => {
    expect(COMPONENT).toMatch(/t\("docs\.catalog\.reasoningSwitchOnly"\)/);
    expect(COMPONENT).toMatch(/t\("docs\.catalog\.reasoningAlwaysOn"\)/);
    expect(COMPONENT).toMatch(/t\("docs\.catalog\.reasoningEffortOnly"\)/);
    expect(COMPONENT).toMatch(/t\("docs\.catalog\.reasoningNone"\)/);
  });

  it("prints the switch on its own, and only when somebody said", () => {
    // A separate axis, which fails on its own: a model can have levels and still
    // be impossible to turn off. Rendered only when declared, so it never claims
    // a model without a switch when all it means is that nobody asked.
    expect(COMPONENT).toMatch(/m\.thinkingSwitchSupported !== null &&/);
    expect(COMPONENT).toMatch(/\? t\("docs\.catalog\.thinkingSwitchYes"\)/);
    expect(COMPONENT).toMatch(/: t\("docs\.catalog\.thinkingSwitchNo"\)/);
  });
});

describe("the words", () => {
  it("exist in both languages, because the row has no fallback", () => {
    for (const key of [
      "reasoningSwitchOnly",
      "reasoningAlwaysOn",
      "reasoningEffortOnly",
      "thinkingSwitch",
      "thinkingSwitchYes",
      "thinkingSwitchNo",
    ]) {
      const hits = DICT.match(new RegExp(`"docs\\.catalog\\.${key}":`, "g")) ?? [];
      expect(hits.length, `${key} must be translated in both dictionaries`).toBe(2);
    }
  });

  it("and say something different from each other", () => {
    // Four keys that quietly rendered the same string would pass every other
    // test here while putting the old lie back on the page.
    const values = [
      "reasoningSwitchOnly",
      "reasoningAlwaysOn",
      "reasoningEffortOnly",
      "reasoningNone",
    ].map((key) => DICT.match(new RegExp(`"docs\\.catalog\\.${key}": "([^"]*)"`))?.[1]);
    expect(new Set(values).size).toBe(4);
    for (const v of values) expect(v).toBeTruthy();
  });
});
