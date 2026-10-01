/**
 * src/lib/db/redis-tcp.ts
 *
 * `RedisLike` adapter over a real Redis/Valkey server, spoken to with
 * `ioredis` over a normal TCP socket. This is the transport used for a
 * self-hosted deployment, where a local Valkey listens on 127.0.0.1.
 *
 * Why this file exists separately from `redis.ts`: `@upstash/redis` talks
 * HTTP and auto-deserialises JSON-looking values on read, while a TCP client
 * returns raw strings. Rather than let that difference leak into every call
 * site, this adapter reproduces the Upstash-shaped contract the rest of the
 * persistence layer already codes against:
 *
 *   - `hgetall` resolves to `null` for a missing key (ioredis returns `{}`)
 *   - every hash field is handed back as a `string` (see note below)
 *   - `scan` takes a numeric cursor like the interface declares
 *
 * On the last point, note the consequence for callers: reading a flag that was
 * written as `"1"` yields the string `"1"` here, whereas the REST client would
 * have handed back the number `1` (that is exactly the confusion behind the
 * `readStoredFlag` helper, and behind the v135 "disabled user always enabled"
 * bug). `readStoredFlag` normalises both, and the `hashTo*` readers already
 * branch on `typeof value === "object"` first, so both transports work without
 * a single call-site change.
 */
import IORedis, { type RedisOptions } from "ioredis";
import type { Pipeline, RedisLike, RedisValue } from "./__mocks__/memory-redis";

const TCP_REDIS_GLOBAL_KEY = "__relayabTcpRedis";

type RelayGlobal = typeof globalThis & {
  [TCP_REDIS_GLOBAL_KEY]?: IORedis;
};

/**
 * ioredis defaults that would hurt a long-running server.
 *
 * - `maxRetriesPerRequest: 3` makes a request fail fast during a restart
 *   window instead of hanging until the client's own timeout. Without it a
 *   request issued while the server is bouncing can hang for 20s+ per command,
 *   which on a streaming endpoint looks like a stalled connection.
 * - `retryStrategy` backs off and caps, so a Valkey restart cannot turn into a
 *   tight reconnect loop that starves the event loop.
 */
const DEFAULT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    return Math.min(times * 200, 5_000);
  },
};

function toArg(value: RedisValue): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * Reuse one connection across dev-server module reloads.
 *
 * `next dev` re-evaluates modules on every hot update. Without pinning the
 * instance on `globalThis` each reload would open another socket and leak the
 * previous one until Valkey hits `maxclients`.
 */
function getSharedClient(url: string): IORedis {
  const g = globalThis as RelayGlobal;
  const existing = g[TCP_REDIS_GLOBAL_KEY];
  if (existing && existing.status !== "end") return existing;

  const client = new IORedis(url, DEFAULT_OPTIONS);

  /**
   * Without a listener, an ioredis `error` event is an unhandled EventEmitter
   * event, which takes the whole process down. That is the wrong trade here:
   * a transient connection blip should surface as a failed request (and a
   * noisy log line), not as a killed server.
   */
  client.on("error", (err: Error) => {
    console.error(`[relayab] Redis connection error: ${err.message}`);
  });

  g[TCP_REDIS_GLOBAL_KEY] = client;
  return client;
}

/**
 * Wrap an ioredis client in the `RedisLike` surface.
 *
 * Exported separately from the factory so tests can drive it against a real
 * local server without going through env resolution.
 */
export function createTcpRedis(client: IORedis): RedisLike {
  return {
    // -- strings ----------------------------------------------------------
    get<T = unknown>(key: string) {
      return client.get(key) as Promise<T | null>;
    },
    async set(key, value, opts) {
      const v = toArg(value);
      // ioredis types `set` with positional tokens ("EX" <n> "NX") rather than
      // an options bag, so pick the overload that matches what is present.
      let res: "OK" | null;
      if (opts?.ex !== undefined && opts?.nx) {
        res = await client.set(key, v, "EX", opts.ex, "NX");
      } else if (opts?.ex !== undefined) {
        res = await client.set(key, v, "EX", opts.ex);
      } else if (opts?.nx) {
        res = await client.set(key, v, "NX");
      } else {
        res = await client.set(key, v);
      }
      // `SET ... NX` replies with null when the key already exists, which is
      // the contract callers rely on for the quota create-if-absent path.
      return res;
    },
    del(...keys: string[]) {
      return client.del(...keys);
    },
    exists(...keys: string[]) {
      return client.exists(...keys);
    },
    expire(key: string, seconds: number) {
      return client.expire(key, seconds);
    },

    // -- hash -------------------------------------------------------------
    hget<T = unknown>(key: string, field: string) {
      return client.hget(key, field) as Promise<T | null>;
    },
    hset(key: string, values: Record<string, RedisValue>) {
      const flat: string[] = [];
      for (const [field, value] of Object.entries(values)) {
        flat.push(field, toArg(value));
      }
      return client.hset(key, ...flat);
    },
    async hgetall<T = Record<string, string>>(key: string) {
      const raw = await client.hgetall(key);
      // ioredis answers `{}` for a key that does not exist. The interface
      // promises `null`, and `hgetallMany` uses that to tell "absent row" from
      // "present but empty row" — without the mapping a missing provider would
      // deserialise into an empty object and look like a row of defaults.
      if (!raw || Object.keys(raw).length === 0) return null;
      return raw as T;
    },
    hdel(key: string, ...fields: string[]) {
      return client.hdel(key, ...fields);
    },
    hincrby(key: string, field: string, increment: number) {
      return client.hincrby(key, field, increment);
    },

    // -- set --------------------------------------------------------------
    sadd(key: string, ...members: string[]) {
      return client.sadd(key, ...members);
    },
    srem(key: string, ...members: string[]) {
      return client.srem(key, ...members);
    },
    smembers(key: string) {
      return client.smembers(key);
    },
    async sismember(key: string, member: string) {
      return (await client.sismember(key, member)) ? 1 : 0;
    },

    // -- list -------------------------------------------------------------
    lpush(key: string, ...values: RedisValue[]) {
      return client.lpush(key, ...values.map(toArg));
    },
    lrange(key: string, start: number, stop: number) {
      return client.lrange(key, start, stop);
    },
    async ltrim(key: string, start: number, stop: number) {
      const res = await client.ltrim(key, start, stop);
      return res === "OK" ? ("OK" as const) : null;
    },
    llen(key: string) {
      return client.llen(key);
    },
    lrem(key: string, count: number, value: RedisValue) {
      return client.lrem(key, count, toArg(value));
    },

    // -- numeric ----------------------------------------------------------
    incr(key: string) {
      return client.incr(key);
    },
    decrby(key: string, decrement: number) {
      return client.decrby(key, decrement);
    },

    // -- scan -------------------------------------------------------------
    async scan(cursor: number, opts: { match?: string; count?: number }) {
      // ioredis's cursor is an opaque string; the interface narrows it to a
      // number because that is all the callers ever hold. `String()` is
      // lossless here because a Redis cursor is always a decimal integer.
      const c = String(cursor);
      const match = opts.match ?? "*";
      const count = opts.count ?? 10;
      // Positional tokens again: SCAN <cursor> [MATCH <p>] [COUNT <n>].
      const [next, keys] = await client.scan(
        c,
        "MATCH",
        match,
        "COUNT",
        count,
      );
      return [next, keys] as [string, string[]];
    },

    // -- transactions -----------------------------------------------------
    multi() {
      // ioredis pipelines are chainable and expose the same command names, so
      // the shape lines up; the cast keeps ioredis's own (much wider) return
      // types from leaking into the persistence layer.
      return client.multi() as unknown as Pipeline;
    },
  };
}

/**
 * Build a `RedisLike` from a `redis://` / `rediss://` connection string.
 */
export function createTcpRedisFromUrl(url: string): RedisLike {
  return createTcpRedis(getSharedClient(url));
}

/** Test-only: drop the shared connection so the next call reconnects. */
export function __resetTcpRedisForTest(): void {
  const g = globalThis as RelayGlobal;
  const client = g[TCP_REDIS_GLOBAL_KEY];
  if (client) {
    client.disconnect();
    delete g[TCP_REDIS_GLOBAL_KEY];
  }
}
