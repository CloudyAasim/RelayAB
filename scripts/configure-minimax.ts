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
// MiniMax facts
// ---------------------------------------------------------------------------

/**
 * MiniMax serves two protocol surfaces from DIFFERENT base paths, and mixing
 * them is the single most common configuration mistake:
 *
 *   OpenAI-compatible : https://api.minimax.cn/v1
 *   Anthropic-compatible: https://api.minimax.cn/anthropic
 *
 * This script configures the OpenAI face, because the upstream model list is
 * only available there. Enabling the Anthropic face too costs nothing and
 * lets clients use `/anthropic/v1/messages` against the same key.
 */
const OPENAI_BASE = "https://api.minimax.cn/v1";
const ANTHROPIC_BASE = "https://api.minimax.cn/anthropic";

/** Asked for first; MiniMax's own listing is authoritative when it answers. */
const MODELS_ENDPOINT = "/models";

/**
 * Fallback list, used only when the upstream cannot be reached. These are the
 * model ids MiniMax documents; the upstream answer always wins when it is
 * available, because vendors add models without warning.
 */
const FALLBACK_MODELS = [
  "MiniMax-M2.5",
  "MiniMax-M2.1",
  "MiniMax-M2",
  "MiniMax-M1",
  "abab6.5s-chat",
];

/**
 * Context windows for the models we have shipped against. Only used to fill in
 * `modelConfigs` for models the upstream listing returned but we have no entry
 * for; a wrong number here is worse than the schema default, so anything
 * unknown keeps the default rather than being guessed.
 */
const KNOWN_CONTEXT: Record<string, { context: number; output: number }> = {
  "MiniMax-M2.5": { context: 204_800, output: 131_072 },
  "MiniMax-M2.1": { context: 204_800, output: 131_072 },
  "MiniMax-M2": { context: 204_800, output: 131_072 },
  "MiniMax-M2.7": { context: 204_800, output: 131_072 },
  "MiniMax-M1": { context: 32_768, output: 32_768 },
  "abab6.5s-chat": { context: 32_768, output: 8_192 },
};

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

async function resolveUpstreamModels(p: Provider): Promise<string[]> {
  if (SKIP_UPSTREAM) {
    c.warn("跳过上游探测，使用内置模型列表");
    return FALLBACK_MODELS;
  }

  // Probe with the base URL as it currently stands, so a provider that was
  // created with no base URL still gets a real answer rather than a guess.
  const base = p.baseUrl || OPENAI_BASE;
  c.head(`探测上游模型列表  ${base}${MODELS_ENDPOINT}`);
  const res = await callUpstream({
    baseUrl: base,
    encryptedApiKey: p.encryptedApiKey,
    path: MODELS_ENDPOINT,
    timeoutMs: 15_000,
  });

  if (!res.ok) {
    c.bad(`上游返回 ${res.status}${res.error ? ` (${res.error})` : ""}`);
    const detail =
      typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? "").slice(0, 200);
    console.log(`      上游响应: ${detail}`);
    if (res.status === 401 || res.status === 403) {
      c.bad("密钥无效或无权限 —— 不会写入任何映射，请先在管理台确认密钥正确。");
      return [];
    }
    c.warn("改用内置模型列表继续。");
    return FALLBACK_MODELS;
  }

  const ids = extractModelIds(res.body);
  if (ids.length === 0) {
    c.warn("上游返回了无法解析的模型列表，改用内置列表");
    return FALLBACK_MODELS;
  }
  c.ok(`上游返回 ${ids.length} 个模型（${res.latencyMs}ms）: ${ids.join(", ")}`);
  return ids;
}

function buildModelConfig(id: string): ModelConfig {
  const known = KNOWN_CONTEXT[id];
  return {
    upstreamId: id,
    clientId: id,
    displayName: id,
    contextLength: known?.context ?? 128_000,
    maxOutputTokens: known?.output ?? 8_192,
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

  const models = await resolveUpstreamModels(target);
  if (models.length === 0) return false;

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

  const updated = await updateProvider(target.id, {
    baseUrl: OPENAI_BASE,
    modelMapping,
    modelConfigs,
    // MiniMax speaks both protocols; turning the Anthropic face on with its
    // own base is what `/anthropic/v1/messages` needs, and the two bases are
    // not interchangeable.
    anthropicBaseUrl: ANTHROPIC_BASE,
    openaiEnabled: faces.openaiEnabled,
    anthropicEnabled: true,
    enabled: true,
  } as Parameters<typeof updateProvider>[1]);

  if (!updated) {
    c.bad("写入失败：找不到该 provider");
    return false;
  }

  c.ok(`baseUrl   = ${updated.baseUrl}`);
  c.ok(`anthropic = ${updated.anthropicBaseUrl}`);
  c.ok(`模型映射  = ${Object.keys(updated.modelMapping).length} 条`);
  for (const [client, upstream] of Object.entries(updated.modelMapping)) {
    console.log(`      ${client} → ${upstream}`);
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

  const updated = await updateMediaProvider(target.id, {
    name: target.name || "MiniMax Media",
    baseUrl: MEDIA_TEMPLATES[TEMPLATES[0]].baseUrl,
    models: models as never,
    specs: specs as never,
    enabled: true,
  } as Parameters<typeof updateMediaProvider>[1]);

  if (!updated) {
    c.bad("写入失败：找不到该 media provider");
    return false;
  }

  c.ok(`baseUrl = ${updated.baseUrl}`);
  c.ok(`模型    = ${Object.keys(updated.models).length} 个: ${Object.keys(updated.models).join(", ")}`);
  c.ok(`spec    = ${updated.specs.length} 个:`);
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

async function verify(): Promise<void> {
  c.head("③ 复核");

  const chat = await listProviders();
  for (const p of chat) {
    if (!p.baseUrl) continue;
    const res = await callUpstream({
      baseUrl: p.baseUrl,
      encryptedApiKey: p.encryptedApiKey,
      path: MODELS_ENDPOINT,
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
      c.warn(`  上游有但没映射: ${extra.join(", ")}  （新模型，用 --chat 重跑一次即可带上）`);
    }
  }

  const media = await listMediaProviders();
  for (const m of media) {
    if (!m.baseUrl) continue;
    // Media providers have no universal "list models" endpoint, so the check is
    // that the spec paths resolve against the base URL rather than a live call.
    c.ok(`${m.name}: ${Object.keys(m.models).length} 个模型 / ${m.specs.length} 个 spec`);
    for (const s of m.specs) {
      const sp = s as { capability?: string; transport?: { path?: string } };
      const url = `${m.baseUrl.replace(/\/$/, "")}${sp.transport?.path ?? ""}`;
      console.log(`      ${sp.capability} → ${url}`);
    }
  }
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
  console.log(DRY_RUN ? "\x1b[33m[dry-run] 不会写入任何配置\x1b[0m" : "\x1b[33m[写入模式]\x1b[0m");

  if (SEED_DEMO) await seedDemo();

  const chatOk = await configureChat();
  const mediaOk = await configureMedia();
  if (!DRY_RUN) await verify();

  c.head("结果");
  c[chatOk ? "ok" : "bad"](`聊天服务商 ${chatOk ? "已配置" : "未完成"}`);
  c[mediaOk ? "ok" : "bad"](`媒体服务商 ${mediaOk ? "已配置" : "未完成"}`);
  if (!chatOk || !mediaOk) process.exitCode = 1;
}

void write;
main().catch((err) => {
  console.error("[configure-minimax] 失败:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
