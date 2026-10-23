/**
 * src/lib/proxy/selection.ts
 *
 * Which upstream serves a request — and what happens when that one fails.
 *
 * ## The two rules
 *
 * 1. **Priority decides the tier.** A lower `priority` number is served first.
 *    That is RelayAB's existing convention and it is kept: the number is read
 *    as "which slot in the queue", and the admin panel has always shown it
 *    that way. (New API reads it the other way round — larger number, served
 *    first — and that difference is deliberate, not an oversight. Changing the
 *    meaning of a number already in every operator's head is not a change
 *    worth making for the sake of matching someone else.)
 *
 * 2. **Weight splits a tier.** Within one tier, providers that carry a
 *    weight share the traffic in proportion to it.
 *
 * ## Why weight 0 means "standby"
 *
 * New API adds 10 to every weight, so no channel is ever excluded from the
 * draw — weight 0 still gets a share. This gateway does the opposite, and the
 * difference is the whole design:
 *
 * A weight of **0 means this provider is not drawn from proactively**. It
 * still serves traffic when the providers ahead of it fail (that is what
 * failover is for), but it is not handed a share of the healthy case.
 *
 * The reason is that a weighted draw is *random*, and a gateway that starts
 * picking a different upstream on every request — with no failure anywhere —
 * is a surprise. With weight 0 as the default, a deployment that has never
 * heard of weights behaves exactly as it did before this existed: the first
 * provider in its tier, every time. An administrator who *wants* a spread
 * says so by giving two providers the same weight, and from that moment the
 * split is proportional and visible in the panel.
 *
 * So the rule in one sentence: **a tier in which nobody carries a weight is
 * ordered by name (deterministic); a tier in which somebody does is split by
 * weight, and the weightless ones wait for a failure.**
 */

/** The shape this module needs. `Provider` satisfies it. */
export interface WeightedCandidate {
  /** Lower is served first. */
  priority: number;
  /** 0 = not drawn from proactively. Positive = share of the draw. */
  weight: number;
}

/**
 * Pick one candidate, in proportion to its weight.
 *
 * The weights are used as they are — no floor is added — so a weight of 0 is
 * genuinely a zero share. Callers decide which candidates enter the draw;
 * this function only distributes it.
 *
 * `rand` is injectable so the distribution can be tested without a source of
 * randomness the test does not control.
 */
export function weightedPick<T extends WeightedCandidate>(
  candidates: readonly T[],
  rand: () => number = Math.random,
): T {
  if (candidates.length === 0) {
    throw new Error("weightedPick needs at least one candidate");
  }
  const total = candidates.reduce((sum, c) => sum + Math.max(0, c.weight), 0);
  if (total <= 0) {
    // Every weight is 0: nothing to distribute. The first one wins, which is
    // the same answer the name order gives.
    return candidates[0];
  }
  let threshold = clampUnit(rand()) * total;
  for (const candidate of candidates) {
    threshold -= Math.max(0, candidate.weight);
    if (threshold <= 0) return candidate;
  }
  // Only reachable through floating-point drift at the very end of the range.
  return candidates[candidates.length - 1];
}

/**
 * The order in which providers should be tried.
 *
 * Tiers first (by ascending priority), and inside a tier either a weighted
 * order — when somebody in the tier carries a weight — or the name order,
 * which is what the database already returns and what the gateway has always
 * used.
 *
 * The returned list is the **failover order**: the first entry is who serves
 * the request, and each later entry is the next thing to try when the one
 * before it failed in a way worth retrying.
 */
export function orderCandidates<T extends WeightedCandidate & { name: string }>(
  candidates: readonly T[],
  rand: () => number = Math.random,
): T[] {
  const tiers = new Map<number, T[]>();
  for (const candidate of candidates) {
    const tier = tiers.get(candidate.priority);
    if (tier) tier.push(candidate);
    else tiers.set(candidate.priority, [candidate]);
  }

  const ordered: T[] = [];
  for (const priority of [...tiers.keys()].sort((a, b) => a - b)) {
    const tier = tiers.get(priority)!;
    ordered.push(...orderWithinTier(tier, rand));
  }
  return ordered;
}

/**
 * One tier, one order.
 *
 * A tier where somebody carries a weight is split by weight: the first entry
 * is drawn from the weighted pool, the second from what is left, and so on —
 * so the head of the list honours the weights and the tail is a sensible
 * fallback for whoever is left.
 *
 * A tier where nobody carries a weight keeps the name order it came in with.
 */
function orderWithinTier<T extends WeightedCandidate & { name: string }>(
  tier: readonly T[],
  rand: () => number,
): T[] {
  const pool = tier.filter((c) => c.weight > 0);
  // Nobody opted into the draw — keep the order the caller handed us.
  if (pool.length === 0) return [...tier];

  const standby = tier.filter((c) => c.weight <= 0);
  const drawn: T[] = [];
  const remaining = [...pool];
  while (remaining.length > 0) {
    const picked = weightedPick(remaining, rand);
    drawn.push(picked);
    remaining.splice(remaining.indexOf(picked), 1);
  }

  // Standbys go last within their tier: they are the ones a failure reaches,
  // not the ones a healthy request should meet.
  return [...drawn, ...standby];
}

/** Keep a random source inside [0, 1). */
function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value >= 1 ? 0.999999 : value;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * A per-provider circuit breaker, in memory.
 *
 * Failover on its own is not enough: a provider that is down is tried first on
 * every single request, and each attempt costs a full connect-and-timeout
 * before the request can move on. The breaker remembers that the provider is
 * failing and takes it out of the rotation for a while.
 *
 * **In memory, deliberately.** The state is a hint about the last few
 * seconds, not a fact worth persisting: a restart resets it, which is the
 * correct behaviour (the provider may well be healthy again), and it keeps
 * the database out of the request path. A single-container deployment has one
 * process, so the hint is seen by every request that matters.
 *
 * The reset on success is what stops a provider from being punished forever
 * for one bad minute.
 */

interface BreakerState {
  /** Consecutive failures. Reset to 0 by a success. */
  failures: number;
  /** Epoch ms until which the provider is skipped. 0 = closed. */
  openUntil: number;
}

/** Consecutive failures that open the circuit. */
export const BREAKER_FAILURE_THRESHOLD = 3;
/** How long the circuit stays open, in milliseconds. */
export const BREAKER_COOLDOWN_MS = 30_000;

const breakers = new Map<string, BreakerState>();

/** True when the provider is currently taken out of the rotation. */
export function isProviderOpen(providerId: string, now: number = Date.now()): boolean {
  const state = breakers.get(providerId);
  if (!state) return false;
  if (state.openUntil <= now) {
    // The cooldown is over. The entry stays until the next failure or success
    // rewrites it — dropping it here would lose the failure count, and a
    // provider that is still broken would be given a clean slate every time.
    return false;
  }
  return true;
}

/** Record a successful call: close the circuit and clear the count. */
export function recordProviderSuccess(providerId: string): void {
  breakers.delete(providerId);
}

/**
 * Record a failed call: count it, and open the circuit once there have been
 * too many in a row.
 */
export function recordProviderFailure(
  providerId: string,
  now: number = Date.now(),
): void {
  const state = breakers.get(providerId) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= BREAKER_FAILURE_THRESHOLD) {
    state.openUntil = now + BREAKER_COOLDOWN_MS;
  }
  breakers.set(providerId, state);
}

/** Test-only: forget every breaker. */
export function resetBreakers(): void {
  breakers.clear();
}
