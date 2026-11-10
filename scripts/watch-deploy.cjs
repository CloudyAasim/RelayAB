/**
 * scripts/watch-deploy.cjs —— 纯观察的部署守望者。
 *
 * 部署完必须核对 `healthz` 的 `revision`（08 §二，那条纪律来自一次
 * 「workflow 报 success、其实什么都没部署」）。这一步手工做过很多次，
 * 所以把它变成一个只读脚本。
 *
 * **它只做一件事：GET `<base>/healthz`，把 `revision` 和期望值比。**
 * 不发任何写请求、不碰 GitHub API、不取消任何 workflow —— 这正是它和早就
 * 淘汰的 `guarded-deploy.cjs` 的区别：那个脚本在两次瞬时超时之后**取消了正在进行的
 * 部署**，把一次正常的容器切换判成故障，造成过一次生产宕机（08 §六 第 7 项）。
 * 观察者永远不改变被观察的东西。
 *
 * 用法：
 *   node scripts/watch-deploy.cjs                       # 期望值取 git HEAD
 *   node scripts/watch-deploy.cjs --expect c18f673      # 显式指定
 *   node scripts/watch-deploy.cjs --url http://127.0.0.1:3114 --timeout 60
 *
 * 退出码：0 = 线上已是期望版本；1 = 超时 / 参数错 / 拿不到任何版本号。
 */
const { execFileSync } = require("node:child_process");

const DEFAULT_URL = "https://api.aasim.l.cd";
const DEFAULT_TIMEOUT_S = 900; // 08 §三：实测部署 6–10 分钟
const DEFAULT_INTERVAL_S = 10;

function parseArgs(argv) {
  const opts = { url: process.env.RELAY_BASE ?? DEFAULT_URL, expect: "", timeout: DEFAULT_TIMEOUT_S, interval: DEFAULT_INTERVAL_S };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return value;
    };
    if (arg === "--url") opts.url = take();
    else if (arg === "--expect") opts.expect = take();
    else if (arg === "--timeout") opts.timeout = Number(take());
    else if (arg === "--interval") opts.interval = Number(take());
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  opts.url = opts.url.replace(/\/+$/, "");
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error("--timeout 必须是正数（秒）");
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) throw new Error("--interval 必须是正数（秒）");
  return opts;
}

/** 仓库 HEAD 的短提交号；`--expect` 优先，git 不在也能跑。 */
function localRevision() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** 一次只读探测：返回 { revision } 或 { error }。 */
async function probeHealthz(base) {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const revision = body?.data?.revision;
    if (!revision) return { error: "响应里没有 data.revision" };
    return { revision: String(revision) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[watch-deploy] ${err.message}`);
    console.error("用法：node scripts/watch-deploy.cjs [--expect <rev>] [--url <base>] [--timeout 900] [--interval 10]");
    process.exit(1);
  }

  if (opts.help) {
    console.log("用法：node scripts/watch-deploy.cjs [--expect <rev>] [--url <base>] [--timeout 900] [--interval 10]");
    console.log("只读：只 GET /healthz，发不出任何写请求，也不会取消部署。");
    return;
  }

  const expected = opts.expect || localRevision();
  if (!expected) {
    console.error("[watch-deploy] 拿不到期望版本：本机没有 git，也没有给 --expect");
    process.exit(1);
  }

  console.log(`[watch-deploy] 目标 ${opts.url}，期望 revision=${expected}，超时 ${opts.timeout}s`);
  const started = Date.now();
  let lastRevision = "(还没拿到)";
  let lastError = "";

  for (;;) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const { revision, error } = await probeHealthz(opts.url);
    if (revision) {
      if (revision === expected) {
        console.log(`[watch-deploy] ✓ 已上线：revision=${revision}（用时 ${elapsed}s）`);
        return;
      }
      if (revision !== lastRevision) {
        console.log(`[watch-deploy] ${elapsed}s 线上还是 ${revision}，继续等`);
        lastRevision = revision;
      }
    } else {
      lastError = error;
      console.log(`[watch-deploy] ${elapsed}s 探测失败：${error}`);
    }

    if (elapsed + opts.interval > opts.timeout) {
      console.error(
        `[watch-deploy] 超时：${opts.timeout}s 内没等到 ${expected}（最后看到 ${lastRevision}` +
          `${lastError ? `，最后一次错误：${lastError}` : ""}）`,
      );
      console.error("[watch-deploy] 这只是一个观察结果 —— 没有取消任何部署，去 CI 里看 workflow 状态。");
      process.exit(1);
    }
    await sleep(opts.interval * 1000);
  }
}

main();
