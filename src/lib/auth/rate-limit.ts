/**
 * src/lib/auth/rate-limit.ts
 *
 * How many requests one user may make per minute.
 *
 * ## Why this lives on the user, not on the key
 *
 * The gateway already made this call once, for money: **quota lives on the
 * user, not on the key**. A user is granted a pool, and every key they mint
 * draws from that one pool — otherwise minting three keys would triple the
 * budget, which is not what "give Alice 1000 credits" means to anyone.
 *
 * The same reasoning applies to a rate limit, and it is the one that matters
 * here: a limit on the key would be undone by the obvious move, which is to
 * mint another key. A limit on the user cannot be undone that way, and it
 * protects the thing that is actually scarce — the upstream provider's
 * quota — from one account taking all of it.
 *
 * New API does not have a per-token limit either; its model rate limits are
 * global per model, optionally per group. A global limit protects the
 * provider but does nothing about one customer crowding out the others, which
 * is the failure a shared relay actually sees. The per-user limit here is
 * that missing half.
 *
 * ## The window
 *
 * A fixed one-minute window, counted in the database. A token bucket would
 * smooth the edges of the window, but a fixed window is what an operator
 * means by "60 requests per minute", and the difference only shows up in the
 * second around the boundary.
 *
 * The count and the decision are made in **one transaction**, so two
 * simultaneous requests cannot both read "59 of 60 used" and both be let
 * through.
 */
import { getDb, run, withTransaction } from "../db/sqlite";

/** The window a count is kept for. */
export const USER_RATE_LIMIT_WINDOW_SECONDS = 60;

export interface RateLimitDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** How long to wait, when it may not. */
  retryAfterSeconds: number;
}

/** The row key for one user's counter. */
function rateKey(userId: string): string {
  return `rpm:user:${userId}`;
}

/**
 * Take one slot from a user's budget, and say whether it was available.
 *
 * A limit of 0 means "no limit", and is answered without touching the
 * database at all — an unlimited account should not pay for a row.
 */
export async function consumeUserRequestSlot(
  userId: string,
  limit: number,
): Promise<RateLimitDecision> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (!userId) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const key = rateKey(userId);
  const now = Date.now();

  try {
    return await withTransaction(async () => {
      const db = getDb();
      const row = db
        .prepare("SELECT count, expires_at FROM api_rate_limit WHERE key = ?")
        .get(key) as { count?: number; expires_at?: number } | undefined;

      const expired = !row || (row.expires_at ?? 0) * 1000 <= now;
      const count = expired ? 0 : Number(row.count ?? 0);
      const current = Number.isFinite(count) && count > 0 ? count : 0;

      if (current >= limit) {
        // Over the budget. The row is left as it is: the expiry already
        // decides when the window rolls over, and writing "limit + 1" would
        // only make the count drift away from what was actually served.
        const expiresAt = expired ? now + USER_RATE_LIMIT_WINDOW_SECONDS * 1000 : (row!.expires_at ?? 0) * 1000;
        const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
        return { allowed: false, retryAfterSeconds: retryAfter };
      }

      const expiresAt = now + USER_RATE_LIMIT_WINDOW_SECONDS * 1000;
      if (expired) {
        run(
          `INSERT INTO api_rate_limit (key, count, expires_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at`,
          [key, expiresAt],
        );
      } else {
        run("UPDATE api_rate_limit SET count = count + 1 WHERE key = ?", [key]);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    });
  } catch {
    // Fail open. A counter that cannot be read is a bookkeeping problem, and
    // refusing every request because the bookkeeping broke is a far worse
    // outcome than briefly losing the limit.
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
