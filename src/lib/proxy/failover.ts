/**
 * src/lib/proxy/failover.ts
 *
 * When one upstream cannot serve a request, try the next one.
 *
 * ## The problem this fixes
 *
 * The gateway used to pick `providers[0]` and use it, every time. That is a
 * single point of failure with no way out: one vendor having a bad minute, or
 * a key that expired, or a rate limit it never mentions — and **every**
 * request to that model fails, for every client, with no alternative.
 *
 * ## What counts as worth retrying
 *
 * The distinction that matters is between "this provider could not do it" and
 * "this request is not something any provider can do".
 *
 *   worth retrying:  a network error, a 5xx, a 429, an upstream key that was
 *                    rejected (401/403) — all of these say something about the
 *                    provider, and the next one may well succeed.
 *   not worth it:   a 400 or a 404 — the request itself is the problem, and
 *                    another provider would only produce the same answer,
 *                    one round trip later.
 *
 * ## No double billing
 *
 * Usage is settled **after** a successful response (`settleUsage`). A failed
 * attempt never reaches it, so a request that fails over is charged exactly
 * once — for the provider that served it. That is why failover is safe here
 * and would not be safe in a design that pre-charged.
 *
 * ## No switching mid-stream
 *
 * A stream that has already started sending bytes to the client cannot be
 * taken back. Failover therefore only ever happens **before** the response
 * begins: the attempt functions return a failure, and only a failure moves on.
 */
import {
  isProviderOpen,
  recordProviderFailure,
  recordProviderSuccess,
} from "./selection";
import type { Provider } from "../db/types";

/** What an attempt has to be able to say about itself. */
export interface FailoverOutcome {
  ok: boolean;
  /** Whether another provider might do better. Absent means "no". */
  retryable?: boolean;
}

/**
 * Whether an upstream's answer is worth trying somewhere else.
 *
 * The line is between "this provider could not do it" and "this request is
 * not something any provider can do":
 *
 *   5xx          the provider is having a bad time
 *   429          it is rate-limiting us; the next one may not be
 *   408          it timed out on its own
 *   401 / 403    this provider's key is rejected, or its account is out of
 *                credit — a fact about the provider, not about the request
 *
 * and everything else — 400, 404, 422 and the rest — is about the request
 * itself, where another provider would only produce the same answer one
 * round trip later.
 */
export function upstreamFailureIsRetryable(status: number): boolean {
  if (status >= 500) return true;
  if (status === 429 || status === 408) return true;
  if (status === 401 || status === 403) return true;
  return false;
}

/**
 * Run an attempt against each provider in turn, until one works.
 *
 * `candidates` is expected to be in **failover order** — see
 * {@link orderCandidates}. The order is respected: the first candidate is
 * tried first, and the rest are the fallbacks.
 */
export async function runWithFailover<T extends FailoverOutcome>(args: {
  candidates: readonly Provider[];
  /** How many providers to try at most. */
  maxAttempts: number;
  /** The single-provider attempt. */
  attempt: (provider: Provider) => Promise<T>;
}): Promise<T | undefined> {
  const { candidates, maxAttempts, attempt } = args;
  if (candidates.length === 0) return undefined;

  // A provider whose circuit is open has been failing, and trying it first
  // costs the client a full connect-and-timeout on every request. It is moved
  // to the **end** rather than dropped: if everything else fails too, the
  // provider that is merely *sick* is still better than no answer at all.
  const closed = candidates.filter((p) => !isProviderOpen(p.id));
  const open = candidates.filter((p) => isProviderOpen(p.id));
  const ordered = [...closed, ...open];

  // Never more attempts than there are providers to attempt: with one
  // provider configured, "try again" means the same request to the same
  // place, which doubles the latency of every failure and buys nothing.
  const budget = Math.max(1, Math.min(Math.trunc(maxAttempts) || 1, ordered.length));

  let last: T | undefined;
  for (const provider of ordered.slice(0, budget)) {
    let result: T;
    try {
      result = await attempt(provider);
    } catch (err) {
      // An attempt that throws is a failed attempt, not a crashed gateway.
      recordProviderFailure(provider.id);
      last = {
        ok: false,
        retryable: true,
        error: { code: "upstream_error", message: String(err) },
      } as unknown as T;
      continue;
    }

    if (result.ok) {
      recordProviderSuccess(provider.id);
      return result;
    }

    recordProviderFailure(provider.id);
    last = result;

    // The request itself was the problem. Another provider would answer the
    // same way, so stop here and report what actually went wrong.
    if (!result.retryable) return result;
  }

  return last;
}
