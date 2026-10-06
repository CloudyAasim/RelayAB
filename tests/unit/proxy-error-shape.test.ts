/**
 * tests/unit/proxy-error-shape.test.ts
 *
 * A client that knows the OpenAI error contract dispatches on `error.type`. This
 * deployment's body had only `code` and `message`, so such a client read
 * `undefined` for every failure it was handed — including the one that matters
 * most, an exhausted pool.
 *
 * The reason it stayed that way is shape, not oversight: the same literal
 * `{ ok: false, error: { code, message } }` was hand-built in a dozen route files,
 * so there was no single definition to add a field to. `src/lib/proxy/errors.ts`
 * is that definition now, and these tests are what stops the dozen copies from
 * growing back.
 *
 * They invoke the real route handlers with a deliberately broken request rather
 * than scanning their source for a pattern. A source scan would have to guess
 * whether a match sits in code or in a comment, and this codebase has been bitten
 * by that distinction enough to avoid it on purpose.
 */
import { describe, it, expect } from "vitest";

import { openAiErrorType, proxyErrorBody, quotaHeaders } from "@/lib/proxy/errors";
import { reasonToHttp } from "@/lib/auth/apikey";
import type { User } from "@/lib/db/types";

/** The OpenAI-facing surface. The Anthropic routes are deliberately excluded. */
const OPENAI_ROUTES: Record<string, () => Promise<Response>> = {
  "v1/chat/completions": async () => {
    const mod = await import("@/app/api/v1/chat/completions/route");
    return mod.POST(json("{"));
  },
  "v1/responses": async () => {
    const mod = await import("@/app/api/v1/responses/route");
    return mod.POST(json("{"));
  },
  "v1/chat/completions/responses": async () => {
    const mod = await import("@/app/v1/chat/completions/responses/route");
    return mod.POST(json("{"));
  },
  "v1/models": async () => {
    const mod = await import("@/app/api/v1/models/route");
    return mod.GET(new Request("https://relay.test/v1/models"));
  },
  "v1/images/generations": async () => {
    const mod = await import("@/app/api/v1/images/generations/route");
    return mod.POST(json("{"));
  },
  "v1/images/edits": async () => {
    const mod = await import("@/app/api/v1/images/edits/route");
    return mod.POST(json("{}"));
  },
  "v1/audio/speech": async () => {
    const mod = await import("@/app/api/v1/audio/speech/route");
    return mod.POST(json("{"));
  },
  "v1/audio/transcriptions": async () => {
    const mod = await import("@/app/api/v1/audio/transcriptions/route");
    return mod.POST(json("{}"));
  },
  "v1/audio/music": async () => {
    const mod = await import("@/app/api/v1/audio/music/route");
    return mod.POST(json("{"));
  },
  "v1/videos/generations": async () => {
    const mod = await import("@/app/api/v1/videos/generations/route");
    return mod.POST(json("{"));
  },
};

function json(body: string): Request {
  return new Request("https://relay.test/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const user = (over: Partial<User> = {}): User =>
  ({ quotaType: "credits", quotaLimit: 500_000, quotaUsed: 12_345, ...over }) as User;

describe("the error type is derived, not declared per code", () => {
  it("follows the status, so a table cannot drift out of sync with it", () => {
    expect(openAiErrorType(400, "anything")).toBe("invalid_request_error");
    expect(openAiErrorType(401, "anything")).toBe("authentication_error");
    expect(openAiErrorType(403, "anything")).toBe("permission_error");
    expect(openAiErrorType(404, "anything")).toBe("not_found_error");
    expect(openAiErrorType(429, "anything")).toBe("rate_limit_error");
    expect(openAiErrorType(502, "anything")).toBe("server_error");
  });

  it("except for an exhausted pool, which must not read as rate limiting", () => {
    // The whole point of the exception. A client that backs off and retries a 429
    // would retry a 429 forever against a pool that is not coming back.
    expect(openAiErrorType(429, "quota_exceeded_credits")).toBe("insufficient_quota");
    expect(openAiErrorType(429, "quota_exceeded_tokens")).toBe("insufficient_quota");
  });

  it("an exhausted pool is a 429, not a 403", () => {
    // 403 reads as "you are not allowed to", which is a different problem with a
    // different remedy — and a client given one will never try to top up.
    expect(reasonToHttp("quota_exceeded_credits").status).toBe(429);
    expect(reasonToHttp("quota_exceeded_tokens").status).toBe(429);
  });

  it("the body is OpenAI's, and the code is still ours", () => {
    const body = proxyErrorBody(429, "quota_exceeded_credits", "积分 balance exhausted");
    expect(body).toEqual({
      error: {
        message: "积分 balance exhausted",
        type: "insufficient_quota",
        code: "quota_exceeded_credits",
      },
    });
    // A client branching on the old code keeps working: `type` was added, and
    // nothing that existed before was renamed.
    expect(body.error.code).toBe("quota_exceeded_credits");
  });
});

describe("the remaining balance travels in headers", () => {
  it("reports the pool, floored at zero", () => {
    expect(quotaHeaders(user())).toEqual({
      "x-ratelimit-limit": "500000",
      "x-ratelimit-remaining": "487655",
      "x-ratelimit-unit": "credits",
    });
    // An overspent pool reads as zero, never as a negative balance: this is a
    // remaining-amount header, not a debt statement.
    expect(quotaHeaders(user({ quotaUsed: 999_999 }))["x-ratelimit-remaining"]).toBe("0");
  });

  it("says which unit the numbers are in", () => {
    // `quotaType` can be tokens, so a bare number would be unreadable.
    expect(quotaHeaders(user({ quotaType: "tokens" }))["x-ratelimit-unit"]).toBe("tokens");
  });

  it("a pool that was never granted needs no extra flag to be distinguishable", () => {
    // `limit === 0` is how "nothing was granted" reads, and a granted pool always
    // reports a positive limit — so the limit alone carries it, and there is no
    // second field that can contradict the first.
    const never = quotaHeaders(user({ quotaLimit: 0, quotaUsed: 0 }));
    expect(never["x-ratelimit-limit"]).toBe("0");
    expect(never["x-ratelimit-remaining"]).toBe("0");
    expect(quotaHeaders(user())["x-ratelimit-limit"]).not.toBe("0");
  });
});

describe("every OpenAI route answers in that shape", () => {
  for (const [name, call] of Object.entries(OPENAI_ROUTES)) {
    it(`${name} returns a dispatchable error`, async () => {
      const res = await call();
      expect(res.status).toBeGreaterThanOrEqual(400);

      const body = (await res.json()) as { error?: Record<string, unknown>; ok?: boolean };
      // The old envelope. If this is present the route still hand-builds its
      // failures, which is the condition this whole file exists to prevent.
      expect(body.ok, `${name} still emits the old {ok:false} envelope`).toBeUndefined();
      expect(body.error, `${name} has no error object`).toBeTruthy();
      expect(
        typeof body.error!.type,
        `${name} has no error.type — an OpenAI client cannot dispatch on this`,
      ).toBe("string");
      expect((body.error!.type as string).length).toBeGreaterThan(0);
      expect(typeof body.error!.code).toBe("string");
      expect(typeof body.error!.message).toBe("string");
    });
  }
});

describe("the shared media failure helper is on the OpenAI surface too", () => {
  it("speaks the OpenAI envelope", async () => {
    // Asserted directly rather than through a route, and deliberately so: the
    // route tests above only reach their *own* `proxyError` calls, because a
    // malformed request dies before any media work starts. `mediaErrorResponse`
    // is what the later, reachable failures go through — a missing `input`, a
    // missing prompt, a refusal from the engine — so testing it only by proxy
    // would leave the one helper that most of the media surface depends on
    // unpinned. That gap was found the hard way: it shipped once already.
    const { mediaErrorResponse } = await import("@/lib/media/handler");
    const res = mediaErrorResponse({
      status: 400,
      code: "invalid_request",
      message: "input is required",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: Record<string, unknown>; ok?: boolean };
    expect(body.ok).toBeUndefined();
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.code).toBe("invalid_request");
  });
});

describe("the Anthropic surface keeps its own shape", () => {
  it("is not silently unified with the OpenAI one", async () => {
    // Anthropic clients dispatch on `{"type":"error","error":{"type":…}}`, which
    // is a different envelope. Routing it through the OpenAI builder would be a
    // regression dressed as a cleanup, so this pins the difference.
    const mod = await import("@/lib/proxy/anthropic-route");
    const res = await mod.handleAnthropicMessages(
      new Request("https://relay.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBeTruthy();
    // Whatever envelope it uses, it must not be the OpenAI-only `type` field at
    // the top level of `error` — that would mean the two got merged.
    expect((body.error as Record<string, unknown>).type ?? null).toBeNull();
  });
});
