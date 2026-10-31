/**
 * src/lib/providers/templates.ts
 * Updated: 2025-09-22
 *
 * Provider templates with complete model configurations and request headers.
 * Models and headers sourced from official platform documentation.
 */
import type { SurfaceRoutes } from "@/lib/protocol/surface-routes";
import type { UpstreamKeyCarrier } from "@/lib/protocol/surface-routes";

export interface ProviderTemplate {
  id: string;
  label: string;
  kind: "openai" | "anthropic" | "azure" | "custom-openai" | "gemini";
  defaultBaseUrl: string;
  defaultModelMapping: Record<string, string>;
  /** Default context length for models in this template */
  defaultContextLength?: number;
  /** Default max output tokens for models in this template */
  defaultMaxOutput?: number;
  defaultHeaders?: Record<string, string>;
  modelsListPath?: string;
  description: string;
  /** Default upstream format */
  defaultUpstreamFormat?: "responses" | "chat" | "anthropic";
  /**
   * How each client surface reaches this vendor.
   *
   * **A template says what its vendor speaks**, and this is why it has to be
   * here: the route table became the answer (the columns that came before it
   * are only a fallback for rows written before it), so a template that filled
   * in the base URL alone left the routing to whatever the form happened to
   * default to — which is right for OpenAI and wrong for every other vendor.
   * A row created from the Anthropic template used to send a Chat Completions
   * body to `api.anthropic.com/chat/completions`.
   */
  routes: SurfaceRoutes;
  /**
   * How this vendor wants its key.
   *
   * Google's own API takes the key in `x-goog-api-key`, raw, with no `Bearer`
   * in front of it; everyone else takes `Authorization: Bearer`. Absent means
   * `Bearer`, which is what every vendor but Google's wants.
   */
  keyCarrier?: UpstreamKeyCarrier;
}

// ---------------------------------------------------------------------------
// The route tables
// ---------------------------------------------------------------------------

/**
 * The four tables the templates use.
 *
 * Three of them are about what the vendor publishes, and one of them is about
 * what it does **not**:
 *
 *  - **OpenAI-shaped** — publishes `/chat/completions` and `/responses`.
 *  - **Chat-shaped** — publishes `/chat/completions` only, so the Responses
 *    surface is answered by translating the request into Chat Completions.
 *    That translation always works, which is why it is the safe default for
 *    a vendor whose Responses support is uncertain.
 *  - **Anthropic-shaped** — publishes `/v1/messages` only.
 *  - **Gemini-shaped** — publishes `generateContent` only, and is the one
 *    vendor whose own endpoint the client can reach untouched.
 */
const OPENAI_SHAPED: SurfaceRoutes = {
  "openai-chat": { kind: "passthrough" },
  "openai-responses": { kind: "passthrough" },
  "anthropic-messages": { kind: "unsupported" },
  "gemini-generate": { kind: "unsupported" },
};

const CHAT_SHAPED: SurfaceRoutes = {
  "openai-chat": { kind: "passthrough" },
  "openai-responses": { kind: "route", dialect: "chat" },
  "anthropic-messages": { kind: "unsupported" },
  "gemini-generate": { kind: "unsupported" },
};

const ANTHROPIC_SHAPED: SurfaceRoutes = {
  "openai-chat": { kind: "route", dialect: "anthropic" },
  "openai-responses": { kind: "route", dialect: "anthropic" },
  "anthropic-messages": { kind: "passthrough" },
  "gemini-generate": { kind: "route", dialect: "anthropic" },
};

const GEMINI_SHAPED: SurfaceRoutes = {
  "openai-chat": { kind: "route", dialect: "gemini" },
  "openai-responses": { kind: "route", dialect: "gemini" },
  "anthropic-messages": { kind: "unsupported" },
  // The vendor's own endpoint, reached the way the client asked: the request
  // goes out as it arrived and the answer comes back as it arrived.
  "gemini-generate": { kind: "passthrough" },
};

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultContextLength: 1050000,
    defaultMaxOutput: 128000,
    defaultModelMapping: {
      "gpt-6-astra": "gpt-6-astra",
      "gpt-5.6-sol": "gpt-5.6-sol",
      "gpt-5.6-terra": "gpt-5.6-terra",
      "gpt-5.6-luna": "gpt-5.6-luna",
      "gpt-5.5": "gpt-5.5",
      "gpt-5.4": "gpt-5.4",
      "gpt-5.4-mini": "gpt-5.4-mini",
      "gpt-5.4-nano": "gpt-5.4-nano",
      "gpt-5.3-codex": "gpt-5.3-codex",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    description: "OpenAI 官方 API。",
    modelsListPath: "/models",
    routes: OPENAI_SHAPED,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultContextLength: 1000000,
    defaultMaxOutput: 128000,
    defaultModelMapping: {
      "claude-fable-5-1": "claude-fable-5-1",
      "claude-opus-5": "claude-opus-5",
      "claude-opus-4-8": "claude-opus-4-8",
      "claude-sonnet-5": "claude-sonnet-5",
      "claude-opus-4-7": "claude-opus-4-7",
      "claude-opus-4-6": "claude-opus-4-6",
      "claude-sonnet-4-6": "claude-sonnet-4-6",
      "claude-haiku-4-5": "claude-haiku-4-5",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
      "anthropic-version": "2023-06-01",
    },
    defaultUpstreamFormat: "anthropic",
    description: "Anthropic Claude 系列模型。不支持自动模型列举，请手动添加模型。",
    modelsListPath: "",
    routes: ANTHROPIC_SHAPED,
  },
  {
    id: "google-gemini",
    label: "Google Gemini",
    kind: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultContextLength: 1048576,
    defaultMaxOutput: 65536,
    // The model list is fetched, not written down: Google publishes dozens and
    // renames them, and a hand-written list is stale the day it is written.
    defaultModelMapping: {},
    keyCarrier: "x-goog-api-key",
    description:
      "Google Gemini 官方 API（原生 generateContent）。密钥走 x-goog-api-key（Google 的一等载体，不是 Bearer）；模型列表用「自动获取」拉取。",
    modelsListPath: "/models",
    routes: GEMINI_SHAPED,
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    kind: "azure",
    defaultBaseUrl: "https://{your-resource}.openai.azure.com/openai/v1/",
    defaultContextLength: 1050000,
    defaultMaxOutput: 128000,
    defaultModelMapping: {
      "gpt-6-astra": "gpt-6-astra",
      "gpt-5.6-sol": "gpt-5.6-sol",
      "gpt-5.6-terra": "gpt-5.6-terra",
      "gpt-5.6-luna": "gpt-5.6-luna",
      "gpt-5.4": "gpt-5.4",
      "gpt-5.4-nano": "gpt-5.4-nano",
      "gpt-5.3-codex": "gpt-5.3-codex",
      "gpt-oss-120b": "gpt-oss-120b",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "api-key": "YOUR_API_KEY",
    },
    description: "Azure OpenAI Service。需替换 baseUrl 中的资源名。api-version 通过 URL 查询参数传递。",
    modelsListPath: "",
    routes: OPENAI_SHAPED,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultContextLength: 1048576,
    defaultMaxOutput: 384000,
    defaultModelMapping: {
      "deepseek-v4-pro": "deepseek-v4-pro",
      "deepseek-v4-flash": "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp": "deepseek-v4-flash-vision-exp",
      "deepseek-v3.2": "deepseek-v3.2",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    description: "DeepSeek 官方 API（OpenAI 兼容）。注意：deepseek-chat 和 deepseek-reasoner 已退役，不建议使用。",
    modelsListPath: "/models",
    routes: CHAT_SHAPED,
  },
  {
    id: "minimax",
    label: "MiniMax",
    kind: "openai",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultContextLength: 1048576,
    defaultMaxOutput: 131072,
    defaultModelMapping: {
      "MiniMax-M3": "MiniMax-M3",
      "MiniMax-M2.7": "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed": "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5": "MiniMax-M2.5",
      "MiniMax-M2.1": "MiniMax-M2.1",
      "MiniMax-M2": "MiniMax-M2",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    description:
      "MiniMax 海螺 AI（OpenAI 兼容）。密钥分区域且互不通用：海外用 api.minimax.io，国内用 api.minimaxi.com；api.minimax.cn 是仍可用的旧域名，新配置不建议再填。",
    modelsListPath: "/models",
    routes: CHAT_SHAPED,
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultContextLength: 262144,
    defaultMaxOutput: 16384,
    defaultModelMapping: {
      "qwen3.6-27b": "qwen/qwen3.6-27b",
      "kimi-k2-instruct-0905": "moonshotai/kimi-k2-instruct-0905",
      "llama-4-scout": "meta-llama/llama-4-scout-17b-16e-instruct",
      "llama-4-maverick": "meta-llama/llama-4-maverick-17b-128e-instruct",
      "llama-3.3-70b": "llama-3.3-70b-versatile",
      "gpt-oss-120b": "openai/gpt-oss-120b",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    description: "Groq 超低延迟推理（OpenAI 兼容）。",
    modelsListPath: "/models",
    routes: CHAT_SHAPED,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultContextLength: 1048576,
    defaultMaxOutput: 131072,
    defaultModelMapping: {
      "ox-alpha": "stealth/ox-alpha",
      "mercury-2.5-preview": "inception/mercury-2.5-preview",
      "union-alpha": "union-alpha",
      "gpt-5.6-luna": "openai/gpt-5.6-luna",
      "claude-opus-4-6": "anthropic/claude-opus-4-6",
      "gemini-3.7-flash": "google/gemini-3.7-flash",
      "grok-4.5": "x-ai/grok-4.5",
      "deepseek-v4-flash": "deepseek/deepseek-v4-flash-0731",
      "minimax-m3": "minimax/minimax-m3",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
      "HTTP-Referer": "https://your-app.com",
      "X-OpenRouter-Title": "Your App Name",
    },
    description: "OpenRouter 统一网关（OpenAI 兼容）。",
    modelsListPath: "/models",
    routes: CHAT_SHAPED,
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    kind: "openai",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    defaultContextLength: 1049000,
    defaultMaxOutput: 262000,
    defaultModelMapping: {
      "longcat-2.0": "longcat-2.0",
      "kimi-k3": "moonshotai/Kimi-K3",
      "deepseek-v4-flash": "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-v3.2": "deepseek-ai/DeepSeek-V3.2",
      "glm-5.3": "zai-org/GLM-5.3",
      "qwen3.6-35b-a3b": "Qwen/Qwen3.6-35B-A3B",
      "minimax-m3": "MiniMaxAI/MiniMax-M3",
    },
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    description: "SiliconFlow 第三方 API（OpenAI 兼容）。",
    modelsListPath: "/models",
    routes: CHAT_SHAPED,
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    kind: "openai",
    defaultBaseUrl: "",
    defaultContextLength: 128000,
    defaultMaxOutput: 8192,
    defaultModelMapping: {},
    defaultHeaders: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    description: "任何兼容 /v1/models 和 /chat/completions 的上游。",
    modelsListPath: "/models",
    routes: CHAT_SHAPED,
  },
];

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id);
}

/**
 * What picking a template puts on the form.
 *
 * Pure on purpose: the picker's whole job is this mapping, and a mapping that
 * can only be checked by clicking is a mapping nobody checks.
 */
export function templateValues(tpl: ProviderTemplate): {
  kind: string;
  baseUrl?: string;
  routes: SurfaceRoutes;
} {
  return {
    // Azure's own kind is not a value the form offers — it is an
    // OpenAI-compatible vendor with an address of its own.
    kind: tpl.kind === "azure" ? "custom-openai" : tpl.kind,
    ...(tpl.defaultBaseUrl ? { baseUrl: tpl.defaultBaseUrl } : {}),
    // A copy: the route objects are shared between the templates, and the
    // editor replaces them rather than editing them in place — but a copy
    // costs nothing and removes the question.
    routes: { ...tpl.routes },
  };
}
