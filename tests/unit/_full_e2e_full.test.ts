/**
 * Full end-to-end smoke test for all session changes.
 * Run with: ./node_modules/.bin/vitest run tests/e2e/_full_e2e_full.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, __resetConfigForTest } from "@/lib/config";
import { computeHealth } from "@/lib/health";
import { __resetDbForTest, getDb, run } from "@/lib/db/sqlite";
import { listUsers, createUser } from "@/lib/db/users";
import { createApiKey, listAllApiKeys } from "@/lib/db/keys";
import { updateSettings } from "@/lib/db/settings";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Scratch directory for the tests that need a real file on disk.
 *
 * Deliberately inside the repo rather than os.tmpdir(): under Vitest's node
 * environment `tmpdir()` does not resolve to a usable path on every platform,
 * and a repo-local directory is also easier to reason about when debugging a
 * failed run. It sits under node_modules/ so it is ignored by git and by
 * Next.js's build trace.
 */
const SCRATCH_ROOT = join(process.cwd(), "node_modules", ".tmp-relayab-test");
const scratchDir = (prefix: string): string => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
};

const setEnv = (env: Record<string, string | undefined>): void => {
  for (const k of Object.keys(process.env)) {
    if (!(k in env)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetConfigForTest();
};

// The in-memory store lives for the whole file, so every test that writes has
// to start from an empty one. Without this, an earlier test's "alice" is still
// there and the next one fails on UsernameConflictError rather than on what it
// is actually trying to assert.
beforeEach(() => {
  __resetConfigForTest();
  __resetDbForTest();
  process.env.RELAY_DB_PATH = ":memory:";
  process.env.RELAY_AUTH = "ok-password-12345678";
});

describe("Test 1 · config.ts: schema accepts Deploy-Button flow", () => {
  it("RELAY_AUTH alone is enough; RELAY_PUBLIC_URL is optional", () => {
    setEnv({
      RELAY_AUTH: "deploy-button-only-12345678",
      RELAY_PUBLIC_URL: undefined,
      NODE_ENV: "production",
    });
    const cfg = loadConfig();
    expect(cfg.RELAY_AUTH).toBe("deploy-button-only-12345678");
    // Not set — the public URL is derived at render time instead.
    expect(cfg.RELAY_PUBLIC_URL).toBeUndefined();
    // The database needs no configuration; leaving the path unset is normal.
    expect(cfg.RELAY_DB_PATH).toBeUndefined();
  });
});

describe("Test 2 · config.ts: rejects missing RELAY_AUTH", () => {
  it("throws when RELAY_AUTH is missing", () => {
    setEnv({
      NODE_ENV: "production",
      RELAY_DB_PATH: ":memory:",
      RELAY_PUBLIC_URL: "https://relay.example.com",
    });
    expect(() => loadConfig()).toThrow(/RELAY_AUTH/);
  });
});

describe("Test 3 · config.ts: RELAY_DB_PATH is optional", () => {
  it("is honoured when set, and absent otherwise", () => {
    setEnv({
      RELAY_AUTH: "ok-password-12345678",
      RELAY_DB_PATH: "/var/lib/relayab/relayab.db",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
    });
    expect(loadConfig().RELAY_DB_PATH).toBe("/var/lib/relayab/relayab.db");

    setEnv({
      RELAY_AUTH: "ok-password-12345678",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
    });
    // Unset means "default next to the app" — not a misconfiguration.
    expect(loadConfig().RELAY_DB_PATH).toBeUndefined();
  });
});

describe("Test 5 /healthz logic", () => {
  // Exercises the REAL implementation from lib/health.ts. This block used to
  // carry its own copy of the rules, which meant a change to /healthz left the
  // test asserting stale behaviour.
  //
  // The store is a local SQLite file, so the only variable that can be missing
  // is RELAY_AUTH. The database itself needs no configuration — that is the
  // point of the migration away from Redis.

  it("production with RELAY_AUTH set is ok (1/1)", () => {
    const r = computeHealth({ NODE_ENV: "production", RELAY_AUTH: "x" });
    expect(r.status).toBe("ok");
    expect(r.storage).toBe("sqlite");
    expect(r.required).toBe(1);
    expect(r.configured).toBe(1);
    expect(r.missing).toBeUndefined();
  });

  it("production with nothing set is unconfigured", () => {
    const r = computeHealth({ NODE_ENV: "production" });
    expect(r.status).toBe("unconfigured");
    expect(r.required).toBe(1);
    expect(r.configured).toBe(0);
    expect(r.missing).toEqual(["RELAY_AUTH"]);
  });

  it("development behaves the same — SQLite is configured out of the box", () => {
    // There used to be an in-memory mock that only existed outside production,
    // so development reported "ok" with 1/1 while production demanded 3/3. With
    // a file-backed store there is nothing to differ on.
    const r = computeHealth({ NODE_ENV: "development", RELAY_AUTH: "x" });
    expect(r.status).toBe("ok");
    expect(r.storage).toBe("sqlite");
    expect(r.required).toBe(1);
  });

  it("an unset RELAY_DB_PATH is not a missing variable", () => {
    // The file path defaults to ./data/relayab.db; reporting its absence would
    // make a correctly configured deployment look broken.
    const r = computeHealth({ NODE_ENV: "production", RELAY_AUTH: "x" });
    expect(r.missing).toBeUndefined();
  });

  it("an explicit RELAY_DB_PATH is accepted and not reported", () => {
    const r = computeHealth({
      NODE_ENV: "production",
      RELAY_AUTH: "x",
      RELAY_DB_PATH: "/var/lib/relayab/relayab.db",
    });
    expect(r.status).toBe("ok");
    expect(r.missing).toBeUndefined();
  });

  it("an empty RELAY_AUTH counts as missing", () => {
    const r = computeHealth({ NODE_ENV: "production", RELAY_AUTH: "   " });
    expect(r.status).toBe("unconfigured");
    expect(r.missing).toEqual(["RELAY_AUTH"]);
  });
});
describe("Test 6 · sqlite.ts: storage needs no service configuration", () => {
  // The Redis version had an "actionable error when no database is configured"
  // test here, because an operator had to supply a host, port and password
  // (REDIS_URL or UPSTASH_REDIS_REST_URL) before anything worked. SQLite has no
  // such surface: one path is the whole configuration. The equivalent contract
  // is that the path is honoured, the schema is created on first open, and a
  // bad path fails loudly instead of silently using some other store.

  it("opens and initialises the schema from a bare path, with no credentials", () => {
    setEnv({
      RELAY_AUTH: "ok-password-12345678",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
    });
    const dir = scratchDir("relayab-db-");
    const file = join(dir, "nested", "relayab.db");
    process.env.RELAY_DB_PATH = file;
    __resetDbForTest();

    try {
      const db = getDb();
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["users", "api_keys", "providers"]));
      // The parent directory did not exist; it is created rather than failing
      // with an opaque ENOENT on the first query.
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      process.env.RELAY_DB_PATH = ":memory:";
      __resetDbForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unusable RELAY_DB_PATH instead of falling back silently", () => {
    const dir = scratchDir("relayab-blocked-");
    // A directory is not a database, so SQLite refuses it.
    process.env.RELAY_DB_PATH = dir;
    __resetDbForTest();

    try {
      expect(() => getDb()).toThrow(/unable to open database file/i);
    } finally {
      process.env.RELAY_DB_PATH = ":memory:";
      __resetDbForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Test 7 · users.ts listUsers reads users only", () => {
  // The Redis version had to SCAN the key space and filter out the
  // `by-username` alias keys and the `relay:meta:initialized` sentinel. SQLite
  // has one table per entity, so the equivalent risk is a list query that
  // picks up the meta/settings rows sharing the same file.
  it("returns only the users table's rows", async () => {
    __resetDbForTest();
    const alice = await createUser({ username: "alice", password: "longenoughpw" });
    const bob = await createUser({ username: "bob", password: "longenoughpw" });
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["initialized", "1"]);
    await updateSettings({ publicUrl: "https://relay.example.com" });

    const { users } = await listUsers({ limit: 100 });
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.username).sort()).toEqual(["alice", "bob"]);
    expect(users.map((u) => u.id).sort()).toEqual([alice.id, bob.id].sort());
  });
});

describe("Test 8 · keys.ts listAllApiKeys reads api_keys only", () => {
  // Same story as Test 7: the Redis version filtered `hash:` and `by-user:`
  // index keys out of a SCAN; here the equivalent is that the list query does
  // not pick up rows from the other tables in the same database.
  it("returns only the api_keys table's rows", async () => {
    __resetDbForTest();
    const owner = await createUser({ username: "owner", password: "longenoughpw" });
    const first = await createApiKey({ userId: owner.id, label: "k-001" });
    const second = await createApiKey({ userId: owner.id, label: "k-002" });
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["initialized", "1"]);
    await updateSettings({ publicUrl: "https://relay.example.com" });

    const all = await listAllApiKeys();
    expect(all).toHaveLength(2);
    expect(all.map((k) => k.id).sort()).toEqual([first.key.id, second.key.id].sort());
    expect(all.every((k) => k.userId === owner.id)).toBe(true);
  });
});

describe("Test 9 · 自托管部署配置自检", () => {
  it("nginx 关闭了响应缓冲并转发 X-Forwarded-*", () => {
    // The single highest-risk misconfiguration on a self-hosted box: nginx
    // buffering turns every streamed completion into "hang, then dump".
    const nginx = fs.readFileSync("./deploy/nginx.conf", "utf-8");
    expect(nginx).toContain("proxy_buffering off");
    expect(nginx).toContain("X-Accel-Buffering no");
    // public-url.ts derives the public address from these two headers.
    expect(nginx).toContain("X-Forwarded-Proto");
    expect(nginx).toContain("X-Forwarded-Host");
  });

  it("systemd 从仓库根启动（管理台要读仓库里的文件）", () => {
    const unit = fs.readFileSync("./deploy/relayab.service", "utf-8");
    expect(unit).toMatch(/^WorkingDirectory=/m);
    // Without a build id, /healthz cannot report which version is live.
    expect(unit).toContain("RELAY_BUILD_ID");
    expect(unit).toContain("NODE_ENV=production");
  });

  it("README 指向 deploy/ 且不再宣传 Vercel 一键部署", () => {
    const r = fs.readFileSync("./README.md", "utf-8");
    expect(r).toContain("deploy/README.md");
    expect(r).not.toContain("vercel.com/new/clone");
  });

  it("部署文件齐全", () => {
    for (const f of [
      "./deploy/README.md",
      "./deploy/dokku.md",
      "./deploy/relayab.service",
      "./deploy/nginx.conf",
      "./deploy/env.production.example",
    ]) {
      expect(fs.existsSync(f), `${f} must exist`).toBe(true);
    }
  });

  it("没有为已移除的数据库服务留下配置", () => {
    // SQLite replaced Redis/Valkey, so shipping a Valkey config template would
    // tell operators to install a service the app never talks to.
    expect(fs.existsSync("./deploy/valkey.conf.example")).toBe(false);
  });

  it("app.json 不再要求数据库连接串", () => {
    // The one value Dokku must not prompt for: SQLite needs no connection.
    const app = JSON.parse(fs.readFileSync("./app.json", "utf-8"));
    const env = app.env ?? {};
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined();
    // The master secret is still platform-generated.
    expect(env.RELAY_AUTH?.generator).toBe("secret");
    expect(env.NODE_ENV?.value).toBe("production");
  });
});

describe("Test 10 · LICENSE is MIT", () => {
  it("has standard MIT text", () => {
    const license = fs.readFileSync("./LICENSE", "utf-8");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(/Copyright \(c\) \d{4}/.test(license)).toBe(true);
    expect(license).toContain("Permission is hereby granted, free of charge");
  });
});

describe("Test 11 · .gitignore coverage", () => {
  it("has all critical patterns", () => {
    const gi = fs.readFileSync("./.gitignore", "utf-8");
    const required = [
      { pattern: ".env", desc: "plain .env" },
      { pattern: ".env.*", desc: ".env.*" },
      { pattern: "!.env.example", desc: "explicit unignore of .env.example" },
      { pattern: "node_modules/", desc: "node_modules/" },
      { pattern: ".next/", desc: ".next/" },
      { pattern: "*.pem", desc: "PEM keys" },
      { pattern: "*.tsbuildinfo", desc: "tsbuildinfo" },
      { pattern: "next-env.d.ts", desc: "next-env.d.ts" },
      { pattern: ".vercel", desc: ".vercel" },
      { pattern: "coverage/", desc: "coverage/" },
      { pattern: "playwright-report/", desc: "playwright-report/" },
    ];
    for (const { pattern, desc } of required) {
      const present = gi.split("\n").some((line) => {
        const t = line.trim();
        return t === pattern || t === pattern.replace(/\/$/, "");
      });
      expect(present, `${desc} (pattern: ${pattern})`).toBe(true);
    }
  });
});

describe("Test 12 · package.json sanity", () => {
  it("no prebuild, packageManager pinned, engines targets Node 24", () => {
    const p = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
    expect(p.scripts.prebuild).toBeUndefined();
    expect(p.packageManager).toBe("pnpm@10.28.0");

    // This used to assert `engines` was ABSENT, so Vercel could pick its own
    // Node version. The deployment target is now Dokku, whose buildpack reads
    // engines.node to choose the build/runtime Node — without it the build
    // silently lands on whatever the pinned buildpack defaults to. Pin it to
    // the major the test suite and smoke run are verified against.
    expect(p.engines).toBeDefined();
    expect(p.engines.node).toBe(">=24 <25");
  });

  it("has a Procfile for the Dokku scheduler", () => {
    // Dokku starts the app from a Procfile; without a `web` process type the
    // deploy succeeds but no container is ever started.
    const procfile = fs.readFileSync("./Procfile", "utf-8");
    expect(procfile).toMatch(/^web:\s*\S/m);
    // Must go through pnpm, not bare `next start` — the buildpack only puts
    // the toolchain selected by `packageManager` on PATH.
    expect(procfile).toContain("pnpm start");
  });
});

describe("Test 13 · README structure", () => {
  it("has all key sections", () => {
    const r = fs.readFileSync("./README.md", "utf-8");
    // A self-hosted deployment needs no database service, so the only required
    // variable is RELAY_AUTH; RELAY_DB_PATH is optional (it defaults next to
    // the app). RELAY_BUILD_ID is what makes "which build is live" answerable.
    expect(r).toContain("RELAY_AUTH");
    expect(r).toContain("RELAY_DB_PATH");
    expect(r).toContain("RELAY_BUILD_ID");
    expect(r).toContain("/healthz");
    expect(r).toContain("## 许可证");
    // The README must not still send people to install a database service.
    expect(r).not.toContain("REDIS_URL");
    expect(r).not.toContain("UPSTASH_REDIS_REST_URL");
    expect((r.match(/^## /gm) || []).length).toBeGreaterThanOrEqual(5);
  });

  it("中英 README 对同一套部署方式保持一致", () => {
    const zh = fs.readFileSync("./README.md", "utf-8");
    const en = fs.readFileSync("./README.en.md", "utf-8");
    for (const r of [zh, en]) {
      expect(r).toContain("deploy/README.md");
      // The deployment steps must not still tell readers to install a database
      // service the app no longer uses.
      expect(r).not.toContain("valkey-server");
      expect(r).not.toContain("redis://");
      expect(r).not.toContain("vercel.com/button");
      // SSE still depends on the proxy not buffering, so that one stays.
      expect(r).toContain("proxy_buffering off");
    }
  });
});

describe("Test 14 · Footer component (no RelayAB version)", () => {
  it("does not display project version", () => {
    const f = fs.readFileSync("./src/components/layouts/Footer.tsx", "utf-8");
    expect(/export\s+function\s+Footer/.test(f)).toBe(true);
    expect(f).toContain("NEXT_PUBLIC_REPOSITORY_URL");
    expect(f).toContain('href="/license"');
    // Footer must not display a version number in rendered JSX. We check this
    // by stripping TS comments (// and /* */) before searching.
    const stripped = f
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // No "vX.Y.Z" or "X.Y.Z" version-like pattern in JSX
    expect(/v?\d+\.\d+\.\d+/.test(stripped)).toBe(false);
    // No reference to cfg.version / pkg.version / version field in JSX
    expect(/\bversion\b/.test(stripped)).toBe(false);
  });
});

describe("Test 15 · license page (no version display)", () => {
  it("does not show 'RelayAB vX.Y.Z'", () => {
    const f = fs.readFileSync("./src/app/license/page.tsx", "utf-8");
    expect(/RelayAB\s+v?\d+\.\d+/.test(f)).toBe(false);
    expect(f).toContain("RUNTIME_DEPS");
    expect(f).toContain("DEV_DEPS");
  });
});

  it("health: revision is null when no build env is set", () => {
    const r = computeHealth({ NODE_ENV: "development", RELAY_AUTH: "x" });
    expect(r.revision).toBeNull();
  });

  it("health: revision is the first 7 chars of VERCEL_GIT_COMMIT_SHA", () => {
    const r = computeHealth({
      NODE_ENV: "development",
      RELAY_AUTH: "x",
      VERCEL_GIT_COMMIT_SHA: "abcdef1234567890fedcba0987654321aabbccdd",
    });
    expect(r.revision).toBe("abcdef1");
  });

  it("health: revision falls back to RELAY_BUILD_ID when VERCEL_GIT_COMMIT_SHA is missing", () => {
    const r = computeHealth({
      NODE_ENV: "development",
      RELAY_AUTH: "x",
      RELAY_BUILD_ID: "local-build-42",
    });
    expect(r.revision).toBe("local-build-42");
  });
