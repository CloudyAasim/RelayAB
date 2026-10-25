/**
 * tests/unit/assistant-key-label.test.ts
 *
 * The assistant's own credential, and the name it is shown under.
 *
 * It is a **row in the admin's key list**, and its label is stored — so it
 * arrives as a string, in one language, for an administrator who may read the
 * interface in another. The marker says one thing: "this one belongs to the
 * assistant", and it is the only thing it has ever said.
 *
 * So the marker is translated on the way to the screen and **the stored value
 * is left alone**: it is what an existing row carries, it is what the rename
 * form has to prefill, and it is what tells the row apart from a key somebody
 * happened to name the same way.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ASSISTANT_KEY_LABEL, assistantKeyLabel } from "@/lib/db/assistant-keys";
import { translate } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf-8");

describe("the assistant's own credential is named in the reader's language", () => {
  it("the stored marker is translated on the way to the screen", () => {
    expect(assistantKeyLabel(ASSISTANT_KEY_LABEL, (key) => translate("en", key))).toBe(
      "AI assistant only",
    );
    expect(assistantKeyLabel(ASSISTANT_KEY_LABEL, (key) => translate("zh-CN", key))).toBe(
      "AI 助手专用",
    );
  });

  it("a label somebody typed is left alone", () => {
    // A person who typed their label in Chinese means it in Chinese, even on
    // an English screen. Only the assistant's own marker is ours to translate.
    const t = (key: string) => translate("en", key);
    expect(assistantKeyLabel("我的手机", t)).toBe("我的手机");
    expect(assistantKeyLabel("ci key", t)).toBe("ci key");
    expect(assistantKeyLabel("", t)).toBe("");
  });

  it("and the stored value is what the row still carries", () => {
    // Translating it in the database would lose it in every language: the
    // Chinese screen would then show the English marker.
    expect(ASSISTANT_KEY_LABEL).toBe("AI 助手专用");
  });
});

describe("every screen that shows a key label goes through it", () => {
  it("the admin key list", () => {
    const page = read("src", "app", "(admin)", "admin", "keys", "page.tsx");
    expect(page).toContain("assistantKeyLabel(k.label, t)");
    expect(page).not.toContain("{k.label}");
  });

  it("the action menu and the rename form", () => {
    const actions = read("src", "app", "(admin)", "admin", "keys", "KeyActions.tsx");
    expect(actions).toContain("assistantKeyLabel(apiKey.label, t)");
    // And saving the name unchanged puts the **stored** marker back rather than
    // writing the translation into the row — the marker is what tells the row
    // apart, in every language.
    expect(actions).toMatch(/trimmed === displayLabel \? apiKey\.label : trimmed/);
  });

  it("the admin usage page's key filter", () => {
    const page = read("src", "app", "(admin)", "admin", "usage", "page.tsx");
    expect(page).toContain("assistantKeyLabel(key.label, t)");
  });
});
