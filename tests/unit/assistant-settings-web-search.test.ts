/**
 * tests/unit/assistant-settings-web-search.test.ts
 *
 * The two preferences that make the per-conversation toggle useful: what a new
 * conversation starts with, and how many results a search may return.
 *
 * Both are nullable on purpose. `null` means "not chosen", so a later change to
 * the defaults still reaches people who never opened the form — and clearing
 * the number box has to be able to return to that state instead of silently
 * pinning today's default.
 *
 * The last block is a guard on the panel's role split: regular users see what
 * they can change, administrators additionally see where the backend comes from
 * and the link to manage it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import {
  getAssistantSettings,
  getPublicAssistantSettings,
} from "@/lib/db/assistant";
import { GET, PUT } from "@/app/api/assistant/settings/route";
import { MAX_SEARCH_RESULTS } from "@/lib/assistant/web-search";

const SRC = join(__dirname, "..", "..", "src");
const PANEL = readFileSync(
  join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx"),
  "utf-8",
);
const PAGE = readFileSync(
  join(SRC, "app", "(user)", "dashboard", "assistant", "page.tsx"),
  "utf-8",
);

async function loginAsNewUser(): Promise<User> {
  const user = await createUser({
    username: "tester",
    password: "correct horse battery",
    displayName: "tester",
  });
  expect(user).not.toBeNull();
  currentStore = new InMemoryCookieStore();
  const s = await getSessionFromStore(currentStore);
  s.userId = user!.id;
  s.username = user!.username;
  s.role = user!.role;
  await s.save();
  return user!;
}

function put(body: unknown): Promise<Response> {
  return PUT(
    new Request("http://localhost/api/assistant/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The smallest configuration the route will accept on the key path. */
function baseSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credentialMode: "key",
    baseUrl: "https://upstream.example/v1",
    model: "some-model",
    apiKey: "sk-test",
    ...over,
  };
}

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
});

describe("defaults", () => {
  it("reports null before anything is chosen", async () => {
    const user = await loginAsNewUser();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { settings: { webSearchDefault: boolean | null; webSearchLimit: number | null } | null };
    };
    expect(body.data.settings).toBeNull();

    const view = await getPublicAssistantSettings(user.id);
    expect(view?.webSearchDefault ?? null).toBeNull();
    expect(view?.webSearchLimit ?? null).toBeNull();
  });
});

describe("saving", () => {
  it("round-trips the toggle and the result count", async () => {
    const user = await loginAsNewUser();
    const res = await put(baseSettings({ webSearchDefault: false, webSearchLimit: 3 }));
    expect(res.status).toBe(200);

    const stored = await getAssistantSettings(user.id);
    expect(stored?.webSearchDefault).toBe(false);
    expect(stored?.webSearchLimit).toBe(3);

    const read = (await (await GET()).json()) as {
      data: { settings: { webSearchDefault: boolean; webSearchLimit: number } };
    };
    expect(read.data.settings).toMatchObject({ webSearchDefault: false, webSearchLimit: 3 });
  });

  it("keeps the stored key when only a preference changes", async () => {
    const user = await loginAsNewUser();
    await put(baseSettings({ webSearchDefault: false }));
    const before = await getAssistantSettings(user.id);

    // No apiKey in this body: the form does not re-send the secret.
    const { apiKey: _omitted, ...withoutKey } = baseSettings({
      webSearchDefault: true,
      webSearchLimit: 4,
    });
    await put(withoutKey);

    const after = await getAssistantSettings(user.id);
    expect(after?.webSearchDefault).toBe(true);
    expect(after?.webSearchLimit).toBe(4);
    expect(after?.encryptedApiKey).toBe(before?.encryptedApiKey);
    expect(after?.encryptedApiKey).not.toBe("");
  });

  it("lets the count go back to 'not chosen'", async () => {
    const user = await loginAsNewUser();
    await put(baseSettings({ webSearchLimit: 5 }));
    expect((await getAssistantSettings(user.id))?.webSearchLimit).toBe(5);

    await put(baseSettings({ webSearchLimit: null }));
    expect((await getAssistantSettings(user.id))?.webSearchLimit).toBeNull();
  });
});

describe("boundaries", () => {
  it(`accepts 1 and ${MAX_SEARCH_RESULTS}, and refuses what lies outside`, async () => {
    await loginAsNewUser();
    expect((await put(baseSettings({ webSearchLimit: 1 }))).status).toBe(200);
    expect((await put(baseSettings({ webSearchLimit: MAX_SEARCH_RESULTS }))).status).toBe(200);
    expect((await put(baseSettings({ webSearchLimit: 0 }))).status).toBe(400);
    expect((await put(baseSettings({ webSearchLimit: MAX_SEARCH_RESULTS + 1 }))).status).toBe(400);
    expect((await put(baseSettings({ webSearchLimit: 2.5 }))).status).toBe(400);
  });

  it("refuses a non-boolean toggle", async () => {
    await loginAsNewUser();
    expect((await put(baseSettings({ webSearchDefault: "yes" }))).status).toBe(400);
  });
});

describe("role-separated rendering", () => {
  it("shows the backend facts and the management link only to administrators", () => {
    // The whole administrator block is behind this condition, so it cannot be
    // rendered for a regular user by accident.
    expect(PANEL).toMatch(/isAdmin\s*&&\s*\(/);
    expect(PANEL).toContain("/admin/search");
    expect(PANEL).toMatch(/webSearch\.backendSource === "db"/);
  });

  it("is fed the availability and the role by the page, not guessed in the client", () => {
    expect(PAGE).toMatch(/webSearchAvailable\s*=/);
    expect(PAGE).toMatch(/isAdmin=\{isAdmin\}/);
    expect(PAGE).toMatch(/available:\s*webSearchAvailable/);
  });
});
