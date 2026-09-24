/**
 * src/lib/db/__mocks__/memory-redis.ts
 *
 * Minimal in-memory implementation of the @upstash/redis surface that
 * RelayAB actually uses. Designed for unit tests where spinning up a
 * real Redis would be overkill.
 *
 * Supported commands:
 *   - get / set / del / exists / expire
 *   - hget / hset / hgetall / hdel / hincrby
 *   - sadd / srem / smembers / sismember
 *   - lpush / lrange / ltrim / llen / lrem
 *   - incr / decrby
 *   - scan (cursor-based, simplified)
 *
 * Limitations vs. real Redis:
 *   - No TTL expiry on a timer (expire only sets an `expireAt` that
 *     `get`/`exists` checks on access). Sufficient for tests.
 *   - No pub/sub. No scripts/EVAL.
 *   - Single-process only.
 *
 * Resetting between tests: call `createMemoryRedis()` again.
 */

export type RedisValue = string | number;

export interface RedisLike {
  // strings
  get<T = unknown>(key: string): Promise<T | null>;
  set(
    key: string,
    value: RedisValue,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;

  // hash
  hget<T = unknown>(key: string, field: string): Promise<T | null>;
  hset(key: string, values: Record<string, RedisValue>): Promise<number>;
  hgetall<T = Record<string, string>>(key: string): Promise<T | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hincrby(key: string, field: string, increment: number): Promise<number>;

  // set
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<number>;

  // list
  lpush(key: string, ...values: RedisValue[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<"OK" | null>;
  llen(key: string): Promise<number>;
  lrem(key: string, count: number, value: RedisValue): Promise<number>;

  // numeric
  incr(key: string): Promise<number>;
  decrby(key: string, decrement: number): Promise<number>;

  // scan
  scan(
    cursor: number,
    opts: { match?: string; count?: number },
  ): Promise<[string, string[]]>;

  // transactions
  multi(): Pipeline;
}

export interface Pipeline {
  get(key: string): Pipeline;
  set(key: string, value: RedisValue, opts?: { ex?: number }): Pipeline;
  del(...keys: string[]): Pipeline;
  hset(key: string, values: Record<string, RedisValue>): Pipeline;
  hgetall(key: string): Pipeline;
  hdel(key: string, ...fields: string[]): Pipeline;
  hincrby(key: string, field: string, increment: number): Pipeline;
  sadd(key: string, ...members: string[]): Pipeline;
  srem(key: string, ...members: string[]): Pipeline;
  smembers(key: string): Pipeline;
  lpush(key: string, ...values: RedisValue[]): Pipeline;
  ltrim(key: string, start: number, stop: number): Pipeline;
  expire(key: string, seconds: number): Pipeline;
  exec(): Promise<Array<unknown>>;
}

// ---------------------------------------------------------------------------
// Internal store shape
// ---------------------------------------------------------------------------

/**
 * Mirror `@upstash/redis`, which deserializes hash values on read: a stored
 * `"1"` comes back as the number `1`, and a stored JSON blob as an object.
 *
 * Reading raw strings used to make the mock *more* forgiving than production,
 * which hid a real bug: `raw.flag === "1"` compares false once the client hands
 * back the number `1`, so every provider flag read back as "off".
 */
function deserializeHashValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

type Entry =
  | { kind: "string"; value: RedisValue; expireAt?: number }
  | { kind: "hash"; fields: Map<string, RedisValue>; expireAt?: number }
  | { kind: "set"; members: Set<string>; expireAt?: number }
  | { kind: "list"; values: RedisValue[]; expireAt?: number };

interface Store {
  data: Map<string, Entry>;
}

function isExpired(entry: Entry, now: number): boolean {
  return entry.expireAt !== undefined && entry.expireAt <= now;
}

function ensureKind<K extends Entry["kind"]>(
  store: Store,
  key: string,
  kind: K,
): Extract<Entry, { kind: K }> {
  let entry = store.data.get(key);
  const now = Date.now();
  if (entry && isExpired(entry, now)) {
    store.data.delete(key);
    entry = undefined;
  }
  if (!entry) {
    // initialize empty entry
    if (kind === "string") entry = { kind: "string", value: "" };
    else if (kind === "hash") entry = { kind: "hash", fields: new Map() };
    else if (kind === "set") entry = { kind: "set", members: new Set() };
    else entry = { kind: "list", values: [] };
    store.data.set(key, entry);
  } else if (entry.kind !== kind) {
    throw new Error(
      `WRONGTYPE Operation against a key holding the wrong kind of value (key=${key})`,
    );
  }
  return entry as Extract<Entry, { kind: K }>;
}

function applyExpire(entry: Entry, ex?: number): void {
  if (ex !== undefined) entry.expireAt = Date.now() + ex * 1000;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryRedis(): RedisLike {
  const store: Store = { data: new Map() };

  function checkExpired(key: string): void {
    const entry = store.data.get(key);
    if (entry && isExpired(entry, Date.now())) store.data.delete(key);
  }

  const r: RedisLike = {
    async get(key) {
      checkExpired(key);
      const entry = store.data.get(key);
      if (!entry || entry.kind !== "string") return null;
      return ((entry.value === "" ? null : entry.value) as unknown) as never;
    },

    async set(key, value, opts) {
      // SETNX semantics: only set when the key does not exist.
      if (opts?.nx) {
        if (store.data.has(key)) return null;
      }
      const entry = ensureKind(store, key, "string");
      entry.value = value;
      applyExpire(entry, opts?.ex);
      return "OK" as const;
    },

    async del(...keys) {
      let count = 0;
      for (const k of keys) {
        if (store.data.delete(k)) count++;
      }
      return count;
    },

    async exists(...keys) {
      const now = Date.now();
      let count = 0;
      for (const k of keys) {
        const entry = store.data.get(k);
        if (entry && !isExpired(entry, now)) count++;
      }
      return count;
    },

    async expire(key, seconds) {
      const entry = store.data.get(key);
      if (!entry) return 0;
      entry.expireAt = Date.now() + seconds * 1000;
      return 1;
    },

    async hget(key, field) {
      checkExpired(key);
      const entry = ensureKind(store, key, "hash");
      const v = entry.fields.get(field);
      return ((v ?? null) as unknown) as never;
    },

    async hset(key, values) {
      const entry = ensureKind(store, key, "hash");
      let added = 0;
      for (const [field, v] of Object.entries(values)) {
        if (!entry.fields.has(field)) added++;
        entry.fields.set(field, v);
      }
      return added;
    },

    async hgetall(key) {
      checkExpired(key);
      const entry = store.data.get(key);
      if (!entry || entry.kind !== "hash") return null;
      const out: Record<string, unknown> = {};
      for (const [f, v] of entry.fields) out[f] = deserializeHashValue(v);
      return (out as unknown) as never;
    },

    async hdel(key, ...fields) {
      checkExpired(key);
      const entry = store.data.get(key);
      if (!entry || entry.kind !== "hash") return 0;
      let count = 0;
      for (const f of fields) {
        if (entry.fields.delete(f)) count++;
      }
      return count;
    },

    async hincrby(key, field, increment) {
      const entry = ensureKind(store, key, "hash");
      const current = Number(entry.fields.get(field) ?? "0");
      const next = current + increment;
      entry.fields.set(field, String(next));
      return next;
    },

    async sadd(key, ...members) {
      const entry = ensureKind(store, key, "set");
      let added = 0;
      for (const m of members) {
        if (!entry.members.has(m)) added++;
        entry.members.add(m);
      }
      return added;
    },

    async srem(key, ...members) {
      checkExpired(key);
      const entry = store.data.get(key);
      if (!entry || entry.kind !== "set") return 0;
      let removed = 0;
      for (const m of members) {
        if (entry.members.delete(m)) removed++;
      }
      return removed;
    },

    async smembers(key) {
      checkExpired(key);
      const entry = ensureKind(store, key, "set");
      return Array.from(entry.members);
    },

    async sismember(key, member) {
      checkExpired(key);
      const entry = ensureKind(store, key, "set");
      return entry.members.has(member) ? 1 : 0;
    },

    async lpush(key, ...values) {
      const entry = ensureKind(store, key, "list");
      for (const v of values) entry.values.unshift(v);
      return entry.values.length;
    },

    async lrange(key, start, stop) {
      checkExpired(key);
      const entry = ensureKind(store, key, "list");
      const len = entry.values.length;
      // Redis stop is inclusive
      const realStop = stop < 0 ? len + stop : stop;
      const realStart = start < 0 ? len + start : start;
      return entry.values.slice(realStart, realStop + 1).map(String);
    },

    async ltrim(key, start, stop) {
      checkExpired(key);
      const entry = ensureKind(store, key, "list");
      const len = entry.values.length;
      const realStop = stop < 0 ? len + stop : stop;
      const realStart = start < 0 ? len + start : start;
      entry.values = entry.values.slice(realStart, realStop + 1);
      return "OK" as const;
    },

    async llen(key) {
      checkExpired(key);
      const entry = ensureKind(store, key, "list");
      return entry.values.length;
    },

    async lrem(key, count, value) {
      checkExpired(key);
      const entry = ensureKind(store, key, "list");
      const cmp = String(value);
      let removed = 0;
      if (count >= 0) {
        for (let i = 0; i < entry.values.length && removed < (count || Infinity); ) {
          if (String(entry.values[i]) === cmp) {
            entry.values.splice(i, 1);
            removed++;
          } else {
            i++;
          }
        }
      } else {
        // count < 0 means from tail
        for (let i = entry.values.length - 1; i >= 0 && removed < -count; i--) {
          if (String(entry.values[i]) === cmp) {
            entry.values.splice(i, 1);
            removed++;
          }
        }
      }
      return removed;
    },

    async incr(key) {
      const entry = ensureKind(store, key, "string");
      const current = Number(entry.value ?? "0");
      const next = current + 1;
      entry.value = String(next);
      return next;
    },

    async decrby(key, decrement) {
      const entry = ensureKind(store, key, "string");
      const current = Number(entry.value ?? "0");
      const next = current - decrement;
      entry.value = String(next);
      return next;
    },

    async scan(_cursor, opts) {
      const match = opts.match ?? "*";
      const regex = matchToRegex(match);
      const allKeys = Array.from(store.data.keys());
      const filtered = allKeys.filter((k) => regex.test(k));
      // For simplicity, return all matches in one go; cursor is always 0 after.
      return ["0", filtered];
    },

    multi() {
      const self = r;
      const queue: Array<() => Promise<unknown>> = [];

      const pipeline: Pipeline = {
        get(key) { queue.push(() => self.get(key)); return pipeline; },
        set(key, value, opts) { queue.push(() => self.set(key, value, opts)); return pipeline; },
        del(...keys) { queue.push(() => self.del(...keys)); return pipeline; },
        hset(key, values) { queue.push(() => self.hset(key, values)); return pipeline; },
        hgetall(key) { queue.push(() => self.hgetall(key)); return pipeline; },
        hdel(key, ...fields) { queue.push(() => self.hdel(key, ...fields)); return pipeline; },
        hincrby(key, field, increment) { queue.push(() => self.hincrby(key, field, increment)); return pipeline; },
        sadd(key, ...members) { queue.push(() => self.sadd(key, ...members)); return pipeline; },
        srem(key, ...members) { queue.push(() => self.srem(key, ...members)); return pipeline; },
        smembers(key) { queue.push(() => self.smembers(key)); return pipeline; },
        lpush(key, ...values) { queue.push(() => self.lpush(key, ...values)); return pipeline; },
        ltrim(key, start, stop) { queue.push(() => self.ltrim(key, start, stop)); return pipeline; },
        expire(key, seconds) { queue.push(() => self.expire(key, seconds)); return pipeline; },
        async exec() {
          return Promise.all(queue.map((fn) => fn()));
        },
      };
      return pipeline;
    },
  };

  return r;
}

// ---------------------------------------------------------------------------
// Match helpers
// ---------------------------------------------------------------------------

function matchToRegex(pattern: string): RegExp {
  // Convert Redis glob to regex.
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (
      c === "[" || c === "]" || c === "\\" || c === "^" || c === "$" ||
      c === "." || c === "+" || c === "(" || c === ")" || c === "{" ||
      c === "}" || c === "|"
    ) {
      re += "\\" + c;
    } else re += c;
  }
  re += "$";
  return new RegExp(re);
}
