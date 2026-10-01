/**
 * src/lib/assistant/tools.ts
 *
 * What the assistant can actually do.
 *
 * Two tiers, decided by the caller's role:
 *
 *  - **Everyone** can look at the model catalogue, test a model through the
 *    gateway with their own key, check their own quota, and read the
 *    deployment notes.
 *  - **Admins** additionally get read access to provider configuration, the
 *    ability to probe a candidate base URL with a *stored* key, and the
 *    ability to propose a change.
 *
 * The last one is the important boundary: `propose_*` never writes. It records
 * an intent in `assistant_actions` and hands back a rendered diff. Nothing in
 * this file mutates provider configuration on the assistant's say-so — the only
 * path that does is the confirm endpoint, which a human calls.
 */
import { z } from "zod";

import type { AssistantToolDef } from "./client";
import { probeUpstream } from "./client";
import {
  getMediaProviderById,
  listMediaProviders,
  resolveMediaProviderForModel,
} from "../db/media-providers";
import { getProviderById, listProviders } from "../db/providers";
import { listUsers, getUserById } from "../db/users";
import { listApiKeysByUser } from "../db/keys";
import { aggregateByKeyMany, listRecentUsage } from "../db/usage";
import { createAssistantAction } from "../db/assistant";
import { getPublicUrl } from "../config";
import { knownModelOrDefault } from "../providers/known-models";
import { decryptSecret } from "../crypto/secrets";
import { renderProviderDiff, renderMediaDiff } from "./diff";
import { DEPLOYMENT_NOTES } from "./deployment-notes";
import type { AuthedUser } from "../auth/session";

export interface ToolContext {
  user: AuthedUser;
  /** The caller's own `sk-relay-…` key, supplied per request and never stored. */
  relayKey?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Where the gateway is reachable from the server.
 *
 * `publicUrl()` in lib/config is the canonical resolver: it reads
 * RELAY_PUBLIC_URL, falls back to VERCEL_URL, and only then to localhost.
 * The `settings.publicUrl` row is a *display* override the admin panel edits,
 * and it is null on most deployments — reading it here is what made
 * test_gateway_model fail with "fetch failed" from inside the container.
 */
function gatewayBase(): string {
  return getPublicUrl();
}
/** Parse tool arguments; a model that sends malformed JSON should not 500. */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fail(message: string): ToolResult {
  return { ok: false, content: message };
}

function ok(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value, null, 2) };
}

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

const USER_TOOLS: AssistantToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_gateway_models",
      description:
        "列出这个 RelayAB 网关当前对外提供的所有模型（聊天与媒体）。回答「有哪些模型」「我能用什么」时先调它，不要凭记忆报模型名。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "test_gateway_model",
      description:
        "用一个具体模型跑一次真实请求，验证它是否真的可用。会消耗用户自己的配额。回答「这个模型能用吗」「帮我试试 X」时用它，而不是只看模型列表就下结论。",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "要测试的模型名，取自 list_gateway_models" },
          prompt: { type: "string", description: "测试提示词，默认一个简短问题" },
        },
        required: ["model"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_usage",
      description: "查询当前用户的配额、已用积分、密钥列表和最近用量。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deployment_notes",
      description:
        "取回本项目的部署参考：环境变量、Dokku/SQLite 部署步骤、备份与排错要点。用户问「怎么部署」「要配什么环境变量」「怎么备份」时用它，答案要基于返回内容而不是记忆。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "可选 narrowed 主题，如 dokku / env / backup / nginx" },
        },
        additionalProperties: false,
      },
    },
  },
];

const ADMIN_TOOLS: AssistantToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_providers",
      description:
        "列出所有聊天服务商的配置（密钥永不返回）。诊断「模型路由到哪个上游」「为什么某个模型不通」时先用它。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "probe_provider_host",
      description:
        "用某个服务商已存的密钥去探测候选 base URL 是否认证通过，返回上游真实模型列表。MiniMax 这类分区域的厂商用它来确认密钥属于哪个区域 —— 不要靠猜，探测结果才是答案。只读，不改任何配置。",
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "用哪个服务商已存的密钥" },
          baseUrl: { type: "string", description: "要探测的 base URL，例如 https://api.minimaxi.com/v1" },
          path: { type: "string", description: "模型列表路径，默认 /v1/models" },
        },
        required: ["providerId", "baseUrl"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_media_providers",
      description: "列出所有媒体服务商及其模型与 spec（图片/视频/语音）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_provider_update",
      description:
        "提出一次聊天服务商配置变更。这不会立刻生效 —— 它生成一份 before/after 对比，等管理员在界面上确认后才执行。baseUrl、模型映射、Anthropic 面、启用开关都可以改。",
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "要修改的服务商 id" },
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          baseUrl: { type: "string" },
          anthropicBaseUrl: { type: "string" },
          openaiEnabled: { type: "boolean" },
          anthropicEnabled: { type: "boolean" },
          enabled: { type: "boolean" },
          modelMapping: {
            type: "object",
            description: "客户端模型名 → 上游模型名 的完整替换表",
            additionalProperties: { type: "string" },
          },
        },
        required: ["providerId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_media_provider_update",
      description:
        "提出一次媒体服务商配置变更，同样需要管理员确认才执行。可以整份替换 models 与 specs。",
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string" },
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          baseUrl: { type: "string" },
          models: { type: "object", additionalProperties: true },
          specs: { type: "array", items: { type: "object" } },
          enabled: { type: "boolean" },
        },
        required: ["providerId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_users",
      description: "列出所有用户及其角色、配额和密钥数。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export function toolDefinitions(isAdmin: boolean): AssistantToolDef[] {
  return isAdmin ? [...USER_TOOLS, ...ADMIN_TOOLS] : USER_TOOLS;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const args = parseArgs(rawArgs);
  const isAdmin = ctx.user.role === "admin";

  switch (name) {
    // ---- shared --------------------------------------------------------
    case "list_gateway_models":
      return listGatewayModels();
    case "test_gateway_model":
      return testGatewayModel(args, ctx);
    case "get_my_usage":
      return getMyUsage(ctx);
    case "get_deployment_notes":
      return ok(DEPLOYMENT_NOTES(args.topic));

    // ---- admin only ----------------------------------------------------
    case "list_providers":
      if (!isAdmin) return fail("这是管理员功能。");
      return listProvidersTool();
    case "probe_provider_host":
      if (!isAdmin) return fail("这是管理员功能。");
      return probeProviderHost(args);
    case "list_media_providers":
      if (!isAdmin) return fail("这是管理员功能。");
      return listMediaProvidersTool();
    case "propose_provider_update":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeProviderUpdate(args, ctx);
    case "propose_media_provider_update":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeMediaProviderUpdate(args, ctx);
    case "list_users":
      if (!isAdmin) return fail("这是管理员功能。");
      return listUsersTool();

    default:
      return fail(`未知工具：${name}`);
  }
}

async function listGatewayModels(): Promise<ToolResult> {
  const chat = await listProviders();
  const chatModels = new Set<string>();
  const byProvider: Array<{ name: string; baseUrl: string | null; models: string[] }> = [];

  for (const p of chat) {
    if (!p.enabled) continue;
    const ids = Object.keys(p.modelMapping ?? {});
    ids.forEach((m) => chatModels.add(m));
    byProvider.push({ name: p.name, baseUrl: p.baseUrl ?? null, models: ids });
  }

  const media = (await listMediaProviders()).filter((m) => m.enabled);
  const mediaModels = media.flatMap((m) => Object.keys(m.models ?? {}));

  return ok({
    chatModels: [...chatModels].sort(),
    mediaModels: mediaModels.sort(),
    total: chatModels.size + mediaModels.length,
    providers: byProvider,
  });
}

async function testGatewayModel(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const model = z.string().min(1).safeParse(args.model);
  if (!model.success) return fail("缺少 model 参数。");
  if (!ctx.relayKey) {
    return fail(
      "没有拿到用户的网关密钥，无法发起真实调用。请让用户在模型测试页填入自己的 API 密钥后再试。",
    );
  }

  const base = gatewayBase();
  const body = {
    model: model.data,
    messages: [
      {
        role: "user",
        content: typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : "用一句话介绍你自己。",
      },
    ],
    max_tokens: 200,
    stream: false,
  };

  const started = Date.now();
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.relayKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      return ok({ model: model.data, ok: false, httpStatus: res.status, latencyMs, response: text.slice(0, 600) });
    }

    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    };
    const answer = parsed.choices?.[0]?.message?.content ?? "";
    return ok({
      model: model.data,
      ok: true,
      httpStatus: res.status,
      latencyMs,
      finishReason: parsed.choices?.[0]?.finish_reason ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null,
      answer: answer.slice(0, 1200),
    });
  } catch (err) {
    return fail(`调用失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function getMyUsage(ctx: ToolContext): Promise<ToolResult> {
  // The session user is deliberately a *small* shape (id, username, role) so it
  // stays cheap on every authenticated request. Quota and allocation live on
  // the full row, so this has to go back for it.
  const full = await getUserById(ctx.user.id);
  const { keys } = await listApiKeysByUser(ctx.user.id, { limit: 100 });
  const enabled = keys.filter((k) => k.enabled);
  const agg = await aggregateByKeyMany(keys.map((k) => k.id));
  const recent = await listRecentUsage(keys.map((k) => k.id), { limit: 15 });

  return ok({
    quotaType: full?.quotaType ?? null,
    quotaLimit: full?.quotaLimit ?? 0,
    quotaUsed: full?.quotaUsed ?? 0,
    remaining: full ? Math.max(0, full.quotaLimit - full.quotaUsed) : 0,
    allowedModels: full?.allowedModels ?? [],
    maxActiveKeys: full?.maxActiveKeys ?? 0,
    activeKeys: enabled.length,
    totalKeys: keys.length,
    usageByKey: agg,
    recentRequests: recent.map((r) => ({
      model: r.model,
      status: r.status,
      totalTokens: r.totalTokens,
      creditsUsed: r.creditsUsed,
      createdAt: r.createdAt,
      errorMessage: r.errorMessage,
    })),
  });
}

async function listProvidersTool(): Promise<ToolResult> {
  const providers = await listProviders();
  return ok(
    providers.map((p) => {
      const configs = Object.entries(p.modelConfigs ?? {});
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl ?? null,
        enabled: p.enabled,
        priority: p.priority,
        upstreamFormat: p.upstreamFormat,
        openaiEnabled: p.openaiEnabled,
        anthropicEnabled: p.anthropicEnabled,
        anthropicBaseUrl: p.anthropicBaseUrl ?? null,
        models: Object.keys(p.modelMapping ?? {}),
        modelDetails: configs.map(([id, c]) => ({
          id,
          contextLength: c.contextLength ?? null,
          maxOutputTokens: c.maxOutputTokens ?? null,
          enabled: c.enabled,
        })),
        // Never the key itself: the model has no need for it and the transcript
        // is persisted and re-sent on every subsequent turn.
        headers: p.headers,
      };
    }),
  );
}

async function probeProviderHost(args: Record<string, unknown>): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  const baseUrl = z.string().min(1).safeParse(args.baseUrl);
  if (!providerId.success || !baseUrl.success) return fail("需要 providerId 和 baseUrl。");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(`找不到服务商 ${providerId.data}。`);

  const res = await probeUpstream({
    baseUrl: baseUrl.data,
    apiKey: decryptSecret(provider.encryptedApiKey),
    timeoutMs: 20_000,
  });

  return ok({
    provider: provider.name,
    baseUrl: baseUrl.data,
    authenticated: res.ok,
    httpStatus: res.status,
    latencyMs: res.latencyMs,
    upstreamModels: res.models,
    error: res.error ?? null,
  });
}

async function listMediaProvidersTool(): Promise<ToolResult> {
  const media = await listMediaProviders();
  return ok(
    media.map((m) => ({
      id: m.id,
      name: m.name,
      baseUrl: m.baseUrl,
      enabled: m.enabled,
      priority: m.priority,
      models: Object.entries(m.models ?? {}).map(([id, cfg]) => ({
        id,
        upstreamId: (cfg as { upstreamId?: string })?.upstreamId ?? id,
        enabled: (cfg as { enabled?: boolean })?.enabled ?? true,
      })),
      specs: (m.specs ?? []).map((s) => ({
        capability: s.capability,
        displayName: s.displayName,
        method: s.transport?.method,
        path: s.transport?.path,
        models: s.models ?? null,
      })),
    })),
  );
}

async function proposeProviderUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  if (!providerId.success) return fail("缺少 providerId。");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(`找不到服务商 ${providerId.data}。`);

  const patch: Record<string, unknown> = {};
  if (typeof args.baseUrl === "string") patch.baseUrl = args.baseUrl.trim();
  if (typeof args.anthropicBaseUrl === "string") patch.anthropicBaseUrl = args.anthropicBaseUrl.trim();
  if (typeof args.openaiEnabled === "boolean") patch.openaiEnabled = args.openaiEnabled;
  if (typeof args.anthropicEnabled === "boolean") patch.anthropicEnabled = args.anthropicEnabled;
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (args.modelMapping && typeof args.modelMapping === "object") {
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.modelMapping as Record<string, unknown>)) {
      if (typeof v === "string") mapping[k] = v;
    }
    patch.modelMapping = mapping;
    // Keep the per-model config in step with the mapping: a model added to the
    // table with no config would fall back to a default context window, which is
    // how a 200k model ends up advertised as 1M.
    const configs: Record<string, unknown> = { ...(provider.modelConfigs ?? {}) };
    for (const [client, upstream] of Object.entries(mapping)) {
      // Keep an existing, already-corrected config rather than overwriting it
      // with the table's generic numbers; only fill in what is missing.
      const existingCfg = configs[client] as
        | { upstreamId?: string; contextLength?: number; maxOutputTokens?: number }
        | undefined;
      const known = knownModelOrDefault(existingCfg?.upstreamId ?? upstream);
      configs[client] = {
        upstreamId: upstream,
        clientId: client,
        displayName: client,
        contextLength: existingCfg?.contextLength ?? known.context,
        maxOutputTokens: existingCfg?.maxOutputTokens ?? known.output,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      };
    }
    for (const gone of Object.keys(configs)) {
      if (!(gone in mapping)) delete configs[gone];
    }
    patch.modelConfigs = configs;
  }

  if (Object.keys(patch).length === 0) {
    return fail("没有提供任何要修改的字段。");
  }

  const diff = renderProviderDiff(provider, patch);
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";

  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.update",
    targetId: provider.id,
    summary,
    args: patch,
    diff,
  });

  return ok({
    actionId: action.id,
    status: "pending",
    message: "变更已生成，等待管理员在界面上确认后才会生效。请把下面这份对比原样告诉用户。",
    diff,
  });
}

async function proposeMediaProviderUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  if (!providerId.success) return fail("缺少 providerId。");

  const provider = await getMediaProviderById(providerId.data);
  if (!provider) return fail(`找不到媒体服务商 ${providerId.data}。`);

  const patch: Record<string, unknown> = {};
  if (typeof args.baseUrl === "string") patch.baseUrl = args.baseUrl.trim();
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (args.models && typeof args.models === "object") patch.models = args.models;
  if (Array.isArray(args.specs)) patch.specs = args.specs;

  if (Object.keys(patch).length === 0) return fail("没有提供任何要修改的字段。");

  const diff = renderMediaDiff(provider, patch);
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";

  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "media_provider.update",
    targetId: provider.id,
    summary,
    args: patch,
    diff,
  });

  return ok({
    actionId: action.id,
    status: "pending",
    message: "变更已生成，等待管理员确认后才会生效。",
    diff,
  });
}

async function listUsersTool(): Promise<ToolResult> {
  const { users } = await listUsers({ limit: 200 });
  return ok(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      displayName: u.displayName,
      quotaType: u.quotaType,
      quotaLimit: u.quotaLimit,
      quotaUsed: u.quotaUsed,
      maxActiveKeys: u.maxActiveKeys,
      allowedModels: u.allowedModels,
      lastLoginAt: u.lastLoginAt,
    })),
  );
}

/** Exposed for the test route so it resolves a model the same way the proxy does. */
export async function findMediaModel(model: string) {
  return resolveMediaProviderForModel(model);
}
