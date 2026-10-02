/**
 * src/lib/assistant/rate-limit.ts
 *
 * The assistant cannot spend the deployment's money — it runs on the caller's
 * own upstream key — but it is not free either. A turn holds an SSE connection
 * open for as long as the model takes, writes to SQLite, and can fan out into
 * several tool calls. Nothing bounded that before, so one account could park an
 * unbounded number of live streams on a box that is sized for a small gateway.
 *
 * This is a request-rate limit, deliberately not a concurrency limit. The
 * reason is where the cost actually is: a user with two tabs open is a
 * completely normal thing to do, and a concurrency cap would break them. A rate
 * cap only bounds the rate, which is what actually has to stay finite.
 *
 * Two caps, because per-user alone does not protect the machine: N accounts
 * each at the per-user ceiling is still N times the load.
 *
 * In memory, unlike the login throttle, which is in SQLite. That throttle
 * counts *failures* and has to survive a restart to be useful against an
 * attacker who is being patient. A rolling request-rate window losing its
 * counters on restart costs nothing, and keeping this off the database is the
 * point: it runs on the hot path, and a write per request would be a way of
 * creating the very problem it exists to prevent. Single process, same as the
 * rest of the deployment's state.
 */

/** Rolling window. */
export const ASSISTANT_WINDOW_SECONDS = 60;
/** Turns one account may start inside the window. */
export const ASSISTANT_MAX_TURNS_PER_USER = 30;
/** Turns every account together may start inside the window. */
export const ASSISTANT_MAX_TURNS_TOTAL = 120;

interface Window {
  count: number;
  resetAt: number;
}

const EMPTY: Window = { count: 0, resetAt: 0 };

const perUser = new Map<string, Window>();
let total: Window = EMPTY;

/** Above this many tracked accounts, expired ones are swept. */
const SWEEP_AT = 256;

export interface AssistantRateState {
  limited: boolean;
  retryAfterSeconds: number;
}

function live(w: Window, now: number): Window {
  return w.resetAt > now ? w : EMPTY;
}

function sweep(now: number): void {
  if (perUser.size <= SWEEP_AT) return;
  for (const [id, w] of perUser) {
    if (w.resetAt <= now) perUser.delete(id);
  }
}

/**
 * Count one turn against the caller's budget and say whether it may proceed.
 *
 * Counting and deciding happen in the same call on purpose. A check-then-record
 * pair would let a burst of concurrent requests all read the same count, all
 * pass, and all be admitted — which is precisely the shape of traffic this is
 * meant to stop.
 *
 * A refused turn does not extend the window: hammering a closed budget should
 * not push the unlock time further away.
 */
export function consumeAssistantTurn(userId: string): AssistantRateState {
  const now = Date.now();
  const mine = live(perUser.get(userId) ?? EMPTY, now);
  const all = live(total, now);

  if (mine.count >= ASSISTANT_MAX_TURNS_PER_USER || all.count >= ASSISTANT_MAX_TURNS_TOTAL) {
    const unlockAt = Math.max(
      mine.count >= ASSISTANT_MAX_TURNS_PER_USER ? mine.resetAt : 0,
      all.count >= ASSISTANT_MAX_TURNS_TOTAL ? all.resetAt : 0,
    );
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - now) / 1000)),
    };
  }

  perUser.set(userId, { count: mine.count + 1, resetAt: mine.resetAt || now + ASSISTANT_WINDOW_SECONDS * 1000 });
  total = { count: all.count + 1, resetAt: all.resetAt || now + ASSISTANT_WINDOW_SECONDS * 1000 };
  sweep(now);
  return { limited: false, retryAfterSeconds: 0 };
}

/** Test-only: drop all counters. Module state outlives `__resetDbForTest`. */
export function __resetAssistantRateLimitForTest(): void {
  perUser.clear();
  total = EMPTY;
}
