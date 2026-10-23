/**
 * tests/unit/provider-routing.test.ts
 *
 * Which upstream serves a request, and what happens when that one fails.
 *
 * This is the part of the gateway that decides whether one vendor having a bad
 * minute takes down every request for a model. It used to be
 * `providers[0]`, always: one provider, one chance, no alternative.
 *
 * Three things are pinned here:
 *
 *  1. **The order.** Priority picks the tier; within a tier, weight splits the
 *     traffic; a provider with no weight is a standby that only serves when
 *     the ones ahead of it fail.
 *  2. **What is worth retrying.** A provider that could not serve the request
 *     is worth moving on from; a request that is itself wrong is not.
 *  3. **The breaker.** A provider that keeps failing is moved to the back, so
 *     the client does not pay a timeout on every request.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  orderCandidates,
  weightedPick,
  isProviderOpen,
  recordProviderFailure,
  recordProviderSuccess,
  resetBreakers,
  BREAKER_FAILURE_THRESHOLD,
} from "@/lib/proxy/selection";
import { runWithFailover, upstreamFailureIsRetryable } from "@/lib/proxy/failover";
import type { Provider } from "@/lib/db/types";

function provider(over: Partial<Provider> & { name: string }): Provider {
  return {
    id: over.name,
    kind: "openai",
    baseUrl: null,
    encryptedApiKey: "x",
    modelMapping: {},
    modelConfigs: {},
    enabled: true,
    priority: 1,
    weight: 0,
    headers: {},
    upstreamFormat: "responses",
    openaiEnabled: true,
    anthropicEnabled: false,
    anthropicBaseUrl: null,
    textSpecs: [],
    activeMode: null,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...over,
  } as Provider;
}

describe("the order providers are tried in", () => {
  it("serves the lower priority number first", () => {
    const order = orderCandidates([
      provider({ name: "b", priority: 5 }),
      provider({ name: "a", priority: 1 }),
      provider({ name: "c", priority: 3 }),
    ]);
    expect(order.map((p) => p.name)).toEqual(["a", "c", "b"]);
  });

  it("keeps the name order when nobody in the tier carries a weight", () => {
    // The important property: a deployment that has never heard of weights
    // behaves exactly as it did before weights existed. The first provider in
    // its tier, every time.
    const order = orderCandidates([
      provider({ name: "zulu", priority: 1 }),
      provider({ name: "alpha", priority: 1 }),
    ]);
    expect(order.map((p) => p.name)).toEqual(["zulu", "alpha"]);
  });

  it("splits the tier by weight when somebody in it carries one", () => {
    const candidates = [
      provider({ name: "heavy", priority: 1, weight: 9 }),
      provider({ name: "light", priority: 1, weight: 1 }),
    ];
    // With `rand` pinned to 0 the heavy one is drawn; with it pinned near 1
    // the light one is. The split is by weight, not by name.
    const heavyFirst = orderCandidates(candidates, () => 0).map((p) => p.name);
    const lightFirst = orderCandidates(candidates, () => 0.99).map((p) => p.name);
    expect(heavyFirst[0]).toBe("heavy");
    expect(lightFirst[0]).toBe("light");
  });

  it("puts a weightless provider behind the ones that carry a weight", () => {
    const order = orderCandidates([
      provider({ name: "standby", priority: 1, weight: 0 }),
      provider({ name: "main", priority: 1, weight: 5 }),
    ]);
    expect(order.map((p) => p.name)).toEqual(["main", "standby"]);
  });

  it("splits in proportion to the weights", () => {
    const candidates = [
      provider({ name: "a", weight: 3 }),
      provider({ name: "b", weight: 1 }),
    ];
    // 3/4 of the range lands on the first, 1/4 on the second.
    expect(weightedPick(candidates, () => 0.1).name).toBe("a");
    expect(weightedPick(candidates, () => 0.8).name).toBe("b");
  });

  it("gives a weightless provider no share at all", () => {
    const candidates = [
      provider({ name: "a", weight: 0 }),
      provider({ name: "b", weight: 0 }),
    ];
    // Nothing to distribute: the first one wins, which is the same answer
    // the name order gives.
    expect(weightedPick(candidates, () => 0.5).name).toBe("a");
  });
});

describe("what is worth retrying", () => {
  it("treats a provider's problem as worth moving on from", () => {
    for (const status of [500, 502, 503, 429, 408, 401, 403]) {
      expect(upstreamFailureIsRetryable(status), `status ${status}`).toBe(true);
    }
  });

  it("treats the request's own problem as not worth moving on from", () => {
    for (const status of [400, 404, 409, 422]) {
      expect(upstreamFailureIsRetryable(status), `status ${status}`).toBe(false);
    }
  });
});

describe("failover", () => {
  beforeEach(() => {
    resetBreakers();
  });

  it("serves the request from the first provider when it works", async () => {
    const tried: string[] = [];
    const result = await runWithFailover({
      candidates: [provider({ name: "a" }), provider({ name: "b" })],
      maxAttempts: 2,
      attempt: async (p) => {
        tried.push(p.name);
        return { ok: true, status: 200 };
      },
    });
    expect(result?.ok).toBe(true);
    expect(tried).toEqual(["a"]);
  });

  it("moves to the next provider when the first one fails in a way worth it", async () => {
    const tried: string[] = [];
    const result = await runWithFailover({
      candidates: [provider({ name: "a" }), provider({ name: "b" })],
      maxAttempts: 2,
      attempt: async (p) => {
        tried.push(p.name);
        return p.name === "a"
          ? { ok: false, status: 502, retryable: true }
          : { ok: true, status: 200 };
      },
    });
    expect(result?.ok).toBe(true);
    expect(tried).toEqual(["a", "b"]);
  });

  it("does not move on when the request itself was the problem", async () => {
    const tried: string[] = [];
    const result = await runWithFailover({
      candidates: [provider({ name: "a" }), provider({ name: "b" })],
      maxAttempts: 2,
      attempt: async (p) => {
        tried.push(p.name);
        return { ok: false, status: 502, retryable: false };
      },
    });
    expect(result?.ok).toBe(false);
    // One attempt. Asking the second provider about a request the first one
    // refused would only produce the same answer, one round trip later.
    expect(tried).toEqual(["a"]);
  });

  it("never tries more providers than there are", async () => {
    // With one provider configured, "try again" means the same request to the
    // same place — which doubles the latency of every failure and buys
    // nothing.
    const tried: string[] = [];
    await runWithFailover({
      candidates: [provider({ name: "only" })],
      maxAttempts: 5,
      attempt: async (p) => {
        tried.push(p.name);
        return { ok: false, status: 502, retryable: true };
      },
    });
    expect(tried).toEqual(["only"]);
  });

  it("reports the last failure when every provider fails", async () => {
    const result = await runWithFailover({
      candidates: [provider({ name: "a" }), provider({ name: "b" })],
      maxAttempts: 2,
      attempt: async (p) => ({
        ok: false,
        status: 502,
        retryable: true,
        error: { code: "upstream_error", message: `failed at ${p.name}` },
      }),
    });
    expect(result?.ok).toBe(false);
    expect(result?.error?.message).toBe("failed at b");
  });
});

describe("the breaker", () => {
  beforeEach(() => {
    resetBreakers();
  });

  it("opens after repeated failures and closes on a success", () => {
    const id = "p1";
    expect(isProviderOpen(id)).toBe(false);
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      recordProviderFailure(id);
    }
    expect(isProviderOpen(id)).toBe(true);
    recordProviderSuccess(id);
    expect(isProviderOpen(id)).toBe(false);
  });

  it("moves a failing provider behind the healthy ones", async () => {
    const sick = provider({ name: "sick" });
    const healthy = provider({ name: "healthy" });
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      recordProviderFailure(sick.id);
    }
    const tried: string[] = [];
    await runWithFailover({
      candidates: [sick, healthy],
      maxAttempts: 2,
      attempt: async (p) => {
        tried.push(p.name);
        return { ok: true, status: 200 };
      },
    });
    // The sick provider is not dropped — it would still serve if the healthy
    // one failed — but it is no longer tried first.
    expect(tried).toEqual(["healthy"]);
  });
});
