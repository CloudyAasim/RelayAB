import { describe, it, expect } from "vitest";
import { DICTS } from "@/lib/i18n/dict";

/**
 * Dictionary hygiene guards.
 *
 * The English dictionary previously held a handful of values that were still
 * Chinese (e.g. `nav.keys` = "密钥"), which surfaced as Chinese text in the
 * English UI. These two checks catch that class of mistake and any key that
 * only exists in one locale.
 */

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

describe("i18n: dictionary hygiene", () => {
  it("the English dictionary contains no CJK characters", () => {
    const offenders = Object.entries(DICTS.en)
      .filter(([, value]) => typeof value === "string" && CJK.test(value))
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    expect(offenders, `untranslated English entries:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("both locales define exactly the same keys", () => {
    const en = Object.keys(DICTS.en).sort();
    const zh = Object.keys(DICTS["zh-CN"]).sort();
    expect(en).toEqual(zh);
  });
});
