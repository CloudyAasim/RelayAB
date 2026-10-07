/**
 * GET /v1/credits.
 *
 * The balance question has to be answerable *before* a request is made — "is
 * there enough left to cover this?" — so it cannot live only on the responses of
 * calls that have already been made. DeepSeek and MiniMax both ship a dedicated
 * endpoint for exactly that reason; the response headers carry the same figures
 * for free but only ever arrive after the spending.
 *
 * These tests pin the two things a client would otherwise have to assemble for
 * itself, which is what made the endpoint worth adding:
 *
 *   - `is_available`, the decision, rather than a raw number it has to threshold
 *   - `unit` and `scale`, so a figure is readable without a second lookup
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, incrementUserQuotaUsed } from "@/lib/db/users";
import { CREDIT_SCALE } from "@/lib/quota/credits";
import { GET } from "@/app/api/v1/credits/route";

interface CreditsBody {
  object: string;
  is_available: boolean;
  unit: string;
  scale: number;
  limit: number;
  used: number;
  remaining: number;
}

function request(key?: string): Request {
  return new Request("https://relay.test/v1/credits", {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
}

async function account(
  over: { quotaType?: "credits" | "tokens"; quotaLimit?: number; spend?: number } = {},
): Promise<string> {
  const user = await createUser({
    username: "payer-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: over.quotaType ?? "credits",
    quotaLimit: over.quotaLimit ?? 500_000,
  });
  if (over.spend) await incrementUserQuotaUsed(user.id, over.spend);
  const { plainKey } = await createApiKey({ userId: user.id, label: "k" });
  return plainKey;
}

async function read(key?: string): Promise<{ status: number; body: CreditsBody; headers: Headers }> {
  const res = await GET(request(key));
  return {
    status: res.status,
    body: (await res.json()) as CreditsBody,
    headers: res.headers,
  };
}

describe("GET /v1/credits", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("refuses an unauthenticated caller, in the OpenAI envelope", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    // The same shape every other /v1 failure uses — a client reading `error.type`
    // finds `authentication_error`, not `undefined`.
    expect(body.ok).toBeUndefined();
    expect(body.error.type).toBe("authentication_error");
  });

  it("reports the pool, with the unit and the scale attached", async () => {
    const key = await account({ quotaLimit: 500_000, spend: 12_345 });
    const { status, body } = await read(key);
    expect(status).toBe(200);
    expect(body).toEqual({
      object: "credit_balance",
      is_available: true,
      unit: "credits",
      scale: CREDIT_SCALE,
      limit: 500_000,
      used: 12_345,
      remaining: 487_655,
    });
  });

  it("answers the question the caller actually has", async () => {
    // `is_available` is the reason this endpoint exists: without it a client has
    // to threshold `remaining` itself, in a unit it has to know.
    expect((await read(await account({ quotaLimit: 1_000, spend: 1 }))).body.is_available).toBe(true);
    expect((await read(await account({ quotaLimit: 1_000, spend: 1_000 }))).body.is_available).toBe(false);
  });

  it("an exhausted pool reads as zero, never as a debt", async () => {
    const { body } = await read(await account({ quotaLimit: 1_000, spend: 1_500 }));
    expect(body.used).toBe(1_500);
    expect(body.remaining).toBe(0);
  });

  it("a pool that was never granted is distinguishable without a second field", async () => {
    // `limit === 0` is how "never granted" is stored, and a granted pool always
    // reports a positive limit. So the one number carries it, and there is no
    // boolean that could disagree with it.
    const { body } = await read(await account({ quotaLimit: 0 }));
    expect(body.limit).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.is_available).toBe(false);
  });

  it("says when the account is metered in tokens rather than credits", async () => {
    const { body } = await read(await account({ quotaType: "tokens", quotaLimit: 50_000 }));
    expect(body.unit).toBe("tokens");
    expect(body.scale).toBe(CREDIT_SCALE);
  });

  it("carries the same figures in the headers, for callers already in flight", async () => {
    const key = await account({ quotaLimit: 500_000, spend: 12_345 });
    const { headers } = await read(key);
    expect(headers.get("x-ratelimit-limit")).toBe("500000");
    expect(headers.get("x-ratelimit-remaining")).toBe("487655");
    expect(headers.get("x-ratelimit-unit")).toBe("credits");
  });

  it("reports the owner's pool, not the key's — every key of an account sees one number", async () => {
    // The pool belongs to the account. If this ever answered per-key, a user
    // with two keys would see two different balances for the same money.
    const user = await createUser({
      username: "two-keys-" + Math.random().toString(36).slice(2, 8),
      password: "x",
      quotaType: "credits",
      quotaLimit: 500_000,
    });
    await incrementUserQuotaUsed(user.id, 12_345);
    const a = await createApiKey({ userId: user.id, label: "a" });
    const b = await createApiKey({ userId: user.id, label: "b" });

    const first = await read(a.plainKey);
    const second = await read(b.plainKey);
    expect(first.body).toEqual(second.body);
  });
});

describe("the assistant points at the endpoint that exists", () => {
  it("names it, rather than telling the user there is no such call", async () => {
    // This bit twice in one session: the prompt said the record button was gone
    // after it was, and then said there was no balance endpoint one commit
    // before /v1/credits was added. Both read as confident and were both wrong,
    // and neither was caught by any test that looked at behaviour rather than
    // text. Cheap to pin: the claim is a path, and the path is checkable.
    const { USER_SYSTEM_PROMPT } = await import("@/lib/assistant/prompts");
    expect(USER_SYSTEM_PROMPT).toContain("/v1/credits");
  });
});

describe("the assistant's voice answer is the same read as the route's", () => {
  it("is a registered tool, and the prompt says to use it rather than recall ids", async () => {
    // A prompt that names a tool nobody registered is the third instance of
    // this exact bug, so it is worth pinning at the point where it would bite:
    // the tool definition, the dispatch, and the prompt all have to agree.
    const { toolDefinitions } = await import("@/lib/assistant/tools");
    const { USER_SYSTEM_PROMPT } = await import("@/lib/assistant/prompts");
    const names = toolDefinitions(false).map((t) => t.function.name);
    expect(names).toContain("list_voices");
    expect(USER_SYSTEM_PROMPT).toContain("list_voices");
    // And the two ways a shortened list becomes a confident wrong answer.
    expect(USER_SYSTEM_PROMPT).toContain("narrowedBy");
    expect(USER_SYSTEM_PROMPT).toContain("unavailable");
  });
});
