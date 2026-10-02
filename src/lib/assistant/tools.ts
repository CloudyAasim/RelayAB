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
import { fetchPage, WebFetchError } from "./web-fetch";
import { NO_CREDENTIAL_MESSAGE, type AccountCredential } from "./credentials";
import { executeMediaRequest, resultItems } from "../media/handler";
import { proxyChatCompletion } from "../proxy/openai";
import type { ArtifactKind } from "../db/assistant-artifacts";
import type { AuthedUser } from "../auth/session";

export interface ToolContext {
  user: AuthedUser;
  /** The caller's own `sk-relay-…` key, supplied per request and never stored. */
  relayKey?: string;
  /**
   * The account-authenticated path: a credential the user created and switched
   * on, plus the account it spends. Tools call the proxy in-process with it, so
   * no secret is ever involved. See ./credentials for why nothing here is
   * inferred.
   */
  account?: AccountCredential;
  /**
   * Where this gateway is reachable, resolved by the route before the tool loop
   * starts. See `gatewayBase()`.
   */
  gatewayBase?: string;
}

/** A media file the tool produced, for the caller to store and hand a URL back. */
export interface RawArtifact {
  kind: ArtifactKind;
  contentType: string;
  /** The upstream's own link, when it had one. Nothing is copied in that case. */
  url?: string;
  /** Base64, for results the vendor returned inline (images, audio). */
  base64?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /**
   * Media produced, on a side channel rather than inside `content`.
   *
   * That placement is the whole point. A base64 image is megabytes, and a CDN
   * link is a months-long capability handed to a model that will paste it into
   * prose; either one inside `content` would end up in the model's context and
   * in the stored transcript. The turn loop persists these and writes short
   * references into the content instead, so a bug that skipped that step would
   * lose the media rather than leak it.
   */
  artifacts?: RawArtifact[];
}

/**
 * Vendor-mandated values the caller must not be allowed to omit.
 *
 * Each was found by calling the endpoint rather than by reading the spec:
 * MiniMax `t2a_v2` rejects a request with no `voice_id`, both video specs
 * require a duration (V1 accepts only 6 and 10), and V2 also requires an
 * explicit, non-adaptive ratio. A model told the argument was optional will
 * leave it out, and the resulting error names a field it never touched.
 */
const DEFAULT_TTS_VOICE = "English_Trustworth_Man";
const DEFAULT_VIDEO_DURATION = 6;
const DEFAULT_VIDEO_RATIO = "16:9";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Where the gateway is reachable from the server.
 *
 * `config.getPublicUrl()` alone is not enough here. It reads
 * RELAY_PUBLIC_URL, then VERCEL_URL, then localhost — and a self-hosted
 * deployment behind nginx usually sets neither, so it answered
 * "http://localhost:3000" and every `test_gateway_model` call died with
 * "fetch failed" from inside the container.
 *
 * The route resolves the real base with `resolvePublicUrl()`, which can also
 * read the incoming Host header, and passes it in. The config fallback stays
 * for callers outside a request scope (the tests) and is the right answer
 * whenever RELAY_PUBLIC_URL is set, which is still the configuration worth
 * recommending: header-derived addressing is an implicit dependency on the
 * proxy forwarding X-Forwarded-*.
 */
function gatewayBase(ctx: ToolContext): string {
  return ctx.gatewayBase ?? getPublicUrl();
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

/**
 * The same, without the indentation.
 *
 * For a payload whose size is a concern: a full media-spec listing is ~15 KB
 * pretty-printed and ~11 KB compact, and the turn loop truncates a tool result.
 * A truncation lands wherever it lands, and where it landed last time was
 * inside a video spec's `async.poll` — so the model copied a spec with no
 * `statusMap` and the approval rejected it.
 *
 * Indentation is for a person reading a terminal. A model reads JSON.
 */
function okCompact(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
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

  // Media generation needs nothing an ordinary account does not have, so these
  // sit in the user tier: a gateway key and a model id. They were added to the
  // admin list first by mistake, which would have meant a regular user could not
  // generate an image with a key that already works.
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "抓取一个公开网页并读出正文文字。查厂商官方文档、API 参考、报错说明时用它 —— 这些内容不能靠记忆编。用户给了一个网址、或者问题需要看某个具体页面时，先调它再回答。只支持 http/https 的公网地址，内网地址会被拒绝；返回的是正文纯文本，不含图片和脚本。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读的完整网址，例如 https://platform.minimaxi.com/docs/api-reference/image-generation" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "用一个媒体模型生成图片，返回图片 URL。走的是本系统的 /v1/images/generations 端点，消耗用户自己的配额。",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "图片模型名，取自 list_gateway_models 的 mediaModels" },
          prompt: { type: "string", description: "想生成什么画面" },
          size: { type: "string", description: "如 1024x1024；不填则用服务商默认" },
        },
        required: ["model", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_speech",
      description:
        "用语音合成模型把文字读成音频，返回实际生成的字节数与 content-type。走 /v1/audio/speech，消耗用户自己的配额。",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "语音模型名" },
          input: { type: "string", description: "要读出来的文字" },
          voice: {
            type: "string",
            description:
              "音色 id。留空则使用已验证可用的默认值 —— MiniMax 的 t2a_v2 缺少 voice_id 会直接拒绝，" +
              "所以这不是真正可选的。",
          },
        },
        required: ["model", "input"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description:
        "提交一个视频生成任务。视频是异步的：这里只返回任务 id 和当前状态，产物要稍后由上游查询，不要在这里反复重试。",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "视频模型名" },
          prompt: { type: "string", description: "想生成什么画面" },
          duration: { type: "number", description: "时长（秒）；留空用默认值" },
          ratio: { type: "string", description: "画面比例，如 16:9；留空用默认值" },
        },
        required: ["model", "prompt"],
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
        "提出一次聊天服务商配置变更。这不会立刻生效 —— 它生成一份 before/after 对比，等管理员在界面上确认后才执行。baseUrl、优先级、模型映射、Anthropic 面、启用开关都可以改。只能改已存在的服务商，不能新建。",
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
          priority: {
            type: "integer",
            description: "数值越小越优先被选中；并列时取第一个匹配的",
          },
          modelMapping: {
            type: "object",
            description:
              "客户端模型名 → 上游模型名 的【完整】替换表。注意：整份替换，不是增量。想只加一个映射就必须先用 list_providers 拿到现状、合并、再把整张表传回来 —— 只传新增的那一条会把其余所有模型删掉。",
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
        "提出一次媒体服务商配置变更，同样需要管理员确认才执行。可以整份替换 models 与 specs。只能改已存在的媒体服务商，不能新建。",
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string" },
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          baseUrl: { type: "string" },
          models: {
            type: "object",
            description:
              "模型表的【完整】替换。整份替换，不是增量：想加一个模型必须先 list_media_providers 取回现状、合并、再整份传回，否则其余模型会被删掉。",
            additionalProperties: true,
          },
          specs: {
            type: "array",
            description:
              "能力 spec 数组，【完整】替换。整份替换，不是增量：只传一条会让其余能力全部失效。" +
              "而且必须与 list_media_providers 返回的形状逐字一致 —— 那才是校验器接受的形状。" +
              "正确做法：先 list_media_providers 取回现状，整份复制，再只改要改的字段。" +
              "不要自己拼一个「看起来像」的 spec：没有 transport.request / transport.response 的 spec 保存下来也调用不了任何东西。",
            items: { type: "object" },
          },
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
      name: "propose_provider_create",
      description:
        "提出一次「新建聊天服务商」的变更，管理员在界面上确认并补填 API 密钥后才会真正创建。这个工具不接收密钥，也不该向用户索取 —— 密钥由管理员在确认时自己填，所以你提议的内容里绝不能包含任何密钥。同样需要管理员点确认。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "服务商的显示名称" },
          kind: { type: "string", enum: ["openai", "anthropic"], description: "上游协议，默认 openai" },
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          baseUrl: { type: "string", description: "上游 base URL，例如 https://api.minimaxi.com/v1" },
          upstreamFormat: {
            type: "string",
            enum: ["responses", "chat", "anthropic"],
            description: "上游接口风格，默认 responses",
          },
          priority: { type: "integer", description: "数值越小越优先" },
          modelMapping: {
            type: "object",
            description: "客户端模型名 → 上游模型名。新建时这张表就是全部，所以传完整的一份。",
            additionalProperties: { type: "string" },
          },
        },
        required: ["name", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_media_provider_create",
      description:
        "提出一次「新建媒体服务商」的变更，同样需要管理员确认并补填 API 密钥。models 和 specs 是新建时的完整内容，传完整的一份。不要向用户索取密钥。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          baseUrl: { type: "string" },
          priority: { type: "integer" },
          models: {
            type: "object",
            description: "模型表，【完整】的一份。每个值至少要有 upstreamId。",
            additionalProperties: { type: "object" },
          },
          specs: {
            type: "array",
            description:
              "能力 spec 数组。【完整】的一份，并且必须与 list_media_providers 返回的形状逐字一致 —— 那才是校验器接受的形状。" +
              "正确做法：先 list_media_providers 取回现有的 spec，整份复制，再只改要改的字段。",
            items: { type: "object" },
          },
        },
        required: ["name", "summary", "models"],
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
    case "fetch_page":
      return fetchPageTool(args);
    case "generate_image":
      return mediaGenerate(args, ctx, "image");
    case "generate_speech":
      return mediaGenerate(args, ctx, "speech");
    case "generate_video":
      return mediaGenerate(args, ctx, "video");

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
    case "propose_provider_create":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeProviderCreate(args, ctx);
    case "propose_media_provider_create":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeMediaProviderCreate(args, ctx);
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
  if (!ctx.relayKey && !ctx.account) return fail(NO_CREDENTIAL_MESSAGE);

  const prompt =
    typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : "用一句话介绍你自己。";
  const body = {
    model: model.data,
    messages: [{ role: "user" as const, content: prompt }],
    max_tokens: 200,
    stream: false,
  };

  const started = Date.now();

  // Account path: straight into the proxy, with the user's own credential. The
  // same function the public route calls, minus the bearer lookup — there is no
  // token to look up.
  if (ctx.account) {
    try {
      const result = await proxyChatCompletion({
        req: body,
        apiKey: ctx.account.apiKey,
        user: ctx.account.user,
        signal: AbortSignal.timeout(90_000),
      });
      const latencyMs = Date.now() - started;
      if (!result.ok) {
        return ok({
          model: model.data,
          ok: false,
          httpStatus: result.status,
          latencyMs,
          response: JSON.stringify(result.error ?? {}).slice(0, 600),
        });
      }
      const parsed = result.data as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { total_tokens?: number };
      };
      return ok({
        model: model.data,
        ok: true,
        via: "account",
        httpStatus: result.status,
        latencyMs,
        finishReason: parsed.choices?.[0]?.finish_reason ?? null,
        totalTokens: parsed.usage?.total_tokens ?? null,
        answer: (parsed.choices?.[0]?.message?.content ?? "").slice(0, 1200),
      });
    } catch (err) {
      return fail(`调用失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const base = gatewayBase(ctx);
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
      via: "key",
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

/**
 * What to tell the model when a media call fails, keyed by status.
 *
 * Shared by both credential paths so the account path cannot quietly lose the
 * advice that the key path gives — the 400 case in particular exists because a
 * model was observed inventing a cause ("the response format does not match")
 * for an upstream error whose actual text was sitting in the same result.
 */
function mediaFailureHint(status: number): string | undefined {
  if (status === 401 || status === 403) return "密钥无效，或该账号没有这个媒体能力的权限。";
  if (status === 402) return "上游额度用尽（不是权限问题）。原话在 response 里，照它解释。";
  if (status === 404) return "模型名不对，或该媒体服务商没有为这个模型配置 spec。";
  if (status === 400) {
    return (
      "上游的参数校验没过。原话在 response 字段里 —— 照它转述给用户，" +
      "不要猜测原因（例如不要说「返回格式不匹配」，你看不到上游返回了什么）。"
    );
  }
  return undefined;
}

/**
 * Turn engine items into storable artifacts.
 *
 * A `url` item keeps its link and costs nothing to store. A `base64` item is
 * kept inline because that is the only copy that will ever exist — and its
 * content type is a guess, because the item shape does not carry one. That is
 * acceptable only because the inline path is images in practice: audio always
 * arrives as `binary`, which does carry its type, and browsers sniff an image
 * regardless of what the header says.
 */
function artifactsFromItems(
  items: Array<{ kind: string; value: string }>,
  kind: ArtifactKind,
): RawArtifact[] {
  return items.map((item) =>
    item.kind === "url"
      ? { kind, contentType: "application/octet-stream", url: item.value }
      : { kind, contentType: kind === "audio" ? "audio/mpeg" : "image/png", base64: item.value },
  );
}

/**
 * Generate a media artefact with the caller's own credential.
 *
 * Goes out over the same public routes a client would use rather than calling
 * the media engine directly, so a tool result is evidence that the route
 * works — not just that the spec maps. It also means the user's own quota and
 * model permissions apply, which is the point of routing through the gateway
 * at all.
 */
async function mediaGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  kind: "image" | "speech" | "video",
): Promise<ToolResult> {
  const model = z.string().min(1).safeParse(args.model);
  if (!model.success) return fail("缺少 model 参数。");
  if (!ctx.relayKey && !ctx.account) return fail(NO_CREDENTIAL_MESSAGE);

  const prompt = typeof args.prompt === "string" ? args.prompt : typeof args.input === "string" ? args.input : "";
  if (!prompt.trim()) return fail("缺少提示词 / 输入文本。");

  // MiniMax's t2a_v2 rejects a request with no `voice_setting.voice_id`, so a
  // model that omits the optional-looking `voice` argument gets a bare
  // "missing required parameter" it cannot make sense of. Default it here
  // rather than letting the failure reach the conversation.
  const voice = typeof args.voice === "string" && args.voice.trim() ? args.voice.trim() : DEFAULT_TTS_VOICE;
  // Same trap one level up: both video specs require a duration, and H3 also
  // requires an explicit, non-adaptive ratio.
  const duration = typeof args.duration === "number" && args.duration > 0 ? args.duration : DEFAULT_VIDEO_DURATION;
  const ratio = typeof args.ratio === "string" && args.ratio.trim() ? args.ratio.trim() : DEFAULT_VIDEO_RATIO;

  const path =
    kind === "image" ? "/v1/images/generations" : kind === "speech" ? "/v1/audio/speech" : "/v1/videos/generations";
  const payload: Record<string, unknown> =
    kind === "speech"
      ? { model: model.data, input: prompt, response_format: "mp3", voice }
      : kind === "image"
        ? {
            model: model.data,
            prompt,
            n: 1,
            ...(typeof args.size === "string" && args.size.trim() ? { size: args.size.trim() } : {}),
          }
        : { model: model.data, prompt, n: 1, duration, ratio };

  const started = Date.now();

  // Account path: the same handler the public route calls, invoked in-process
  // with the user's own credential. The quota, whitelist and spec checks all
  // still apply because they are the handler's own; the only thing skipped is
  // the bearer lookup, which has no bearer token to do. A tool result therefore
  // proves the handler works but not the route, which is why the route keeps
  // its own tests rather than relying on this.
  if (ctx.account) {
    try {
      const outcome = await executeMediaRequest({
        capability:
          kind === "image" ? "image.generate" : kind === "speech" ? "audio.tts" : "video.generate",
        input: {
          model: model.data,
          prompt,
          ...(typeof args.size === "string" && args.size.trim() ? { size: args.size.trim() } : {}),
          extra: payload,
        },
        apiKey: ctx.account.apiKey,
        user: ctx.account.user,
        signal: AbortSignal.timeout(240_000),
      });
      const latencyMs = Date.now() - started;
      if (!outcome.ok) {
        return ok({
          ok: false,
          via: "account",
          httpStatus: outcome.error.status,
          latencyMs,
          response: JSON.stringify(outcome.error).slice(0, 1000),
          hint: mediaFailureHint(outcome.error.status),
        });
      }
      const items = await resultItems(outcome.value.result);
      // The kind comes from the tool, never from a fallback expression.
      // `resultItems` normalises both shapes an upstream can return — a url item
      // and a `binary` result, which it converts to a base64 item — so there is
      // one mapping to do, and deriving it from anything but the requested
      // capability is how a synthesised voice ends up labelled as a video.
      const artifactKind: ArtifactKind = kind === "image" ? "image" : kind === "speech" ? "audio" : "video";
      return {
        ...ok({
          ok: true,
          via: "account",
          httpStatus: 200,
          latencyMs,
          itemCount: items.length || outcome.value.result.successCount,
        }),
        artifacts: artifactsFromItems(items, artifactKind),
      };
    } catch (err) {
      return fail(`调用失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const res = await fetch(`${gatewayBase(ctx)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.relayKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(240_000),
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return ok({
        ok: false,
        via: "key",
        httpStatus: res.status,
        latencyMs,
        response: text.slice(0, 1000),
        hint: mediaFailureHint(res.status),
      });
    }

    if (kind === "speech") {
      // The endpoint answers with bytes. Measuring them and then throwing them
      // away is what left the user with a byte count and no way to hear it, so
      // they go on the side channel where the conversation can keep them.
      const buffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "audio/mpeg";
      return {
        ...ok({
          ok: true,
          via: "key",
          httpStatus: res.status,
          latencyMs,
          audioBytes: buffer.byteLength,
          contentType,
        }),
        artifacts: [
          { kind: "audio", contentType, base64: Buffer.from(new Uint8Array(buffer)).toString("base64") },
        ],
      };
    }

    const json: unknown = await res.json().catch(() => null);
    if (kind === "image") {
      const data = (json as { data?: Array<Record<string, unknown>> })?.data ?? [];
      const items = data.map((d) =>
        typeof d?.url === "string"
          ? { kind: "url", value: d.url }
          : { kind: "base64", value: typeof d?.b64_json === "string" ? d.b64_json : "" },
      );
      return {
        ...ok({ ok: items.length > 0, via: "key", httpStatus: res.status, latencyMs, itemCount: items.length }),
        artifacts: artifactsFromItems(items, "image"),
      };
    }
    const itemCount = ((json as { data?: unknown[] })?.data ?? []).length;
    return {
      ...ok({ ok: true, via: "key", httpStatus: res.status, latencyMs, itemCount }),
      artifacts: artifactsFromItems(
        ((json as { data?: Array<Record<string, unknown>> })?.data ?? []).map((d) => ({
          kind: "url",
          value: typeof d?.url === "string" ? d.url : "",
        })),
        "video",
      ),
    };
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

/**
 * The specs exactly as they are stored.
 *
 * This used to hand over a summary — `capability`, `displayName`, and
 * `method`/`path` hoisted out of the `transport` object they actually live in,
 * with `request`, `response` and `auth` omitted. The model then proposed specs
 * in that shape, because it had only ever seen that shape, and the approval
 * failed with a refusal that said nothing about why. Three times.
 *
 * A spec is a document the model has to reproduce, not a row to be skimmed, so
 * what it is shown is what it must send back. If this ever needs to be
 * shortened, the cut has to be something the write tool also accepts.
 */
function specForTheModel(spec: unknown): unknown {
  return spec;
}

async function listMediaProvidersTool(): Promise<ToolResult> {
  const media = await listMediaProviders();
  // Compact, not pretty: this payload is the biggest one any tool returns and
  // it has to survive the turn loop's truncation whole, because half a spec is
  // worse than a summary — it is a spec that looks complete and calls nothing.
  return okCompact(
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
      specs: (m.specs ?? []).map(specForTheModel),
    })),
  );
}async function proposeProviderUpdate(
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
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    patch.priority = args.priority;
  }
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

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderProviderDiff(provider, patch, summary);

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

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderMediaDiff(provider, patch, summary);

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

/**
 * Propose a brand-new chat provider.
 *
 * **There is no `apiKey` parameter, and that is the whole design.** A key the
 * model handled would be a key in the conversation, in the tool-call arguments
 * persisted beside it, and in `assistant_actions` — three copies of a secret in
 * a place none of them are encrypted. Instead the admin types it into the
 * approval, where it goes straight to the provider row and is encrypted on the
 * way in.
 *
 * So this tool's job is everything *except* the key, and the diff has to say so
 * — a card that looked complete and then needed a field the reader could not
 * see is the same misread as everything else in this round.
 */
async function proposeProviderCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Refused out loud rather than quietly dropped. The whitelist below already
  // makes it impossible to *store* a key here, but a model that put one in the
  // call has already put it in the persisted tool-call row — so the refusal is
  // the model learning not to do that a second time.
  if ("apiKey" in args || "api_key" in args) {
    return fail(
      "不要在工具参数里放 API 密钥。这个工具不接收它，管理员会在确认界面上自己填。你也不该向用户索取密钥。",
    );
  }

  // Trimmed *before* the length check, not after. `"   "` satisfies
  // `min(1)` and then trims to nothing, which is how a provider ends up with a
  // blank name in the admin's list — created the moment they approve, and with
  // nothing to pick it out by. The same bug once shipped as a 404 on an
  // all-whitespace thread title.
  const name = z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(120)).safeParse(args.name);
  if (!name.success) return fail("缺少 name。");

  const spec: Record<string, unknown> = { name: name.data };
  if (typeof args.kind === "string") spec.kind = args.kind;
  if (typeof args.baseUrl === "string") spec.baseUrl = args.baseUrl.trim();
  if (typeof args.upstreamFormat === "string") spec.upstreamFormat = args.upstreamFormat;
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    spec.priority = args.priority;
  }
  if (args.modelMapping && typeof args.modelMapping === "object") {
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.modelMapping as Record<string, unknown>)) {
      if (typeof v === "string") mapping[k] = v;
    }
    if (Object.keys(mapping).length === 0) return fail("modelMapping 是空的。");
    spec.modelMapping = mapping;
    // Same reason the update path does this: a mapped model with no config
    // falls back to a generic context window, which is how a 200k model ends
    // up advertised as 1M.
    const configs: Record<string, unknown> = {};
    for (const [client, upstream] of Object.entries(mapping)) {
      const known = knownModelOrDefault(upstream);
      configs[client] = {
        upstreamId: upstream,
        clientId: client,
        displayName: client,
        contextLength: known.context,
        maxOutputTokens: known.output,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      };
    }
    spec.modelConfigs = configs;
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.create",
    summary,
    args: spec,
    diff: renderCreateDiff(spec, summary),
  });

  return ok({
    actionId: action.id,
    status: "pending",
    message:
      "新建请求已生成。还需要管理员在界面上补填 API 密钥并确认，才会产生服务商。请把下面这份内容告诉用户，并说明密钥由管理员自己填。",
    diff: renderCreateDiff(spec, summary),
  });
}

async function proposeMediaProviderCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if ("apiKey" in args || "api_key" in args) {
    return fail(
      "不要在工具参数里放 API 密钥。这个工具不接收它，管理员会在确认界面上自己填。你也不该向用户索取密钥。",
    );
  }

  const name = z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(120)).safeParse(args.name);
  if (!name.success) return fail("缺少 name。");
  if (!args.models || typeof args.models !== "object") {
    return fail("缺少 models。新建媒体服务商必须给出模型表。");
  }

  const models = args.models as Record<string, unknown>;
  if (Object.keys(models).length === 0) return fail("models 是空的。");
  for (const [id, cfg] of Object.entries(models)) {
    if (!cfg || typeof cfg !== "object") return fail(`模型 ${id} 的配置不是对象。`);
    if (typeof (cfg as { upstreamId?: unknown }).upstreamId !== "string") {
      return fail(`模型 ${id} 缺少 upstreamId。`);
    }
  }

  const spec: Record<string, unknown> = { name: name.data, models };
  if (typeof args.baseUrl === "string") spec.baseUrl = args.baseUrl.trim();
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    spec.priority = args.priority;
  }
  if (Array.isArray(args.specs)) spec.specs = args.specs;

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderCreateDiff(spec, summary);
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "media_provider.create",
    summary,
    args: spec,
    diff,
  });

  return ok({
    actionId: action.id,
    status: "pending",
    message:
      "新建请求已生成。还需要管理员在界面上补填 API 密钥并确认，才会产生服务商。请把下面这份内容告诉用户。",
    diff,
  });
}

/**
 * The before/after a create shows: nothing, then everything.
 *
 * Written by hand rather than reused from the update path because there is no
 * "before" — and the one line that is *not* in the table is the line that
 * matters, so it is stated in the table rather than left to be discovered at
 * the approval.
 */
function renderCreateDiff(spec: Record<string, unknown>, summary: string): string {
  const lines = [`新增：${summary}`, ""];
  for (const [key, value] of Object.entries(spec)) {
    if (key === "modelConfigs" || key === "specs") {
      const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
      lines.push(`  ${key}：${count} 项`);
      continue;
    }
    if (key === "modelMapping") {
      for (const [client, upstream] of Object.entries(value as Record<string, string>)) {
        lines.push(`  modelMapping.${client} → ${upstream}`);
      }
      continue;
    }
    lines.push(`  ${key}：${JSON.stringify(value)}`);
  }
  lines.push("");
  lines.push("  apiKey：（不在这份提议里）批准时由管理员在界面上填写");
  return lines.join("\n");
}

async function listUsersTool(): Promise<ToolResult> {  const { users } = await listUsers({ limit: 200 });
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

/**
 * Read a public web page.
 *
 * Available to both tiers: reading a vendor's documentation is not an
 * administrative act, and the model that cannot check a spec is the model that
 * guesses one. The address checks live in `web-fetch` — the point of routing
 * through it rather than calling `fetch` here is that they are the feature.
 *
 * A refusal comes back as a *result*, not an exception. "That URL is on the
 * private network" is a fact the model can report and work around; an
 * exception would end the turn and lose whatever it had already established.
 */
async function fetchPageTool(args: Record<string, unknown>): Promise<ToolResult> {
  const url = z.string().min(1).max(2000).safeParse(args.url);
  if (!url.success) return fail("缺少 url。");
  try {
    const page = await fetchPage(url.data);
    return ok({
      url: page.finalUrl,
      status: page.status,
      contentType: page.contentType || "text/plain",
      bytes: page.bytes,
      truncated: page.truncated,
      text: page.text,
    });
  } catch (err) {
    if (err instanceof WebFetchError) return fail(err.message);
    return fail(`抓取失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Exposed for the test route so it resolves a model the same way the proxy does. */
export async function findMediaModel(model: string) {
  return resolveMediaProviderForModel(model);
}
