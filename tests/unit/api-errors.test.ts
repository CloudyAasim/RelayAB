/**
 * tests/unit/api-errors.test.ts
 *
 * The API returns English `error.message` strings. Rendering those directly
 * put English text inside an otherwise Chinese UI, so forms resolve the
 * machine-readable `error.code` through the active locale instead.
 */
import { describe, it, expect } from "vitest";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { translate } from "@/lib/i18n/dict";

const zh = (key: string) => translate("zh-CN", key);
const en = (key: string) => translate("en", key);

describe("apiErrorMessage", () => {
  it("maps known codes to Chinese messages", () => {
    expect(apiErrorMessage(zh, "wrong_current_password")).toBe(
      "当前密码不正确，请重新输入。",
    );
    expect(apiErrorMessage(zh, "max_keys_reached")).toContain("活跃密钥上限");
    expect(apiErrorMessage(zh, "forbidden")).toBe("你没有权限执行此操作。");
  });

  it("maps known codes to English messages", () => {
    expect(apiErrorMessage(en, "wrong_current_password")).toBe(
      "The current password is incorrect. Please re-enter it.",
    );
    expect(apiErrorMessage(en, "user_disabled")).toContain("Failed");
  });

  it("falls back to the server message for unknown codes", () => {
    const serverText = "Some brand new failure";
    expect(apiErrorMessage(zh, "totally_new_code", serverText)).toBe(serverText);
  });

  it("falls back to a generic message when there is neither code nor message", () => {
    expect(apiErrorMessage(zh, undefined, undefined)).toBe(zh("common.failed"));
    expect(apiErrorMessage(en, undefined, undefined)).toBe(en("common.failed"));
  });

  it("never returns a raw i18n key", () => {
    // A code that maps to a key we forgot to define must not leak "apiError.x".
    const out = apiErrorMessage(zh, "not_found", "server fallback");
    expect(out).not.toMatch(/^apiError\./);
    expect(out).not.toMatch(/^settings\./);
  });
});
