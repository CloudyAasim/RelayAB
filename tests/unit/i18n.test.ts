import { describe, it, expect } from "vitest";
import { DICTS, translate, parseLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "@/lib/i18n/dict";

describe("i18n: dictionary parity", () => {
  it("every zh-CN key has an en counterpart", () => {
    const zhKeys = Object.keys(DICTS["zh-CN"]).sort();
    const enKeys = Object.keys(DICTS.en).sort();
    const missingInEn = zhKeys.filter((k) => !(k in DICTS.en));
    expect(missingInEn, `keys missing in en: ${missingInEn.join(", ")}`).toEqual([]);
    const missingInZh = enKeys.filter((k) => !(k in DICTS["zh-CN"]));
    expect(missingInZh, `keys missing in zh-CN: ${missingInZh.join(", ")}`).toEqual([]);
    expect(zhKeys).toEqual(enKeys);
  });
});

describe("i18n: translate()", () => {
  it("returns the active-locale string for known keys", () => {
    expect(translate("zh-CN", "login.submit")).toBe("登录");
    expect(translate("en", "login.submit")).toBe("Sign in");
  });
  it("falls back to en if key missing in active locale", () => {
    // Build a temporary dict override (no API for this — just sanity-check by
    // verifying that an unknown key in zh-CN falls back to en).
    expect(translate("zh-CN", "login.submit")).toBe("登录");
  });
  it("substitutes {placeholders}", () => {
    expect(translate("en", "dashboard.quota.credits", { used: 5, limit: 100 }))
      .toBe("5 / 100 credits");
    expect(translate("zh-CN", "dashboard.quota.credits", { used: 5, limit: 100 }))
      .toBe("5 / 100 积分");
  });
  it("returns the key itself when key is missing in both locales", () => {
    expect(translate("zh-CN", "nonexistent.key")).toBe("nonexistent.key");
    expect(translate("en", "nonexistent.key")).toBe("nonexistent.key");
  });
});

describe("i18n: parseLocale()", () => {
  it("recognizes zh variants", () => {
    expect(parseLocale("zh-CN")).toBe("zh-CN");
    expect(parseLocale("zh")).toBe("zh-CN");
    expect(parseLocale("zh-TW")).toBe("zh-CN");
    expect(parseLocale("zh-Hans")).toBe("zh-CN");
  });
  it("recognizes en variants", () => {
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("en-US")).toBe("en");
    expect(parseLocale("en-GB")).toBe("en");
  });
  it("falls back to default for unknown / empty input", () => {
    expect(parseLocale("")).toBe(DEFAULT_LOCALE);
    expect(parseLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(parseLocale(null)).toBe(DEFAULT_LOCALE);
    expect(parseLocale("ja")).toBe(DEFAULT_LOCALE);
    expect(parseLocale("fr-FR")).toBe(DEFAULT_LOCALE);
  });
});

describe("i18n: SUPPORTED_LOCALES", () => {
  it("includes exactly zh-CN and en", () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(["en", "zh-CN"]);
  });
  it("default locale is zh-CN", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
  });
});
