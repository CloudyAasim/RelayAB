/**
 * src/lib/providers/templates.ts
 * Updated: 2025-09-22
 * 
 * Provider templates with complete model configurations and request headers.
 * Models and headers sourced from official platform documentation.
 */
export interface ProviderTemplate {
  id: string;
  label: string;
  kind: "openai" | "anthropic" | "azure" | "custom";
  defaultBaseUrl: string;
  defaultModelMapping: Record<string, string>;
  /** Default context length for models in this template */
  defaultContextLength?: number;
  /** Default max output tokens for models in this template */
  defaultMaxOutput?: number;
  defaultHeaders?: Record<string, string>;
  modelsListPath?: string;
  description: string;
}

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
    description: "Anthropic Claude 系列模型。不支持自动模型列举，请手动添加模型。",
    modelsListPath: "",
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
  },
  {
    id: "minimax",
    label: "MiniMax",
    kind: "openai",
    defaultBaseUrl: "https://api.minimax.cn/v1",
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
    description: "MiniMax 海螺 AI（OpenAI 兼容）。海外用户使用 api.minimax.io，国内用户使用 api.minimax.cn。",
    modelsListPath: "/models",
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
  },
];

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id);
}
