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
import { createAssistantAction, listAssistantActions } from "../db/assistant";
import { getPublicUrl } from "../config";
import { knownModelOrDefault } from "../providers/known-models";
import { decryptSecret } from "../crypto/secrets";
import { renderProviderDiff, renderMediaDiff, renderDocPagesDiff } from "./diff";
import { ASSISTANT_PAGE_READ_LIMIT } from "./docs-reader";
import { getSettings } from "../db/settings";
import { parseTextSpec, readTextSpec } from "../protocol/text-spec";
import { validateTextSpecs, SURFACES, faceOf } from "../protocol/text-specs";
import {
  TEXT_PROTOCOL_PRESETS,
  TEXT_PROTOCOL_LABELS,
  CONFIGURABLE_PROTOCOLS,
} from "../protocol/text-protocols";
import { DEPLOYMENT_NOTES } from "./deployment-notes";
import { fetchPage, WebFetchError } from "./web-fetch";
import { createDocReader } from "./docs-reader";
import { DEFAULT_LOCALE, type Locale } from "../i18n/dict";
import type { DocPage } from "../docs/custom";
import { NO_CREDENTIAL_MESSAGE, type AccountCredential } from "./credentials";
import { executeMediaRequest, resultItems } from "../media/handler";
import { proxyChatCompletion } from "../proxy/openai";
import { getAssistantArtifact } from "../db/assistant-artifacts";
import type { ArtifactKind } from "../db/assistant-artifacts";
import type { MessageAttachment } from "./schema";
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
  /**
   * The files attached to the turn in flight.
   *
   * Here so that "use the picture the user just sent me" is something a tool
   * can be told, rather than something the model would have to paste a
   * megabyte of base64 to express. See `resolveReferenceImage`.
   */
  attachments?: MessageAttachment[];
  /**
   * The reader's language, resolved by the route before the stream opened.
   *
   * Passed in rather than read here because the tool loop runs inside a stream
   * callback, where `next/headers` no longer resolves — the same constraint the
   * route already works around for the public URL. A documentation tool that
   * answered in the wrong language would be worse than none.
   */
  locale?: Locale;
  /**
   * Whether the caller may read the admin documentation.
   *
   * The admin docs describe this deployment's internals — providers, quota,
   * routing. A regular user reading them through a model that summarises on
   * request is a different thing from an admin who can already open the page.
   */
  canReadAdminDocs?: boolean;
  /**
   * The operator's own documentation pages, resolved by the route.
   *
   * Same reason as the locale: they come from the settings table, and the tool
   * loop runs where `next/headers` no longer resolves. Passed in so one turn
   * reads them once rather than once per call.
   */
  docPages?: DocPage[];
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
      name: "read_docs",
      description:
        "读本系统自己的文档正文 —— 和用户界面上 /docs、/dashboard/docs、/admin/docs 显示的是同一份。\n" +
        "不带 topic 返回目录；带 topic 返回那一页的全文。\n" +
        "凡是问「这个系统怎么用」「这个接口怎么调」「这个配置项是什么意思」「为什么报这个错」，" +
        "都要先读文档再回答，不要凭记忆作答。管理员文档只有管理员能读。",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "不填则返回目录。填写形如 openai、anthropic、media、providers、trouble、mapping。" +
              "也可以写 user:openai 或 admin:providers 指定是哪一套。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "用一个媒体模型生成图片，返回图片 URL。走的是本系统的 /v1/images/generations 端点，消耗用户自己的配额。\n" +
        "图生图（以图为参考）用 image 参数：填 attachment 表示「用用户这条消息里附的那张图」，" +
        "或直接给一个 http(s) 图片网址。服务商是否支持图生图取决于它的 spec，" +
        "先用 list_media_providers 看该模型的 spec 里 metadata.modes 有没有 image-to-image。",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "图片模型名，取自 list_gateway_models 的 mediaModels" },
          prompt: { type: "string", description: "想生成什么画面" },
          size: { type: "string", description: "如 1024x1024；不填则用服务商默认" },
          ratio: {
            type: "string",
            description: "宽高比，如 16:9、9:16。服务商通常按尺寸表把它换算成实际尺寸。",
          },
          image: {
            type: "string",
            description:
              "参考图。填 attachment 表示用用户这条消息里附的图片；也可以给一个 http(s) 图片网址。" +
              "不填就是文生图。这个工具不接收 base64。",
          },
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
      name: "transcribe_audio",
      description:
        "把一段语音转成文字。传 attachment（用户这一条消息里附的音频）、一个 http(s) 音频网址，" +
        "或一个 data URL。走 /v1/audio/transcriptions，消耗用户自己的配额，返回识别出的文本。\n" +
        "如果用户发来的是音频而你在找别的办法，先用这个 —— 网关已经配好了 ASR 模型，" +
        "不需要让用户自己去发请求。",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "语音识别模型名，例如 asr-1.0" },
          audio: {
            type: "string",
            description:
              "attachment、http(s) 音频网址，或 data URL。",
          },
          language: {
            type: "string",
            description: "音频主要语言，可留空。中文例如 zh。",
          },
        },
        required: ["audio"],
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
      name: "list_my_proposals",
      description:
        "列出你（当前用户）提交过的配置变更提案，以及每一条现在是待确认、已生效还是被拒绝。\n" +
        "**你在界面上点过确认之后，用这个来核实**，不要靠猜：propose_* 只是把变更放进待确认队列，" +
        "你自己看不到队列状态，所以之前几次只能说「不知道有没有生效」。\n" +
        "确认后再用 list_providers 读回配置，两个一对比就知道改动到底落下没有。",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "只看某一种状态：pending（待确认）/ applied（已生效）/ rejected（被拒绝）/ failed（应用失败）。省略则全部返回。",
            enum: ["pending", "applied", "rejected", "failed"],
          },
        },
        additionalProperties: false,
      },
    },
  },
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
        "提出一次聊天服务商配置变更。这不会立刻生效 —— 它生成一份 before/after 对比，等管理员在界面上确认后才执行。" +
        "可改：API 地址、上游格式（responses/chat）、请求头、优先级、模型映射、两个协议面、启用开关、每个兼容接口的参数规则（textSpecs）。" +
        "只能改已存在的服务商，不能新建。",
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
          textSpecs: {
            type: "array",
            description:
              "上游协议文档列表，【按 protocol 合并】：同名的替换、没提到的保留、" +
              "传 null 清空全部。所以给某一个接口加规则不用重发另外两个。\n" +
              "不确定该选哪个 protocol，先调 list_text_protocols，不要凭印象写。\n" +
              "只有厂商确实和 OpenAI 兼容接口不一样时才需要写；'大多数厂商什么都不用配'。\n" +
              "protocol 只能取那三个接口之一，而且对应协议面必须是开的，否则规则不会生效。",
            items: {
              type: "object",
              properties: {
                specVersion: { type: "integer" },
                protocol: { type: "string" },
                parameters: { type: "object" },
                request: { type: "object" },
                response: { type: "object" },
                errors: { type: "array", items: { type: "object" } },
                limits: { type: "object" },
              },
              required: ["specVersion", "protocol"],
              additionalProperties: true,
            },
          },
          headers: {
            type: "object",
            description:
              "附在上游请求上的固定请求头，整份替换，传 null 清空。" +
              "例如 {\"api-version\": \"2024-08-01-preview\"}。" +
              "只有 Azure 一类要求固定头的厂商才需要。",
            additionalProperties: { type: "string" },
          },
          upstreamFormat: {
            type: "string",
            description:
              "OpenAI 侧上游说的是哪种协议：responses（原生，/v1/responses 原样透传）或 chat。" +
              "注意 chat→responses 没有请求转换：客户端调 /v1/chat/completions 时永远发往 <API 地址>/chat/completions。",
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
      name: "list_text_protocols",
      description:
        "列出可配置的文本协议预设和参数策略的六种模式，配使用建议。\n" +
        "配置服务商前如果不确定该选哪个协议、或者不知道某个参数该 passthrough 还是 clamp，先调这个 —— 不要凭印象写 protocol。\n" +
        "绝大多数 OpenAI 兼容中转选 openai-chat 就够了，什么都不用改。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_model_config_update",
      description:
        "提出一次【单个模型】的配置变更，需要管理员确认才执行。\n" +
        "改的是网关真实生效的东西：上下文长度、最大输出、思考等级、积分价格、是否启用、显示名、上游模型名。\n" +
        "思考等级是**本部署声明**的，不是自动检测出来的：查厂商官方文档确认这个模型接受哪几档，再照原样写进 reasoningLevels；厂商文档里没有就留空数组。\n" +
        "文档里显示的上下文和价格读的就是这些值，所以改这里等于同时改文档。\n" +
        "媒体模型（图片/视频/语音）由 spec 驱动，这里改不了，请用 propose_media_provider_update。",
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "该模型所属的服务商 id，用 list_providers 查" },
          clientId: { type: "string", description: "客户端在 model 字段里填的模型名" },
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          displayName: { type: "string" },
          upstreamId: { type: "string" },
          contextLength: { type: "integer", description: "上下文长度（输入 token 上限）" },
          maxOutputTokens: { type: "integer" },
          reasoningLevels: {
            type: "array",
            items: { type: "string" },
            description:
              "这个模型接受的思考等级，照厂商文档的原样写，不要翻译也不要归一化。例：MiniMax-M3.1-Flash-Preview 接受 low, medium, high, xhigh, max。空数组 = 这个模型不支持思考等级。先查官方文档确认再写，不确定就别写。\n" +
              "注意：这个字段是**界面上给用户选的档位**，不是「能不能关思考」。同一个模型可能档位写了五档、却一个都关不掉（发 disabled 直接 400），也可能档位根本不调深度、真正的开关在另一个字段上。分不清就照文档写档位，别把开关混进来。",
          },
          reasoningEffortSupported: {
            type: "boolean",
            description:
              "这个模型是否支持 reasoning_effort 思考等级。\n" +
              "**厂商文档明确写了它不读这个参数，就填 false**（例：MiniMax-M3 只有 thinking 开关，" +
              "reasoning_effort 会被直接忽略）。填 false 之后，助手设置里对应的下拉会置灰——" +
              "因为那是一个选了、存了、发出去了、但完全不生效的控件。\n" +
              "不确定就**不要传**：没声明过和声明过「不支持」是两回事，只有传了才会置灰。",
          },
          inputCost: { type: "number", description: "每 100 万输入 token 的积分" },
          outputCost: { type: "number", description: "每 100 万输出 token 的积分" },
          cachedInputCost: {
            type: "number",
            description:
              "每 100 万「命中上游提示缓存」的输入 token 的积分。不填 = 按 inputCost 算（安全默认，老模型不受影响）；填 0 = 缓存命中免费。读和写分开，因为厂商一个免费、一个加价。",
          },
          cacheWriteCost: {
            type: "number",
            description: "每 100 万「写入」上游提示缓存的输入 token 的积分。不填 = 按 inputCost 算。",
          },
          enabled: { type: "boolean", description: "false = 网关不再路由到这个模型，客户端会 404" },
        },
        required: ["providerId", "clientId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_doc_pages",
      description:
        "提出一次【参数指南页面】的变更，需要管理员确认才执行。\n" +
        "这些页面构成读者文档里的「参数指南」——和「接入指南」是并列的两本，接入指南讲怎么接上，参数指南讲每个参数有哪些值。\n" +
        "适合写音色列表、尺寸与取值范围、字段含义这类要反复回来查的东西；限流和使用约定不属于这里。\n" +
        "**写的是本部署映射之后的接口，不是上游厂商的原生接口。** 厂商文档用来确认上游的字段名和取值，\n" +
        "接口路径、我们转发和不转发什么、哪些转换是我们做的——这些必须来自 read_docs 和 list_providers。\n" +
        "把厂商原生接口照抄进来，用户照着调就会踩坑。\n" +
        "每页正文很长（一张音色表就三百多行），所以一页只写一类，别把整本塞进一页。\n" +
        "pages 是【完整】替换，不是增量：只发新加的那一页会把其余所有页面删掉。想加一页必须先用 list_doc_pages 拿回现状、合并、再整份传回。\n" +
        "id 会变成读者能收藏的锚点，一旦发布就不要改；id 只能是小写字母、数字和中划线。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "一句话说明这次变更的目的" },
          pages: {
            type: "array",
            description: "完整的页面列表。顺序就是读者看到的顺序。",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "URL 锚点，小写字母/数字/中划线，发布后不要改" },
                title: { type: "string" },
                body: { type: "string", description: "Markdown 正文" },
                hidden: { type: "boolean", description: "true = 草稿，读者看不到" },
                order: { type: "integer" },
              },
              required: ["id", "title", "body"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "pages"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_doc_pages",
      description:
        "读回当前【参数指南】的页面。改之前必须先调这个 —— " +
        "propose_doc_pages 是整份替换，不知道现状就改会把页面全删掉。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_media_provider_update",
      description:
        "提出一次媒体服务商配置变更，同样需要管理员确认才执行。只能改已存在的媒体服务商，不能新建。\n" +
        "改已有 spec 的字段请用 specEdits（按下标指明、只写要改的字段），不要把整个 specs 数组重发一遍 —— 数组有十几 KB，重发极易在传输中损坏。\n" +
        "只有新增或删除整个能力 spec 时才用 specs。",
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
          specEdits: {
            type: "array",
            description:
              "推荐用法：按下标修改已有 spec 的字段。只写要改的字段，其余原样保留。" +
              "下标从 list_media_providers 返回的 specs 数组顺序数起（从 0 开始）。" +
              "这样你不需要重发整个 spec，也就不会把它写坏。",
            items: {
              type: "object",
              properties: {
                index: { type: "integer", description: "要修改的 spec 在现有列表中的下标，从 0 开始" },
                displayName: { type: "string" },
                enabled: { type: "boolean" },
                models: { type: "array", items: { type: "string" } },
              },
              required: ["index"],
              additionalProperties: true,
            },
          },
          specs: {
            type: "array",
            description:
              "【完整】替换整个 specs 数组。只在新增或删除整个能力 spec 时用；改字段请用 specEdits。" +
              "重发整个数组有十几 KB，在传输中损坏过（模型会写出 _request 这种不存在的字段），" +
              "而损坏的 JSON 解析出来是空对象，管理员只会看到一个没有理由的失败。",
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
    case "read_docs":
      return readDocsTool(args, ctx);
    case "fetch_page":
      return fetchPageTool(args);
    case "generate_image":
      return mediaGenerate(args, ctx, "image");
    case "generate_speech":
      return mediaGenerate(args, ctx, "speech");
    case "transcribe_audio":
      return transcribeAudio(args, ctx);
    case "generate_video":
      return mediaGenerate(args, ctx, "video");

    // ---- admin only ----------------------------------------------------
    case "list_my_proposals":
      return listMyProposals(args, ctx);
    case "list_providers":
      if (!isAdmin) return fail("这是管理员功能。");
      return listProvidersTool();
    case "list_text_protocols":
      if (!isAdmin) return fail("这是管理员功能。");
      return listTextProtocolsTool();
    case "probe_provider_host":
      if (!isAdmin) return fail("这是管理员功能。");
      return probeProviderHost(args);
    case "list_media_providers":
      if (!isAdmin) return fail("这是管理员功能。");
      return listMediaProvidersTool();
    case "propose_provider_update":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeProviderUpdate(args, ctx);
    case "propose_model_config_update":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeModelConfigUpdate(args, ctx);
    case "list_doc_pages":
      if (!isAdmin) return fail("这是管理员功能。");
      return listDocPagesTool();
    case "propose_doc_pages":
      if (!isAdmin) return fail("这是管理员功能。");
      return proposeDocPages(args, ctx);
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
/**
 * The documentation the reader can see, in their own language.
 *
 * A refusal comes back as a result, not an exception: "that page is admin-only"
 * is something the model can report, where an exception ends the turn and
 * loses whatever it had already established.
 */
function readDocsTool(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const locale = ctx.locale ?? DEFAULT_LOCALE;
  const isAdmin = ctx.user.role === "admin";
  const canReadAdmin = ctx.canReadAdminDocs ?? isAdmin;
  const reader = createDocReader(ctx.docPages);

  const topic = typeof args.topic === "string" ? args.topic.trim() : "";
  if (!topic) {
    return ok({
      note: "不带 topic 时这是目录。要读哪一页，把它的 topic 再传进来。",
      userDocs: reader.index.filter((e) => e.surface === "user"),
      adminDocs: canReadAdmin
        ? reader.index.filter((e) => e.surface === "admin")
        : "（管理员文档只有管理员能读）",
    });
  }

  const wantsAdmin = topic.toLowerCase().startsWith("admin");
  if (wantsAdmin && !canReadAdmin) {
    return fail("admin: 文档只有管理员能读。你是普通用户看不到这一页。");
  }

  const result = reader.read(topic, locale, wantsAdmin ? "admin" : "user");
  if (!result.ok) {
    return fail(`${result.reason}${result.available ? `\n可用：${result.available.map((a) => a.topic).join(", ")}` : ""}`);
  }
  return ok({ topic: result.topic, title: result.title, truncated: result.truncated, text: result.text });
}

/**
 * The reference image, in whatever form the caller gave it.
 *
 * A vendor's spec asks for a data URL (or a URL it can fetch), so the tool has
 * to end up with one. Three ways in:
 *
 *   - the literal `attachment`, meaning the picture the user attached to this
 *     message. This is the case that matters: a model that can see an image in
 *     its context but cannot name it in a tool call can do text-to-image and
 *     not image-to-image, and then falls back to telling the user to use curl.
 *   - an http(s) URL, passed through. Also how most vendors want a reference.
 *   - a data URL, passed through.
 *
 * The bytes come from `assistant_artifacts`, which is the same store the
 * conversation renders from and which is owner-scoped — so a tool cannot reach
 * a picture the user did not attach to this turn.
 */

/** Above this, the base64 body is a liability rather than a payload. */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

const ATTACHMENT_ALIASES = new Set(["attachment", "@attachment", "上传的图片", "附件"]);

export async function resolveReferenceImage(
  value: string,
  ctx: ToolContext,
): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
  const raw = value.trim();
  if (!raw) return { ok: false, reason: "image 是空的。" };

  if (raw.startsWith("data:")) return { ok: true, dataUrl: raw };

  if (/^https?:\/\//i.test(raw)) {
    return { ok: true, dataUrl: raw };
  }

  if (!ATTACHMENT_ALIASES.has(raw)) {
    return {
      ok: false,
      reason:
        "image 只接受三种写法：attachment（用用户这一条消息里附的图片）、一个 http(s) 图片网址、或者一个 data URL。",
    };
  }

  const pictures = (ctx.attachments ?? []).filter((a) => a.kind === "image");
  if (pictures.length === 0) {
    return { ok: false, reason: "这一条消息里没有附上图片，所以没有可用的参考图。" };
  }
  // Newest wins: the user may have sent a correction.
  const attachment = pictures[pictures.length - 1];

  const stored = await getAssistantArtifact(attachment.id, ctx.user.id);
  if (!stored?.bytes) {
    return { ok: false, reason: `附件 ${attachment.name} 已经读不出来了，请重新发一次。` };
  }
  if (stored.bytes.byteLength > MAX_REFERENCE_BYTES) {
    return {
      ok: false,
      reason: `附件 ${attachment.name} 有 ${(stored.bytes.byteLength / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB 的参考图上限。`,
    };
  }
  return {
    ok: true,
    dataUrl: `data:${attachment.contentType};base64,${Buffer.from(stored.bytes).toString("base64")}`,
  };
}

/**
 * Told at the moment it matters.
 *
 * The rule is in the system prompt, and it was in the system prompt and the
 * model pasted the addresses anyway — twice glued into one that does not
 * resolve, while the panel above already showed both pictures. This lands
 * immediately after the call, which is the moment the decision is made.
 */
const ARTIFACT_NOTE =
  "图片/音频已经渲染在工具结果里了。不要把 artifacts 里的地址写进回答，多个地址更不要连在一起写。" +
  "像素尺寸这里没有给，界面上会显示，不要猜，也不要把 spec 里的请求尺寸当成出图结果。";

/**
 * The audio a caller means, as a data URL.
 *
 * The same three shapes `resolveReferenceImage` takes, for the same reason: a
 * model should be able to say "the audio the user just sent" rather than paste
 * a megabyte of base64 into a tool call.
 */
async function resolveReferenceAudio(
  value: string,
  ctx: ToolContext,
): Promise<{ ok: true; dataUrl: string; name: string } | { ok: false; reason: string }> {
  const raw = value.trim();
  if (!raw) return { ok: false, reason: "audio 是空的。" };
  if (raw.startsWith("data:") || /^https?:\/\//i.test(raw)) {
    return { ok: true, dataUrl: raw, name: "音频" };
  }
  if (!ATTACHMENT_ALIASES.has(raw)) {
    return {
      ok: false,
      reason:
        "audio 只接受三种写法：attachment（用用户这一条消息里附的音频）、一个 http(s) 音频网址、或者一个 data URL。",
    };
  }

  const clips = (ctx.attachments ?? []).filter((a) => a.kind === "audio");
  if (clips.length === 0) {
    return {
      ok: false,
      reason:
        "这一条消息里没有附上音频。如果用户是用文件选的（而不是麦克风），请让他用输入框旁边的语音按钮再发一次。",
    };
  }
  // Newest wins, same as the picture case: the user may have sent a correction.
  const attachment = clips[clips.length - 1];
  const stored = await getAssistantArtifact(attachment.id, ctx.user.id);
  if (!stored?.bytes) {
    return { ok: false, reason: `附件 ${attachment.name} 已经读不出来了，请重新发一次。` };
  }
  return {
    ok: true,
    name: attachment.name,
    dataUrl: `data:${stored.contentType || attachment.contentType || "audio/mpeg"};base64,${Buffer.from(stored.bytes).toString("base64")}`,
  };
}

/**
 * Speech to text.
 *
 * The assistant could already generate images, speech and video, and was asked
 * to read an audio file it had been handed. It had no tool for it, so it
 * explained the endpoint to the user and told them to post it themselves — while
 * the gateway already had an `audio.stt` spec configured and the file was
 * sitting in the message it was reading.
 */
async function transcribeAudio(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.relayKey && !ctx.account) return fail(NO_CREDENTIAL_MESSAGE);
  const model = z.string().min(1).safeParse(args.model);
  if (!model.success) {
    // A missing model is a question with an answer in this deployment, not
    // something to send upstream and read a 400 about.
    const stt = await listSttModels();
    if (stt.length === 0) {
      return fail(
        "这个网关还没有配置语音识别模型。请在「媒体服务商」里给某个服务商加一个 audio.stt 的协议（例如 MiniMax 的 asr-1.0）。",
      );
    }
    return fail(`请指定语音识别模型。可选：${stt.join("、")}。`);
  }

  const resolved = await resolveReferenceAudio(
    typeof args.audio === "string" ? args.audio : "attachment",
    ctx,
  );
  if (!resolved.ok) return fail(resolved.reason);

  if (!ctx.account) {
    // The account path is the only one that can read a stored attachment
    // without a bearer token, and every other media tool resolves the same way.
    return fail(NO_CREDENTIAL_MESSAGE);
  }

  const language = typeof args.language === "string" ? args.language.trim() : "";
  const started = Date.now();
  const outcome = await executeMediaRequest({
    capability: "audio.stt",
    input: {
      model: model.data,
      // The same slot and the same data URL the public
      // `/v1/audio/transcriptions` route uses, so a spec resolves this the same
      // way whichever door the request came through.
      image: resolved.dataUrl,
      extra: { audio: resolved.dataUrl, filename: resolved.name, ...(language ? { language } : {}) },
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

  const text = (outcome.value.result.text ?? "").trim();
  return ok({
    ok: true,
    via: "account",
    httpStatus: 200,
    latencyMs,
    model: model.data,
    source: resolved.name,
    text,
    // So the caller can put it in a message rather than describe it.
    message: text || "没有识别到内容。",
  });
}

/** The speech-to-text models this deployment can actually reach. */
async function listSttModels(): Promise<string[]> {
  const rows = await listMediaProviders();
  const ids = new Set<string>();
  for (const p of rows) {
    for (const spec of p.specs ?? []) {
      if (spec.capability === "audio.stt") {
        for (const m of spec.models ?? []) ids.add(m);
      }
    }
  }
  return [...ids];
}

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

  // Image-to-image, when the caller asked for it. A spec decides what a
  // reference turns into — MiniMax wraps it in `subject_reference`, others
  // take it raw — so the only thing this has to get right is handing it over.
  let reference: string | undefined;
  if (kind === "image" && typeof args.image === "string" && args.image.trim()) {
    const resolved = await resolveReferenceImage(args.image, ctx);
    if (!resolved.ok) return fail(resolved.reason);
    reference = resolved.dataUrl;
  }

  const payload: Record<string, unknown> =
    kind === "speech"
      ? { model: model.data, input: prompt, response_format: "mp3", voice }
      : kind === "image"
        ? {
            model: model.data,
            prompt,
            n: 1,
            ...(typeof args.size === "string" && args.size.trim() ? { size: args.size.trim() } : {}),
            // A spec's size table maps dimensions onto a ratio, so a ratio the
            // caller asked for is something the spec can resolve. Sent beside
            // `size` because a spec honours one or the other, not both.
            ...(typeof args.ratio === "string" && args.ratio.trim() ? { ratio: args.ratio.trim() } : {}),
            ...(reference ? { image: reference } : {}),
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
          note: ARTIFACT_NOTE,
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
        ...ok({
          ok: items.length > 0,
          via: "key",
          httpStatus: res.status,
          latencyMs,
          itemCount: items.length,
          note: ARTIFACT_NOTE,
        }),
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

/**
 * The proposals this user has submitted and where each of them stands.
 *
 * Added because the model could propose a change and then had no way to find out
 * whether it had happened. It answered "still pending" on the strength of a
 * config read that simply did not include the changed fields — a guess, dressed
 * as a finding, and wrong in the direction that matters. A tool that reports the
 * queue is the difference between "I don't know" and "not yet".
 */
async function listMyProposals(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const status = args.status;
  if (status !== undefined && typeof status !== "string") {
    return fail("status 只能是字符串。");
  }
  const parsed = status as
    | "pending"
    | "applied"
    | "rejected"
    | "failed"
    | undefined;
  if (parsed !== undefined && !["pending", "applied", "rejected", "failed"].includes(parsed)) {
    return fail("status 只能是 pending / applied / rejected / failed 之一。");
  }

  const actions = await listAssistantActions(ctx.user.id, parsed, 50);
  const pending = actions.filter((a) => a.status === "pending").length;
  return ok({
    // Stated in the same shape every time, because the question being answered is
    // "is it done yet" and that is a count before it is a list.
    statusSummary: {
      pending,
      applied: actions.filter((a) => a.status === "applied").length,
      rejected: actions.filter((a) => a.status === "rejected").length,
      failed: actions.filter((a) => a.status === "failed").length,
    },
    proposals: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      targetId: a.targetId,
      summary: a.summary,
      status: a.status,
      createdAt: a.createdAt,
      // Named `resolvedAt` on the row because it covers rejection as well as
      // application. Reported as itself rather than renamed to `appliedAt`,
      // which would claim a rejected proposal was applied.
      resolvedAt: a.resolvedAt ?? null,
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
          // Declared here, not discovered there. An empty list means this relay
          // has not been told what the model takes — a fact about the
          // configuration, not about the vendor.
          reasoningLevels: c.reasoningLevels ?? [],
          /**
           * The prices and the effort declaration, because a tool that cannot
           * read them cannot be used to check a change made with the tools next
           * door to it.
           *
           * This list used to stop at the fields above, and the cost was a
           * specific wrong conclusion twice in one session: the assistant saw
           * no prices in the output, said the prices had never been configured,
           * and the proposal's own before-snapshot went on to show four models
           * priced at zero and two priced in yuan rather than credits. A missing
           * key in a read is not a missing value in the row, and the two are
           * indistinguishable from here unless the key is returned.
           *
           * `null` rather than a zero default, for the same reason the
           * declaration is not a boolean: unset is a real answer and so is
           * zero, and the difference between "free" and "never priced" is the
           * difference between a bill and a leak.
           */
          inputCost: c.inputCost ?? null,
          outputCost: c.outputCost ?? null,
          cachedInputCost: c.cachedInputCost ?? null,
          cacheWriteCost: c.cacheWriteCost ?? null,
          /**
           * `null` = never declared, `false` = the vendor ignores the parameter.
           * The two are reported separately rather than as one boolean because
           * collapsing them would either grey out every model on the deployment
           * or none of them.
           */
          reasoningEffortSupported:
            c.reasoningEffortSupported === false ? false : null,
          enabled: c.enabled,
        })),
        // Never the key itself: the model has no need for it and the transcript
        // is persisted and re-sent on every subsequent turn.
        headers: p.headers,
        // The protocol documents, one per interface. The model has to see what
        // is there before it can change it, and "it did not tell me" is the
        // shape of every conversation where an assistant quietly re-derives a
        // provider's configuration and gets it wrong. Shown as the list it is:
        // a singular `textSpec` hid two of the three possible entries.
        textSpecs: p.textSpecs ?? [],
      };
    }),
  );
}

/**
 * The configurable protocols and the six parameter modes, with the advice that
 * decides between them.
 *
 * Returned rather than described in a tool description because the model has to
 * choose, and a choice made from a tool description is a choice made from
 * whichever example happened to be nearest. The presets are the whole answer to
 * "how do I configure a vendor" for the ninety percent of vendors that need
 * nothing.
 *
 * **`CONFIGURABLE_PROTOCOLS`, not every preset.** This used to walk
 * `TEXT_PROTOCOL_LABELS`, which still carries `gemini-generate` — the gateway
 * has no `v1beta/models/*:generateContent` route, so a rule for it would be
 * saved and never selected. Offering it here is the same lie the editor stopped
 * telling, told to the one caller with no UI to notice.
 */
function listTextProtocolsTool(): ToolResult {
  return ok({
    defaultIfUnset: "不配协议时，客户端的请求体原样送到上游。这是中转站该有的默认。",
    protocols: CONFIGURABLE_PROTOCOLS.map((protocol) => {
      const surface = SURFACES.find((s) => s.id === protocol);
      return {
        protocol,
        name: TEXT_PROTOCOL_LABELS[protocol].zh,
        // Which client endpoint this rule governs, and which toggle has to be on
        // for it to ever run. Without both, the model writes a rule for an
        // interface nothing calls.
        clientPath: surface?.clientPath ?? null,
        requiresFace: surface?.face ?? null,
        whenToUse: TEXT_PROTOCOL_LABELS[protocol].hint,
        preset: TEXT_PROTOCOL_PRESETS[protocol],
      };
    }),
    faces: {
      openai: "openaiEnabled：决定这条服务商是否响应 /v1/chat/completions 与 /v1/responses",
      anthropic: "anthropicEnabled：决定这条服务商是否响应 /v1/messages 与 /anthropic/v1/messages",
      note:
        "给某个接口写规则之前，它所属的协议面必须是开的，否则规则会保存但不会有请求走到它。" +
        "（编辑器里关掉的面不会出现在添加按钮中。）",
    },
    parameterModes: {
      passthrough: "默认。没列出的参数一律走这个 —— 转发客户端传的值。",
      drop: "客户端传了也不送。用于上游会 400 的参数。",
      default: "客户端没传时才用 value。传了就用它的，对客户端完全透明。",
      force: "不管客户端传没传都用 value。这是唯一能让客户端拿到它没要求的行为的模式，慎用。",
      clamp: "保留客户端的值，但限制在 min/max 之间。",
      rename: "换个名字或位置送，to 可以是点号路径（如 extra_body.thinking）。",
    },
    order: "裁决顺序固定：drop 最先且不可被后面的规则捡回，然后 default、clamp、force、rename。",
  });
}

/**
 * The numbers a proposal may set, with the labels used to reject a bad one.
 *
 * The thinking levels are deliberately absent. They are words, and a list of
 * them cannot go through a `Number(...)` coercion — see
 * {@link buildModelConfigPatch}.
 */
const NUMERIC_PATCH_FIELDS = [
  ["contextLength", "上下文长度", true],
  ["maxOutputTokens", "最大输出", true],
  ["inputCost", "输入价格", false],
  ["outputCost", "输出价格", false],
  ["cachedInputCost", "缓存读价格", false],
  ["cacheWriteCost", "缓存写价格", false],
] as const;

/**
 * Turn the tool's arguments into the patch to merge into a stored model config.
 *
 * Pure, so it can be tested without a provider, a database or a user — which is
 * the only reason the levels bug below was findable at all. It lived in the
 * middle of a function that needed all three, so nothing could ask the executor
 * a question; the only checks anyone had were on the schema the tool *advertises*,
 * and that schema was correct the whole time.
 *
 * Returns `{ error }` for a message to show the model verbatim.
 */
export function buildModelConfigPatch(args: Record<string, unknown>):
  | { patch: Record<string, unknown> }
  | { error: string } {
  const patch: Record<string, unknown> = {};
  if (typeof args.displayName === "string" && args.displayName.trim()) {
    patch.displayName = args.displayName.trim();
  }
  if (typeof args.upstreamId === "string" && args.upstreamId.trim()) {
    patch.upstreamId = args.upstreamId.trim();
  }

  // The levels are words, not a number. This used to sit in the numeric loop,
  // which coerced every value with `Number(...)` — and `Number(["low","high"])`
  // is NaN, so the tool rejected the field it had just advertised with "thinking
  // levels must be a non-negative number". Offered, documented and carried all
  // the way to the database, and unwritable by the only thing that offers it.
  //
  // Validated as a list of non-empty strings here; the envelope names are
  // filtered on the write path, once, for every writer.
  if (args.reasoningLevels !== undefined) {
    const levels = args.reasoningLevels;
    if (!Array.isArray(levels)) return { error: "思考等级必须是一个字符串数组。" };
    if (!levels.every((l) => typeof l === "string" && l.trim().length > 0)) {
      return { error: "思考等级必须是一个非空字符串组成的数组。" };
    }
    if (levels.length > 24) return { error: "思考等级最多 24 个。" };
    // Written even when empty: that is how a model stops offering levels a
    // vendor has withdrawn.
    patch.reasoningLevels = levels.map((l) => l.trim());
  }

  for (const [key, label, mustBeInteger] of NUMERIC_PATCH_FIELDS) {
    const value = args[key];
    if (value === undefined) continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return { error: `${label}必须是一个非负数字。` };
    if (mustBeInteger && !Number.isInteger(n)) return { error: `${label}必须是整数。` };
    patch[key] = n;
  }
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  // Out of the loop above and read as itself. A boolean pushed through
  // `Number(false)` is 0 — a price of nothing rather than a statement about
  // whether a parameter exists — and the difference between a working
  // dropdown and a disabled one in the assistant's settings is exactly this
  // field. Left out entirely when absent, so "not declared" stays distinct from
  // "declared unsupported".
  if (typeof args.reasoningEffortSupported === "boolean") {
    patch.reasoningEffortSupported = args.reasoningEffortSupported;
  }

  if (Object.keys(patch).length === 0) return { error: "没有提供任何要修改的字段。" };
  return { patch };
}

/**
 * One model's gateway configuration.
 *
 * Merges into the stored config rather than replacing it: a model row carries
 * a context window and prices that an operator may have corrected by hand, and a
 * proposal that silently resets them is worse than no proposal.
 */
async function proposeModelConfigUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  const clientId = z.string().min(1).safeParse(args.clientId);
  if (!providerId.success || !clientId.success) return fail("需要 providerId 和 clientId。");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(`找不到服务商 ${providerId.data}。`);

  const existing = (provider.modelConfigs ?? {})[clientId.data];
  if (!existing) {
    return fail(
      `服务商 ${provider.name} 里没有名为 ${clientId.data} 的模型配置。` +
        `现有的：${Object.keys(provider.modelConfigs ?? {}).join(", ") || "（无）"}。` +
        `如果这是一个新模型，先用 propose_provider_update 改 modelMapping。`,
    );
  }

  const built = buildModelConfigPatch(args);
  if ("error" in built) return fail(built.error);
  const patch = built.patch;

  /**
   * The preview, and only the preview.
   *
   * This used to be what the proposal carried, and the whole record it was
   * built from went with it. Two proposals made minutes apart therefore each
   * held a copy of the provider as it stood when *they* were written, and
   * approving them in a row wrote the second copy over the first one's work:
   * eight approved model-price changes, every status green, one of them in the
   * database. The survivor was whichever was approved last, which is not a
   * coincidence anyone would have predicted.
   *
   * The stored intent is now the model and the fields. The apply reads the
   * provider as it stands at that moment and merges, so the order proposals are
   * approved in stops mattering.
   */
  const preview = { ...(provider.modelConfigs ?? {}) };
  preview[clientId.data] = { ...existing, ...patch };
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";

  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.update",
    targetId: provider.id,
    summary,
    args: { modelConfigTarget: { clientId: clientId.data, patch } },
    diff: renderProviderDiff(provider, { modelConfigs: preview }, summary),
  });

  return ok({
    actionId: action.id,
    summary,
    provider: provider.name,
    model: clientId.data,
    before: {
      displayName: existing.displayName,
      upstreamId: existing.upstreamId,
      contextLength: existing.contextLength,
      maxOutputTokens: existing.maxOutputTokens,
      reasoningLevels: existing.reasoningLevels ?? [],
      inputCost: existing.inputCost,
      outputCost: existing.outputCost,
      ...(existing.cachedInputCost !== undefined
        ? { cachedInputCost: existing.cachedInputCost }
        : {}),
      ...(existing.cacheWriteCost !== undefined
        ? { cacheWriteCost: existing.cacheWriteCost }
        : {}),
      enabled: existing.enabled,
    },
    after: { ...existing, ...patch },
  });
}

/** The operator's own chapter, as it stands. */
async function listDocPagesTool(): Promise<ToolResult> {
  const { docPages } = await getSettings();
  return ok({
    pages: docPages ?? [],
    note: "propose_doc_pages 是整份替换。改之前一定要先读这里，否则会把现有页面全删掉。",
  });
}

/**
 * The operator's documentation pages.
 *
 * Whole-list replacement, like `modelMapping`, and for the same reason: a
 * partial write is indistinguishable from "the operator wanted only this one
 * page" until somebody notices the others are gone. The tool says so in its
 * description and in the list tool's own output, because the failure happens
 * silently otherwise.
 */
/**
 * What the model needs to hear about the pages it just proposed.
 *
 * Said here as well as in the approval diff, because the person who can fix it
 * is the model: a page longer than the reader's limit is fine on screen and cut
 * in half on the way back into a conversation. Storage allows 60,000 and the
 * reader stops at 20,000, so the band between them is silent — the page saves,
 * renders, and quietly becomes a page the assistant cannot finish.
 *
 * Pure, so it can be checked without a database or a pending action.
 */
export function docPageAdvice(
  pages: readonly DocPage[],
): { tooLongForAssistant: { id: string; chars: number; limit: number }[]; advice: string } | undefined {
  const overLong = pages.filter((p) => p.body.length > ASSISTANT_PAGE_READ_LIMIT);
  if (overLong.length === 0) return undefined;
  return {
    tooLongForAssistant: overLong.map((p) => ({
      id: p.id,
      chars: p.body.length,
      limit: ASSISTANT_PAGE_READ_LIMIT,
    })),
    advice:
      "这些页面对读者是完整的，但助手读它们时会在 " +
      `${ASSISTANT_PAGE_READ_LIMIT} 字符处被截断——你之后从这一页拿到的会是半张表。` +
      "按语言或能力拆成多页，一页一类再提交。",
  };
}

async function proposeDocPages(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!Array.isArray(args.pages)) return fail("pages 必须是数组。");

  const pages: DocPage[] = [];
  const problems: string[] = [];
  for (const [i, raw] of args.pages.entries()) {
    if (!raw || typeof raw !== "object") {
      problems.push(`pages[${i}] 不是对象`);
      continue;
    }
    const page = raw as Record<string, unknown>;
    const id = typeof page.id === "string" ? page.id.trim() : "";
    const title = typeof page.title === "string" ? page.title.trim() : "";
    const body = typeof page.body === "string" ? page.body : "";
    if (!id) {
      problems.push(`pages[${i}] 缺少 id`);
      continue;
    }
    // Same rule the endpoint enforces, checked here so the administrator reads
    // it before approving rather than after.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      problems.push(`pages[${i}].id「${id}」只能用小写字母、数字和中划线`);
      continue;
    }
    if (!title) {
      problems.push(`pages[${i}] 缺少标题`);
      continue;
    }
    if (body.length > 60_000) {
      problems.push(`pages[${i}] 正文超过 60000 字符`);
      continue;
    }
    pages.push({
      id,
      title,
      body,
      ...(page.hidden === true ? { hidden: true } : {}),
      order: typeof page.order === "number" ? page.order : i,
    });
  }
  const dupes = pages.map((p) => p.id).filter((id, i, all) => all.indexOf(id) !== i);
  for (const dupe of new Set(dupes)) problems.push(`id「${dupe}」重复了`);
  if (problems.length) return fail(`这些页面不能用：\n- ${problems.join("\n- ")}`);

  const advice = docPageAdvice(pages);

  const { docPages } = await getSettings();
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const before = docPages ?? [];

  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "doc_pages.update",
    targetId: "docPages",
    summary,
    args: { docPages: pages },
    diff: renderDocPagesDiff(before, pages, summary),
  });

  return ok({
    actionId: action.id,
    summary,
    removed: before.filter((b) => !pages.some((p) => p.id === b.id)).map((b) => b.id),
    kept: before.filter((b) => pages.some((p) => p.id === b.id)).map((b) => b.id),
    added: pages.filter((p) => !before.some((b) => b.id === p.id)).map((p) => p.id),
    ...(advice ? { advice } : {}),
  });
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
  if (typeof args.upstreamFormat === "string") {
    if (args.upstreamFormat !== "chat" && args.upstreamFormat !== "responses") {
      return fail('upstreamFormat 只能是 "chat" 或 "responses"。');
    }
    // The trap worth naming: `responses` means /v1/responses reaches the vendor
    // untouched, but a /v1/chat/completions request still goes to
    // `<base>/chat/completions` — there is no chat-to-responses conversion. A
    // vendor that only serves /v1/responses will 404 a chat client no matter
    // what this is set to, so the proposal says so instead of letting the
    // administrator find out in production.
    if (args.upstreamFormat === "responses" && (patch.openaiEnabled ?? provider.openaiEnabled ?? true)) {
      return ok({
        status: "needs_attention",
        message:
          "上游格式设为 responses 后，客户端调 /v1/responses 时会原样透传；" +
          "但客户端调 /v1/chat/completions 时仍然发往 <API 地址>/chat/completions，" +
          "网关没有 chat→responses 的转换。该厂商如果不提供这个端点，Chat 客户端会拿到 404。" +
          "确认它提供，再把这项一起提交。",
        patch: { upstreamFormat: args.upstreamFormat },
      });
    }
    patch.upstreamFormat = args.upstreamFormat;
  }
  if (args.headers !== undefined) {
    if (args.headers === null) {
      patch.headers = {};
    } else if (typeof args.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
      }
      patch.headers = headers;
    } else {
      return fail("headers 必须是一个字符串键值对对象，例如 {\"api-version\": \"2024-08-01-preview\"}。");
    }
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

  if (args.textSpecs !== undefined) {
    // Validated here, at proposal time, rather than at apply time.
    //
    // The whole point of a proposal is that the administrator sees a truthful
    // before/after before anything happens. A spec that would be rejected on
    // apply is a spec the administrator approves, and then does not get.
    if (args.textSpecs === null) {
      patch.textSpecs = [];
    } else if (!Array.isArray(args.textSpecs)) {
      return fail("textSpecs 必须是数组，每一项是一份协议文档。");
    } else {
      // Merged by `protocol` rather than replaced: a provider can carry up to
      // three, one per interface, and asking the model to resend all of them to
      // change one is the same trap `modelMapping` warns about above.
      //
      // Read from the raw column rather than through `readTextSpecs`, which
      // returns the parsed spec: re-serialising would rewrite stored bytes and
      // lose anything the parser normalised away.
      const byProtocol = new Map<string, string>();
      for (const raw of provider.textSpecs ?? []) {
        try {
          const protocol = (JSON.parse(raw) as { protocol?: string }).protocol;
          if (typeof protocol === "string") byProtocol.set(protocol, raw);
        } catch {
          // A stored entry that no longer parses is replaced by whatever the
          // model sends for that interface, or left alone if it sends none.
        }
      }

      for (const entry of args.textSpecs as unknown[]) {
        const parsed = parseTextSpec(entry);
        if (!parsed.ok) {
          return fail(`这份协议不能用，已列出问题：\n- ${parsed.errors.join("\n- ")}`);
        }
        byProtocol.set(parsed.spec.protocol, JSON.stringify(parsed.spec));
      }

      const list = [...byProtocol.values()];
      const check = validateTextSpecs(list);
      if (!check.ok) {
        return fail(`这组协议不能同时生效：\n- ${check.errors.join("\n- ")}`);
      }

      // A rule for an interface nothing calls is saved, looks configured, and
      // never runs. The editor hides the add-button for it; the assistant has to
      // say so out loud, because there is no UI to click here.
      //
      // Read the faces off the *merged* result, not the stored row: a proposal
      // that turns a face off and adds a rule for it in the same breath is
      // exactly the case where the stored value is the wrong one to check.
      const openaiOn =
        typeof patch.openaiEnabled === "boolean" ? patch.openaiEnabled : (provider.openaiEnabled ?? true);
      const anthropicOn =
        typeof patch.anthropicEnabled === "boolean"
          ? patch.anthropicEnabled
          : (provider.anthropicEnabled ?? false);
      const faces: Record<string, boolean> = {
        "openai-chat": openaiOn,
        "openai-responses": openaiOn,
        "anthropic-messages": anthropicOn,
      };
      const offFace = list
        .map((raw) => (JSON.parse(raw) as { protocol: string }).protocol)
        .filter((p) => faces[p] === false);

      patch.textSpecs = list;
      if (offFace.length > 0) {
        return ok({
          status: "needs_attention",
          message:
            `协议已经写好，但 ${offFace.join("、")} 所属的协议面是关着的：` +
            `规则会被保存，可不会有请求走到它。要让它生效，请同时把对应的协议面打开` +
            `（openaiEnabled / anthropicEnabled），再提交一次。`,
          patch,
        });
      }
    }
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

/**
 * Apply `specEdits` to a provider's specs.
 *
 * Asking a model to re-send the whole spec array is how this went wrong four
 * times in a row: the array is ~15 KB, the model has to reproduce all of it in
 * one tool call, and what arrived was not valid JSON — `_request` where the
 * field is `request`, head and tail intact and the middle mangled. The shape
 * was right because it had just read a real spec; the operation was not
 * reliable because it had to echo a document back verbatim.
 *
 * So the model sends what it wants *changed* and the merge happens here, where
 * it is exact. Only whole-spec work — adding a capability, removing one — still
 * needs the full array, and that is rare and bounded.
 */
export function applySpecEdits(
  current: unknown[],
  edits: unknown,
): { specs: Record<string, unknown>[]; error?: string } {
  if (!Array.isArray(edits)) return { specs: current as Record<string, unknown>[], error: "specEdits 不是数组" };

  const specs = JSON.parse(JSON.stringify(current)) as Record<string, unknown>[];
  for (const [i, raw] of edits.entries()) {
    const edit = raw as Record<string, unknown>;
    const index = typeof edit?.index === "number" ? edit.index : -1;
    if (index < 0 || index >= specs.length) {
      return {
        specs,
        error: `specEdits[${i}].index 越界：现在是 ${index}，而当前只有 ${specs.length} 个 spec`,
      };
    }
    // Shallow merge, per spec. A nested override would need the model to
    // reproduce `transport` or `response` wholesale to change one field inside
    // it, which is the same problem one level down.
    const { index: _index, ...overrides } = edit as Record<string, unknown> & { index?: number };
    void _index;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      specs[index] = { ...specs[index], [key]: value };
    }
  }
  return { specs };
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

  if (args.specEdits !== undefined) {
    // Resolved here rather than stored as edits, so the approval still applies
    // a *whole* spec array and the diff the admin reads is the result.
    const merged = applySpecEdits(provider.specs ?? [], args.specEdits);
    if (merged.error) return fail(merged.error);
    patch.specs = merged.specs;
  } else if (Array.isArray(args.specs)) {
    patch.specs = args.specs;
  }

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
