/**
 * src/lib/auth/login-throttle.ts
 *
 * Best-effort brute-force throttle for the login endpoint.
 *
 * RelayAB is a single-admin, password-only surface, which makes `/api/auth/login`
 * the most valuable endpoint to grind. We keep a short rolling count of FAILED
 * attempts under two keys — one per client IP and one per username — and refuse
 * further attempts once either crosses its budget. A successful login clears
 * both counters.
 *
 * Design notes:
 * - Only failures count, so a busy-but-legitimate user is never throttled by
 *   their own successful logins.
 * - Fails open: if Redis is unreachable we allow the attempt. Locking every
 *   user out of their own relay because the database blipped is worse than the
 *   brute-force window we would otherwise close.
 * - `x-forwarded-for` is only trusted as far as the platform proxy in front of
 *   us. A spoofed value can evade the per-IP counter but never the per-username
 *   one, which is the limit that actually protects an account.
 */
import { getRedis, KEY_PREFIX } from "../db/redis";

/** Rolling window for failed attempts. */
export const LOGIN_THROTTLE_WINDOW_SECONDS = 5 * 60;
/** Failed attempts allowed per username inside the window. */
export const LOGIN_THROTTLE_MAX_PER_USER = 8;
/** Failed attempts allowed per client IP inside the window. */
export const LOGIN_THROTTLE_MAX_PER_IP = 30;

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function throttleKeys(headers: Headers, username: string): [ipKey: string, userKey: string] {
  const ip = clientIp(headers);
  const user = username.trim().toLowerCase();
  return [`${KEY_PREFIX}login:ip:${ip}`, `${KEY_PREFIX}login:user:${user}`];
}

async function readCount(key: string): Promise<number> {
  const raw = await getRedis().get<number | string>(key);
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function bump(key: string): Promise<void> {
  const redis = getRedis();
  const next = await redis.incr(key);
  // The first failure starts the rolling window. A process crash between the
  // two calls can leave a counter without a TTL, which at worst over-throttles
  // until it is cleared; successful logins delete the key.
  if (next === 1) await redis.expire(key, LOGIN_THROTTLE_WINDOW_SECONDS);
}

export interface LoginThrottleState {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * True when either the IP or the username has exhausted its failure budget.
 */
export async function checkLoginThrottle(
  headers: Headers,
  username: string,
): Promise<LoginThrottleState> {
  try {
    const [ipKey, userKey] = throttleKeys(headers, username);
    const [ipCount, userCount] = await Promise.all([readCount(ipKey), readCount(userKey)]);
    if (ipCount >= LOGIN_THROTTLE_MAX_PER_IP || userCount >= LOGIN_THROTTLE_MAX_PER_USER) {
      return { limited: true, retryAfterSeconds: LOGIN_THROTTLE_WINDOW_SECONDS };
    }
    return { limited: false, retryAfterSeconds: 0 };
  } catch {
    return { limited: false, retryAfterSeconds: 0 };
  }
}

/** Count one failed credential check against both budgets. */
export async function recordLoginFailure(headers: Headers, username: string): Promise<void> {
  try {
    const [ipKey, userKey] = throttleKeys(headers, username);
    await Promise.all([bump(ipKey), bump(userKey)]);
  } catch {
    // Fail open — never let a throttle bookkeeping error break a login attempt.
  }
}

/** Clear both budgets after a successful login. */
export async function clearLoginFailures(headers: Headers, username: string): Promise<void> {
  try {
    const [ipKey, userKey] = throttleKeys(headers, username);
    await getRedis().del(ipKey, userKey);
  } catch {
    // Ignore.
  }
}
