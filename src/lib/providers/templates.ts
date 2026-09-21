/**
 * src/lib/providers/templates.ts
 *
 * Preset templates for common upstream providers. Each template knows:
 *   - kind:                   matches our Provider.kind field
 *   - defaultBaseUrl:        pre-fills the baseUrl field
 *   - defaultHeaders:         e.g. api-version for Azure
 *   - defaultModelMapping:    a starting client→upstream model map
 *   - modelsListPath:         where to GET /v1/models (relative to baseUrl)
 *
 * When the user picks a template from the dropdown, all these fields are
 * populated but remain user-editable.
 */
export interface ProviderTemplate {
  id: string;
  label: string;
  kind: "openai" | "anthropic" | "azure" | "custom";
  defaultBaseUrl: string;
  defaultModelMapping: Record<string, string>;
  /** Optional default headers (e.g. "api-version" for Azure). */
  defaultHeaders?: Record<string, string>;
  /** GET path to enumerate upstream models. Default "/v1/models". */
  modelsListPath?: string;
  /** Short description shown next to the template in the dropdown. */
  description: string;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModelMapping: {
      "gpt-5": "gpt-5-2025-08-07",
      "gpt-5-mini": "gpt-5-mini-2025-08-07",
      "gpt-4o": "gpt-4o-2024-08-06",
      "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
      "o1": "o1-2024-12-17",
      "o1-mini": "o1-mini-2024-09-12",
      "o3-mini": "o3-mini-2025-01-31",
    },
    description: "OpenAI 官方 API。覆盖 GPT-5、GPT-4o、o1/o3 系列。",
    modelsListPath: "/models",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModelMapping: {
      "claude-3-7-sonnet": "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku": "claude-3-5-haiku-20241022",
      "claude-3-opus": "claude-3-opus-20240229",
      "claude-3-haiku": "claude-3-haiku-20240307",
    },
    description: "Anthropic Claude 系列。注意 Anthropic 不支持自动模型列举。",
    modelsListPath: "/v1/models",
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    kind: "azure",
    defaultBaseUrl: "https://{your-resource}.openai.azure.com/openai/deployments",
    defaultModelMapping: {
      "gpt-4o": "gpt-4o",
      "gpt-4o-mini": "gpt-4o-mini",
    },
    description: "Azure OpenAI Service。需要在 baseUrl 里替换为你的 resource name。",
    modelsListPath: "",
    defaultHeaders: { "api-version": "2024-08-01-preview" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModelMapping: {
      "gpt-4o": "openai/gpt-4o-2024-08-06",
      "claude-3-5-sonnet": "anthropic/claude-3.5-sonnet",
      "gemini-pro": "google/gemini-pro-1.5",
    },
    description: "OpenRouter 统一网关（OpenAI 兼容）。可在多上游间自动路由。",
    modelsListPath: "/models",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModelMapping: {
      "deepseek-chat": "deepseek-chat",
      "deepseek-reasoner": "deepseek-reasoner",
    },
    description: "DeepSeek 官方 API（OpenAI 兼容）。",
    modelsListPath: "/models",
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    kind: "openai",
    defaultBaseUrl: "",
    defaultModelMapping: {},
    description: "任何兼容 /v1/models 和 /chat/completions 的上游。",
    modelsListPath: "/v1/models",
  },
];

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id);
}
