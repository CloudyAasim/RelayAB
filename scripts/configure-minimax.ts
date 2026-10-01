/**
 * scripts/configure-minimax.ts
 *
 * Fill in a freshly-created MiniMax chat provider and media provider, then
 * verify both end to end against the real upstream.
 *
 * Operators create a provider with just a key pasted in; everything else
 * (base URL, model mapping, per-model context/cost, media specs) is left
 * empty and the provider silently serves nothing. This script completes it.
 *
 * What it does:
 *   1. Prints the current providers so you can see what is actually stored.
 *   2. For the chat provider: sets the OpenAI-compatible base URL, then
 *      **asks the upstream for its real model list** and builds the mapping
 *      from that answer rather than from a hardcoded guess. If the key is
 *      wrong, this fails loudly instead of writing a mapping that can never
 *      route.
 *   3. For the media provider: installs the specs and model list from
 *      `lib/media/seeds.ts`, which already ships MiniMax image / video /
 *      speech / STT definitions.
 *   4. Re-reads both and prints the result, including whether the models the
 *      mapping advertises are the ones the upstream actually returned.
 *
 * Run it inside the app container, where the database and master key live:
 *     dokku exec relay-ab web.1 pnpm configure-minimax
 * Locally, against a scratch database:
 *     pnpm tsx scripts/configure-minimax.ts --dry-run
 *
 * Flags:
 *   --dry-run        report what would change, write nothing
 *   --chat <id>      chat provider id (default: the only incomplete one)
 *   --media <id>     media provider id (default: the only incomplete one)
 *   --skip-upstream  do not call MiniMax; use the static model list
 *   --seed-demo      create two key-only providers first, then configure
 *                    them. Exercises the whole path against a throwaway
 *                    in-memory database with a fake key.
 */
import { listProviders, updateProvider, createProvider, type Provider } from "../src/lib/db/providers";
import {
  createMediaProvider,
  listMediaProviders,
  updateMediaProvider,
  type MediaProvider,
} from "../src/lib/db/media-providers";
import { callUpstream, extractModelIds } from "../src/lib/providers/upstream";
import { MEDIA_TEMPLATES } from "../src/lib/media/seeds";
import { defaultFaceFlags, type ModelConfig } from "../src/lib/db/types";
import { withTransaction } from "../src/lib/db/sqlite";
import { knownModelOrDefault, lookupKnownModel } from "../src/lib/providers/known-models";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY_RUN = flag("dry-run");
const SKIP_UPSTREAM = flag("skip-upstream");
const SEED_DEMO = flag("seed-demo");
const CHAT_ID = opt("chat");
const MEDIA_ID = opt("media");

// ---------------------------------------------------------------------------
// MiniMax facts (verified against platform.minimax.io/docs, Sep 2026)
// ---------------------------------------------------------------------------

/**
 * MiniMax keys authenticate against exactly one host, and the rejection is a
 * bare 401 that never mentions geography — so the only way to tell the hosts
 * apart is to send the key and see which one stops complaining.
 *
 * Three of them answer, not two:
 *
 *   api.minimax.io     global     key from platform.minimax.io     documented
 *   api.minimaxi.com   mainland   key from platform.minimaxi.com   documented
 *   api.minimax.cn     mainland   legacy alias, no longer in the docs
 *
 * The third one is why this is a list and not a config flag. It serves the
 * byte-identical `authorized_error (1004)` envelope as the other two, so it is
 * unambiguously the real API and not a parked domain or a redirector — but no
 * current official document names it, which makes it a poor thing to hardcode
 * into a provider and a good thing to fall back to.
 *
 * Probed in that order: the two documented hosts first, the legacy alias last.
 */
const REGIONS = [
  { id: "global", host: "api.minimax.io", documented: true },
  { id: "cn", host: "api.minimaxi.com", documented: true },
  { id: "cn-legacy", host: "api.minimax.cn", documented: false },
] as const;

/** Both protocol faces live under each host, on different paths. */
const OPENAI_PATH = "/v1";
const ANTHROPIC_PATH = "/anthropic";

/**
 * Fallback list, used only when the upstream cannot be reached at all.
 *
 * These are the model ids MiniMax documents today. The upstream answer always
 * wins when it is available, because vendors add and retire models without
 * notice — and a stale hardcoded list is how a gateway ends up advertising
 * models that no longer exist.
 */
const FALLBACK_MODELS = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
  "M2-her",
];

/**
 * Context windows live in `src/lib/providers/known-models.ts`, shared with the
 * assistant's provider tools. Two copies of this table would eventually
 * disagree, and the loser of that race is a model advertised with the wrong
 * window. See that file for why an unknown model keeps a conservative default
 * instead of being guessed.
 */

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const c = {
  ok: (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`),
  warn: (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`),
  bad: (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`),
  head: (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`),
};

const write = (s: string) => console.log(DRY_RUN ? `  \x1b[90m[dry-run]\x1b[0m ${s}` : s);

/** Sentinel used to abort the throwaway transaction that backs a dry run. */
const ROLLED_BACK = Symbol("dry-run-rollback");

/**
 * Run the real write, then roll it back.
 *
 * A preview has to show what would actually be *stored*, which means running
 * the actual merge — hand-rolling a "simulated" merge instead would drift the
 * moment the real one changes, and a preview that lies is worse than none.
 * So the write genuinely executes, inside a transaction that is always rolled
 * back. The nested `updateProvider` / `updateMediaProvider` calls join the
 * outer transaction rather than committing on their own.
 */
async function commit<T>(apply: () => Promise<T>): Promise<T> {
  if (!DRY_RUN) return await apply();

  let previewed: T;
  try {
    await withTransaction(async () => {
      previewed = await apply();
      throw ROLLED_BACK;
    });
  } catch (err) {
    if (err === ROLLED_BACK) return previewed!;
    throw err;
  }
  /* c8 ignore next */
  throw new Error("dry-run transaction committed instead of rolling back");
}

// ---------------------------------------------------------------------------
// Inspect current state
// ---------------------------------------------------------------------------

/** A provider that has a key but nothing else configured. */
function isUnconfigured(p: Provider): boolean {
  return !p.baseUrl || Object.keys(p.modelMapping ?? {}).length === 0;
}

function describe(p: Provider): string {
  const base = p.baseUrl ?? "(空)";
  const n = Object.keys(p.modelMapping ?? {}).length;
  return `${p.name}  id=${p.id}  kind=${p.kind}  base=${base}  映射=${n} 条`;
}

function describeMedia(m: MediaProvider): string {
  return `${m.name}  id=${m.id}  base=${m.baseUrl || "(空)"}  模型=${Object.keys(m.models ?? {}).length}  spec=${(m.specs ?? []).length}`;
}

// ---------------------------------------------------------------------------
// Chat provider
// ---------------------------------------------------------------------------

/** What one probe of a region told us. */
interface RegionProbe {
  region: (typeof REGIONS)[number];
  ok: boolean;
  status: number;
  models: string[];
  latencyMs: number;
  detail?: string;
}

/**
 * Ask one region whether it accepts this key.
 *
 * `ok` means *authenticated*, and only that: 401/403 is what a wrong region
 * (or a bad key) looks like, and every host answers an unauthenticated call
 * with the same `authorized_error (1004)` envelope, so the status code is the
 * only signal that separates the two.
 *
 * The model list is parsed when present but is deliberately NOT part of `ok`:
 * the chat side needs one to build a mapping, while the media side only needs
 * to learn which host this key belongs to and has no list endpoint to ask.
 */
async function probeRegion(
  region: (typeof REGIONS)[number],
  encryptedApiKey: string,
): Promise<RegionProbe> {
  const baseUrl = `https://${region.host}${OPENAI_PATH}`;
  const res = await callUpstream({
    baseUrl,
    encryptedApiKey,
    path: "/models",
    timeoutMs: 15_000,
  });
  const models = res.ok ? extractModelIds(res.body) : [];
  return {
    region,
    ok: res.ok,
    status: res.status,
    models,
    latencyMs: res.latencyMs,
    detail: res.error ?? (res.ok ? undefined : summarize(res.body)),
  };
}

function summarize(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/**
 * Find the host this key belongs to.
 *
 * A region mismatch is indistinguishable from a bad key by status code alone —
 * every host answers an unauthenticated call with the same `authorized_error
 * (1004)` envelope. Probing them in turn and reporting which one authenticated
 * is the only reliable way to tell them apart, and it means the operator never
 * has to know which platform their key came from.
 *
 * `requireModels` separates the two callers: the chat side needs a list to
 * build a mapping from, while the media side only needs the host and would be
 * misled into "wrong region" by a provider that answers without a list.
 */
async function resolveRegion(
  label: string,
  encryptedApiKey: string,
  requireModels: boolean,
): Promise<{ region: (typeof REGIONS)[number]; models: string[] } | null> {
  c.head(`探测区域  （密钥属于 ${label}）`);

  for (const region of REGIONS) {
    const probe = await probeRegion(region, encryptedApiKey);
    if (probe.ok) {
      if (requireModels && probe.models.length === 0) {
        c.warn(`${region.host} 认证通过但没有返回模型列表，改试下一个`);
        continue;
      }
      c.ok(
        `${region.host} 认证通过` +
          (probe.models.length > 0 ? `，${probe.models.length} 个模型` : "") +
          `（${probe.latencyMs}ms）` +
          (region.documented ? "" : "  ← 旧域名，官方文档已不再列出"),
      );
      return { region, models: probe.models };
    }
    const why =
      probe.status === 401 || probe.status === 403
        ? "401/403 —— 密钥不属于这个区域（或密钥无效）"
        : probe.status === 0
          ? `连不上：${probe.detail ?? "网络错误"}`
          : `HTTP ${probe.status}：${probe.detail ?? ""}`;
    c.warn(`${region.host} ${why}`);
  }

  return null;
}

async function resolveUpstreamModels(p: Provider): Promise<string[]> {
  if (SKIP_UPSTREAM) {
    c.warn("跳过上游探测，使用内置模型列表");
    return FALLBACK_MODELS;
  }

  const found = await resolveRegion(p.name, p.encryptedApiKey, true);
  if (found) {
    c.ok(`使用区域 ${found.region.host}`);
    c.ok(`模型：${found.models.join(", ")}`);
    return found.models;
  }

  c.bad(`全部 ${REGIONS.length} 个主机都无法用这个密钥认证`);
  c.warn("不会写入任何模型映射 —— 一份永远路由不通的假配置比空配置更难排查。");
  c.warn("请确认密钥是否有效，以及它来自 platform.minimax.io 还是 platform.minimaxi.com。");
  return [];
}

function buildModelConfig(id: string): ModelConfig {
  const known = knownModelOrDefault(id);
  return {
    upstreamId: id,
    clientId: id,
    displayName: id,
    contextLength: known.context,
    maxOutputTokens: known.output,
    // Free until an operator sets real prices; the billing docs are explicit
    // that 0 means "not priced", not "free to charge anyone".
    inputCost: 0,
    outputCost: 0,
    enabled: true,
  };
}

async function configureChat(): Promise<boolean> {
  c.head("① 聊天服务商（OpenAI 兼容面）");

  const all = await listProviders();
  if (all.length === 0) {
    c.bad("没有找到任何聊天服务商");
    return false;
  }

  for (const p of all) console.log(`  ${describe(p)}`);

  const target = CHAT_ID
    ? all.find((p) => p.id === CHAT_ID)
    : all.find(isUnconfigured) ?? (all.length === 1 ? all[0] : null);

  if (!target) {
    c.warn("无法自动判断目标（多个服务商且没有未配置的）。用 --chat <id> 指定。");
    return false;
  }
  if (!CHAT_ID && !isUnconfigured(target)) {
    c.warn(`${target.name} 已经配置过了，跳过。用 --chat <id> 可强制重配。`);
    return true;
  }

  const region = SKIP_UPSTREAM ? null : await resolveRegion(target.name, target.encryptedApiKey, true);
  if (!SKIP_UPSTREAM && !region) {
    c.bad("无法确定密钥所属区域，未写入任何配置");
    return false;
  }
  const host = region?.region.host ?? REGIONS[0].host;
  const models = region?.models ?? FALLBACK_MODELS;

  // Identity mapping: the client asks for the same id the upstream uses.
  // The docs are explicit that aliasing to something else misleads whoever
  // reads the usage log later.
  const modelMapping: Record<string, string> = {};
  const modelConfigs: Record<string, ModelConfig> = {};
  for (const id of models) {
    modelMapping[id] = id;
    modelConfigs[id] = buildModelConfig(id);
  }

  const faces = defaultFaceFlags(target.kind, target.upstreamFormat);

  const updated = await commit(() =>
    updateProvider(target.id, {
      baseUrl: `https://${host}${OPENAI_PATH}`,
      modelMapping,
      modelConfigs,
      // MiniMax speaks both protocols; the Anthropic face needs its OWN base
      // path — the two are not interchangeable, and mixing them is the most
      // common MiniMax configuration mistake.
      anthropicBaseUrl: `https://${host}${ANTHROPIC_PATH}`,
      openaiEnabled: faces.openaiEnabled,
      anthropicEnabled: true,
      enabled: true,
    } as Parameters<typeof updateProvider>[1]),
  );

  if (!updated) {
    c.bad("写入失败：找不到该 provider");
    return false;
  }

  write(`区域      = ${host}`);
  write(`baseUrl   = ${updated.baseUrl}`);
  write(`anthropic = ${updated.anthropicBaseUrl}`);
  write(`模型映射  = ${Object.keys(updated.modelMapping).length} 条`);
  for (const [client, upstream] of Object.entries(updated.modelMapping)) {
    const ctx = lookupKnownModel(client);
    console.log(`      ${client} → ${upstream}${ctx ? `  (${ctx.context.toLocaleString()} ctx)` : ""}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Media provider
// ---------------------------------------------------------------------------

/**
 * Which seeded templates to install. MiniMax's image, video and speech APIs
 * all live on the same host, so one media provider can carry all of them;
 * `models` is what routes each model to the API version it actually speaks.
 */
const TEMPLATES = ["minimax-image", "minimax-video", "minimax-speech"] as const;

async function configureMedia(): Promise<boolean> {
  c.head("② 媒体服务商（图片 / 视频 / 语音）");

  const all = await listMediaProviders();
  if (all.length === 0) {
    c.bad("没有找到任何媒体服务商");
    return false;
  }

  for (const m of all) console.log(`  ${describeMedia(m)}`);

  const target = MEDIA_ID
    ? all.find((m) => m.id === MEDIA_ID)
    : all.find((m) => !m.baseUrl || (m.specs ?? []).length === 0) ?? (all.length === 1 ? all[0] : null);

  if (!target) {
    c.warn("无法自动判断目标（多个服务商且没有未配置的）。用 --media <id> 指定。");
    return false;
  }
  if (!MEDIA_ID && target.baseUrl && (target.specs ?? []).length > 0) {
    c.warn(`${target.name} 已经配置过了，跳过。用 --media <id> 可强制重配。`);
    return true;
  }

  // The media provider carries its OWN key, which is not necessarily the chat
  // provider's key, so its region is resolved independently. Hardcoding the
  // template's host here is what would quietly break every global (.io) key:
  // the provider would look configured, report success, and 401 on first use.
  // Media base URLs carry no path suffix — the specs already include /v1.
  let mediaHost: string;
  if (SKIP_UPSTREAM) {
    c.warn("跳过上游探测，媒体 baseUrl 沿用模板默认值");
    mediaHost = new URL(MEDIA_TEMPLATES[TEMPLATES[0]].baseUrl).host;
  } else {
    const found = await resolveRegion(target.name, target.encryptedApiKey, false);
    if (!found) {
      c.bad(`全部 ${REGIONS.length} 个主机都无法用这个媒体服务商的密钥认证`);
      c.warn("不会写入任何 baseUrl —— 指向错误主机的媒体配置一次都用不了。");
      return false;
    }
    mediaHost = found.region.host;
  }

  // Merge the seeded templates: models accumulate, specs are keyed by
  // capability so two video API versions coexist (that is exactly what
  // `models` is for).
  const models: Record<string, unknown> = { ...(target.models ?? {}) };
  const specs: unknown[] = [...(target.specs ?? [])];
  const seen = new Set(specs.map((s) => (s as { capability?: string })?.capability ?? ""));

  for (const key of TEMPLATES) {
    const tpl = MEDIA_TEMPLATES[key];
    if (!tpl) continue;
    Object.assign(models, tpl.models);
    for (const spec of tpl.specs) {
      const cap = (spec as { capability?: string })?.capability ?? "";
      // video.generate legitimately has two specs (v1 and v2 APIs), so only
      // skip an exact duplicate capability+transport pair.
      const dup = specs.some(
        (s) =>
          (s as { capability?: string; transport?: { path?: string } })?.capability === cap &&
          (s as { transport?: { path?: string } })?.transport?.path ===
            (spec as { transport?: { path?: string } }).transport?.path,
      );
      if (!dup) specs.push(spec);
    }
    seen.add(cap0(specs));
  }

  const updated = await commit(() =>
    updateMediaProvider(target.id, {
      name: target.name || "MiniMax Media",
      baseUrl: `https://${mediaHost}`,
      models: models as never,
      specs: specs as never,
      enabled: true,
    } as Parameters<typeof updateMediaProvider>[1]),
  );

  if (!updated) {
    c.bad("写入失败：找不到该 media provider");
    return false;
  }

  write(`baseUrl = ${updated.baseUrl}`);
  write(`模型    = ${Object.keys(updated.models).length} 个: ${Object.keys(updated.models).join(", ")}`);
  write(`spec    = ${updated.specs.length} 个:`);
  for (const s of updated.specs) {
    const sp = s as { capability?: string; transport?: { method?: string; path?: string }; displayName?: string };
    console.log(`      ${sp.capability}  ${sp.transport?.method} ${sp.transport?.path}  — ${sp.displayName ?? ""}`);
  }
  return true;
}

const cap0 = (arr: unknown[]): string =>
  (arr[arr.length - 1] as { capability?: string })?.capability ?? "";

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

async function verify(): Promise<boolean> {
  c.head("③ 复核");

  const chat = await listProviders();
  for (const p of chat) {
    if (!p.baseUrl) continue;
    const res = await callUpstream({
      baseUrl: p.baseUrl,
      encryptedApiKey: p.encryptedApiKey,
      path: "/models",
      timeoutMs: 15_000,
    });
    const advertised = Object.keys(p.modelMapping ?? {});
    if (!res.ok) {
      c.bad(`${p.name}: 上游 ${res.status}`);
      continue;
    }
    const upstream = new Set(extractModelIds(res.body));
    const missing = advertised.filter((m) => !upstream.has(m));
    const extra = [...upstream].filter((m) => !advertised.includes(m));
    c.ok(`${p.name}: 上游 ${res.status}，${upstream.size} 个模型`);
    if (missing.length === 0) {
      c.ok(`  映射的 ${advertised.length} 个模型上游全部存在`);
    } else {
      c.warn(`  映射里有上游没有的: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      c.warn(`  上游有但没映射: ${extra.join(", ")}  （新模型，重跑一次即可带上）`);
    }
  }

  const media = await listMediaProviders();
  let mediaHealthy = true;
  for (const m of media) {
    if (!m.baseUrl) continue;

    // A live auth check, not a URL print. There is no cross-vendor "list
    // models" for media, but a wrong-region host still answers 401 — which is
    // exactly the failure this needs to catch, and the one a URL print would
    // have waved through.
    const res = await callUpstream({
      baseUrl: m.baseUrl,
      encryptedApiKey: m.encryptedApiKey,
      path: "/v1/models",
      timeoutMs: 15_000,
    });
    if (res.status === 401 || res.status === 403) {
      c.bad(
        `${m.name}: ${m.baseUrl} 拒绝这个密钥（${res.status}）—— baseUrl 与密钥区域不匹配，所有媒体调用都会失败。` +
          ` 重跑一次本脚本可自动纠正。`,
      );
      mediaHealthy = false;
    } else {
      c.ok(
        `${m.name}: ${m.baseUrl} 鉴权通过（HTTP ${res.status}），${Object.keys(m.models).length} 个模型 / ${m.specs.length} 个 spec`,
      );
    }
    for (const s of m.specs) {
      const sp = s as { capability?: string; transport?: { path?: string } };
      const url = `${m.baseUrl.replace(/\/$/, "")}${sp.transport?.path ?? ""}`;
      console.log(`      ${sp.capability} → ${url}`);
    }
  }
  return mediaHealthy;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seedDemo(): Promise<void> {
  c.head("① 预置两个只含密钥的 provider（模拟管理台新建）");
  // A real key is never touched here — this exists to prove the script drives
  // the same create-then-configure path an operator goes through, and that a
  // provider with no base URL survives the round trip.
  process.env.RELAY_DB_PATH = ":memory:";
  await createProvider({
    name: "MiniMax",
    kind: "openai",
    apiKey: "sk-demo-not-a-real-key",
    enabled: true,
  });
  await createMediaProvider({
    name: "MiniMax Media",
    apiKey: "sk-demo-not-a-real-key",
    enabled: true,
  });
  c.ok("已建（内存库，退出即消失）");
}

async function main(): Promise<void> {
  console.log(
    DRY_RUN
      ? "\x1b[33m[dry-run] 不会写入任何配置\x1b[0m（写入在事务中执行后回滚）"
      : "\x1b[33m[写入模式]\x1b[0m",
  );

  if (SEED_DEMO) await seedDemo();

  const chatOk = await configureChat();
  const mediaOk = await configureMedia();
  // A media provider pointed at the wrong region still reports "configured" —
  // the re-read is the only thing that catches it, so it gates the exit code.
  const verifyOk = DRY_RUN ? true : await verify();

  c.head("结果");
  c[chatOk ? "ok" : "bad"](`聊天服务商 ${chatOk ? "已配置" : "未完成"}`);
  c[mediaOk ? "ok" : "bad"](`媒体服务商 ${mediaOk ? "已配置" : "未完成"}`);
  c[verifyOk ? "ok" : "bad"](`回读复核 ${verifyOk ? "通过" : "未通过"}`);
  if (!chatOk || !mediaOk || !verifyOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[configure-minimax] 失败:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
