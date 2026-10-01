/**
 * scripts/check-env.ts
 *
 * Environment preflight (manual diagnostic only — not wired into any build).
 *
 *     pnpm check-env
 *
 * `/healthz` remains the canonical runtime check. This exists to catch the
 * two mistakes that are otherwise found the hard way, on the first request:
 *
 *   1. RELAY_AUTH unset — and the operator has no idea which value the
 *      existing sessions and encrypted provider keys were derived from.
 *   2. RELAY_DB_PATH pointing somewhere the app cannot write. SQLite is a
 *      *file*, so there is no service to start and no credential to get
 *      wrong; the failure mode is purely filesystem, and the two that actually
 *      happen are (a) the directory does not exist and cannot be created, and
 *      (b) the directory exists but belongs to another user — which is exactly
 *      what a `dokku storage:mount` produces before the ownership is fixed.
 *
 * The previous version of this script still checked `REDIS_URL` / `UPSTASH_*`
 * and told operators to set a Valkey connection string. On a SQLite
 * deployment it reported "no database configured" while the app was running
 * perfectly, which is the worst kind of diagnostic: confidently wrong.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const REQUIRED = ["RELAY_AUTH"] as const;

const DOC: Record<string, string> = {
  RELAY_AUTH: "主密码；同时派生会话密钥与 AES 主密钥（改了会让所有已加密的上游密钥失效）",
  RELAY_DB_PATH: "SQLite 文件路径；生产环境必须放在挂载卷上，例如容器内 /data/relayab.db",
  RELAY_PUBLIC_URL: "对外公网地址，例如 https://relay.example.com",
  RELAY_MASTER_KEY_HEX: "显式指定 32 字节十六进制主密钥；不设则由 RELAY_AUTH 派生",
  RELAY_DEFAULT_LOCALE: "默认语言，zh 或 en",
};

function has(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

type State = { level: "ok" | "warn" | "bad"; detail: string };

/**
 * Can the app actually use this database path?
 *
 * Deliberately touches the filesystem rather than only inspecting the string:
 * "RELAY_DB_PATH is set" says nothing about whether the process can create the
 * file there, and that is the only question that matters.
 */
function databaseState(): State {
  const configured = process.env.RELAY_DB_PATH?.trim();
  const path = configured || `${process.cwd()}/data/relayab.db`;

  if (path === ":memory:") {
    return { level: "ok", detail: ":memory:（内存库，重启即失，仅用于测试）" };
  }
  if (!isAbsolute(path) && !configured) {
    // The default lives under cwd(); fine for a systemd unit that owns it.
    return { level: "ok", detail: `${path}（默认路径，进程工作目录下的 data/）` };
  }

  const dir = dirname(resolve(path));
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
      return { level: "ok", detail: `${path}（目录已自动创建）` };
    } catch (err) {
      return {
        level: "bad",
        detail: `目录 ${dir} 不存在且无法创建：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const probe = `${dir}/.relayab-check-${process.pid}`;
  try {
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = (err as NodeJS.ErrnoException)?.code === "EACCES"
      ? "—— 目录属主不是应用用户。这正是 dokku storage:mount 建完目录后没 chown 的症状；" +
        "先 docker exec $CID id -u 拿到 uid，再 chown -R <uid>:<gid> 该目录"
      : "";
    return { level: "bad", detail: `目录 ${dir} 不可写：${message}${hint}` };
  }

  // Writable, but is the file itself still usable? A directory permission can
  // allow creating *new* files while an existing database stays unwritable.
  if (existsSync(path)) {
    try {
      if (!statSync(path).isFile()) {
        return { level: "bad", detail: `${path} 存在但不是普通文件` };
      }
    } catch (err) {
      return {
        level: "bad",
        detail: `无法 stat ${path}：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (configured.startsWith("/home/") || configured.startsWith("/opt/")) {
    return {
      level: "warn",
      detail: `${path}（看起来是宿主机路径。若应用跑在容器里，这里必须写容器内挂载点，例如 /data）`,
    };
  }
  return { level: "ok", detail: path };
}

function main(): void {
  if (process.env.NODE_ENV === "test") {
    console.log("[check-env] NODE_ENV=test → 跳过");
    process.exit(0);
  }

  const missing = REQUIRED.filter((k) => !has(k));
  const db = databaseState();
  const isCI = process.env.CI === "1";

  for (const [k, v] of Object.entries(DOC)) {
    if (!has(k)) {
      console.log(`  · ${k.padEnd(20)} 未设置  — ${v}`);
    }
  }

  if (missing.length === 0 && db.level === "ok") {
    console.log(
      `[check-env] OK (${isCI ? "ci" : "local"}): RELAY_AUTH 已设置，数据库 ${db.detail}`,
    );
    process.exit(0);
  }

  const lines = [
    "",
    "╭──────────────────────────────────────────────────────────────╮",
    "│  ✗  配置不完整，应用会起不来或每次请求都失败                  │",
    "╰──────────────────────────────────────────────────────────────╯",
    "",
  ];

  if (missing.length > 0) {
    lines.push("  缺少必填变量：");
    for (const k of missing) lines.push(`    • ${k}  — ${DOC[k] ?? ""}`);
    lines.push("");
  }
  if (db.level !== "ok") {
    lines.push(`  数据库：${db.detail}`, "");
  } else if (db.level === "warn") {
    lines.push(`  数据库：${db.detail}`, "");
  }

  lines.push(
    "  自建 Debian 怎么修（见 deploy/env.production.example）：",
    "    1. cp deploy/env.production.example /opt/relayab/.env.production",
    "    2. RELAY_AUTH=...            # openssl rand -hex 32",
    "    3. RELAY_DB_PATH=/data/relayab.db   # 容器内挂载点，不是宿主机路径",
    "    4. systemctl restart relayab（或 dokku 重启应用）",
    "",
    "  不需要数据库服务：SQLite 是 Node 内置模块，没有端口也没有密码。",
    "",
  );

  console.error(lines.join("\n"));
  process.exit(1);
}

main();
