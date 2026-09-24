/**
 * src/lib/db/types.ts
 *
 * Domain types shared between the persistence layer (Redis) and the
 * business logic layer. These mirror the shapes described in
 * docs/DATA_MODEL.md.
 *
 * Convention: all `id` fields are ULID strings (26 chars, sortable).
 * All timestamps are ISO 8601 strings (UTC) for portability.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ULID: 26-character base32 string. We don't enforce the format strictly
 * because validation is done at the repository layer. */
export type Ulid = string;

export type IsoDateString = string;

export const RoleSchema = z.enum(["admin", "user"]);
export type Role = z.infer<typeof RoleSchema>;

export const QuotaTypeSchema = z.enum(["credits", "tokens"]);
export type QuotaType = z.infer<typeof QuotaTypeSchema>;

export const ProviderKindSchema = z.enum(["openai", "anthropic", "custom-openai", "azure"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const UpstreamFormatSchema = z.enum(["responses", "chat", "anthropic"]);
export type UpstreamFormat = z.infer<typeof UpstreamFormatSchema>;

/**
 * Protocols the OpenAI-facing side of a provider can speak.
 *
 * `"anthropic"` is deliberately NOT part of this enum: the Anthropic Messages
 * protocol is a separate *face* of a provider (see `providerFaces`), not a
 * third choice for the OpenAI side. The legacy value `upstreamFormat:
 * "anthropic"` is still accepted on read so pre-existing rows keep working.
 */
export const OpenAIFaceFormatSchema = z.enum(["responses", "chat"]);
export type OpenAIFaceFormat = z.infer<typeof OpenAIFaceFormatSchema>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * Default policy for a freshly created user.
 *
 * QUOTA LIVES ON THE USER, NOT THE KEY.
 *
 * This is the central modelling decision of the whole gateway, so it is
 * worth spelling out. A user is granted a pool of credits (or tokens) by an
 * admin. Every API key that user creates draws from that single pool:
 *
 *     admin grants Alice 1000 积分
 *       Alice creates key A, key B, key C
 *       calls on A, B and C all decrement the same 1000
 *
 * The alternative — a quota per key — silently multiplies whatever the
 * admin granted by the number of keys a user mints, which is not what
 * "give Alice 1000 credits" means to anyone.
 *
 * Fields:
 *  - `quotaType`      unit of the pool: "credits" (积分) or "tokens".
 *  - `quotaLimit`     size of the pool, in `CREDIT_SCALE` integer units for
 *                     credits. `0` means "not yet granted" → all calls are
 *                     rejected until an admin allocates something.
 *  - `quotaUsed`      consumed so far, same unit as `quotaLimit`.
 *  - `maxActiveKeys`  cap on simultaneously enabled keys. `0` = no cap.
 *  - `allowedModels`  models this user may call. `[]` = every model exposed
 *                     by the configured providers.
 */
export const DEFAULT_USER_ALLOCATION = Object.freeze({
  quotaType: "credits" as QuotaType,
  quotaLimit: 0,     // nothing granted yet — admin must allocate
  maxActiveKeys: 0,  // 0 = no cap
  allowedModels: [] as string[],
});

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(32),
  passwordHash: z.string().min(1), // bcrypt hash, e.g. $2a$12$...
  role: RoleSchema,
  displayName: z.string().min(1).max(64),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().nullable(),
  disabled: z.boolean(),
  // ----- Admin-controlled policy (see DEFAULT_USER_ALLOCATION above) -----
  quotaType: QuotaTypeSchema.default(DEFAULT_USER_ALLOCATION.quotaType),
  quotaLimit: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_USER_ALLOCATION.quotaLimit),
  quotaUsed: z.number().int().nonnegative().default(0),
  maxActiveKeys: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_USER_ALLOCATION.maxActiveKeys),
  allowedModels: z
    .array(z.string())
    .default([]),
});
export type User = z.infer<typeof UserSchema>;

/**
 * Safe view of a user (omit passwordHash). Used in API responses and
 * UI rendering.
 */
export type PublicUser = Omit<User, "passwordHash">;

// ---------------------------------------------------------------------------
// ApiKey
// ---------------------------------------------------------------------------

export const ApiKeySchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  label: z.string().min(1).max(64),
  keyHash: z.string().length(64), // sha256 hex
  keyPrefix: z.string().min(8), // "sk-relay-XXXX...YYYY"
  expiresAt: z.string().nullable(),
  /**
   * Admin-forced disable. When true, the key cannot be enabled by the user.
   */
  forceDisabled: z.boolean().default(false),
  enabled: z.boolean(),
  /**
   * Optional per-key narrowing of the user's model whitelist.
   *
   * The effective permission is the INTERSECTION of the user's whitelist and
   * this key's whitelist. That lets a user mint e.g. a "read-only cheap
   * models" key without asking an admin to re-scope their whole account.
   * `[]` means "no additional restriction" — the user's whitelist still
   * applies.
   */
  allowedModels: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/**
 * View of an API key safe to return to the admin panel: includes the
 * truncated prefix but never the plaintext.
 */
export type PublicApiKey = ApiKey;

// Note: ApiKeyWithPlaintext is defined in ./keys.ts to avoid circular deps.

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// ModelConfig
// ---------------------------------------------------------------------------

/**
 * Model configuration including context length, output length, and credit cost.
 */
export const ModelConfigSchema = z.object({
  /** Upstream model ID */
  upstreamId: z.string(),
  /** Client-facing model ID (alias) */
  clientId: z.string(),
  /** Display name */
  displayName: z.string().optional(),
  /** Context window size (input tokens) */
  contextLength: z.number().int().positive().default(128000),
  /** Maximum output tokens */
  maxOutputTokens: z.number().int().positive().default(8192),
  /** Credit cost per 1M input tokens */
  inputCost: z.number().nonnegative().default(0),
  /** Credit cost per 1M output tokens */
  outputCost: z.number().nonnegative().default(0),
  /** Whether this model is enabled */
  enabled: z.boolean().default(true),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  kind: ProviderKindSchema,
  baseUrl: z.string().nullable(),
  encryptedApiKey: z.string().min(1), // base64
  // Simple client→upstream model name mapping (for backwards compatibility)
  modelMapping: z.record(z.string(), z.string()),
  // Detailed model configurations (context length, output, cost)
  modelConfigs: z.record(z.string(), ModelConfigSchema).optional().default({}),
  enabled: z.boolean(),
  priority: z.number().int(),
  // Optional per-provider HTTP headers (e.g. api-version for Azure).
  headers: z.record(z.string(), z.string()).optional().default({}),
  // Upstream format: responses (native), chat, or anthropic
  upstreamFormat: UpstreamFormatSchema.default("responses"),
  /**
   * Whether this provider serves the OpenAI-facing endpoints
   * (`/v1/chat/completions`, `/v1/responses`).
   */
  openaiEnabled: z.boolean().default(true),
  /**
   * Whether this provider ALSO serves the Anthropic Messages surface
   * (`/anthropic/v1/messages`, `/v1/messages`).
   *
   * The two faces share the API key, model mapping and model configs — those
   * are identical for a given vendor, so configuring the same vendor twice
   * (once per protocol) is no longer necessary. Only the protocol and, usually,
   * the base URL differ.
   */
  anthropicEnabled: z.boolean().default(false),
  /**
   * Base URL for the Anthropic face. Empty means "derive it from `baseUrl`"
   * (one trailing `/v1` is stripped). Set it explicitly whenever the vendor's
   * Anthropic endpoint is a sub-path, e.g. `https://api.deepseek.com/anthropic`.
   */
  anthropicBaseUrl: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export type PublicProvider = Omit<Provider, "encryptedApiKey">;

/**
 * The protocol faces one provider exposes.
 *
 * A vendor that speaks both OpenAI and Anthropic protocols used to need two
 * provider rows (with the key, mapping and model configs duplicated). Both
 * faces now live on one row:
 *
 *   { openai: { format: "chat" },  anthropic: { baseUrl: "https://…" } }
 *   { openai: null,                anthropic: { baseUrl: "https://…" } }  // Anthropic only
 *   { openai: { format: "responses" }, anthropic: null }                    // OpenAI only
 */
export interface ProviderFaces {
  /** Non-null when the provider serves `/v1/chat/completions` and `/v1/responses`. */
  openai: { format: OpenAIFaceFormat } | null;
  /**
   * Non-null when the provider serves the Anthropic Messages surface.
   * `baseUrl` may be empty — the URL builder then falls back to the vendor
   * default (`https://api.anthropic.com`).
   */
  anthropic: { baseUrl: string } | null;
}

/** Drop one trailing `/v1` so an OpenAI base can seed an Anthropic base. */
function stripTrailingV1(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function providerFaces(provider: Provider): ProviderFaces {
  const anthropicFormat = provider.upstreamFormat === "anthropic";
  const defaults = defaultFaceFlags(provider.kind, provider.upstreamFormat);

  // `openaiEnabled`/`anthropicEnabled` are always set on rows that went through
  // the schema (`hashToProvider` derives them for legacy rows). The `undefined`
  // fallbacks keep hand-built objects honest.
  const openaiOn = provider.openaiEnabled ?? defaults.openaiEnabled;
  const anthropicOn = provider.anthropicEnabled ?? defaults.anthropicEnabled;

  // `"anthropic"` is not a valid OpenAI-side format, so such a row can never
  // serve the OpenAI endpoints even if a flag was left on.
  const openai =
    openaiOn && !anthropicFormat
      ? ({ format: provider.upstreamFormat } as { format: OpenAIFaceFormat })
      : null;

  const explicitAnthropicBase = provider.anthropicBaseUrl?.trim() ?? "";
  const derivedAnthropicBase = provider.baseUrl ? stripTrailingV1(provider.baseUrl) : "";
  const anthropicBaseUrl = explicitAnthropicBase || derivedAnthropicBase;
  // The face exists whenever it is enabled, even with an empty base URL: the
  // URL builder is the single place that decides what to fall back to (the
  // vendor default, `https://api.anthropic.com`). Rows may legitimately leave
  // the base unset — that is what pre-faces Anthropic providers did.
  // `upstreamFormat: "anthropic"` is itself a statement of protocol, so it
  // forces the face on. Without that, a legacy row whose flag got flipped off
  // would serve neither protocol and silently vanish from every surface.
  const anthropic = anthropicFormat || anthropicOn ? { baseUrl: anthropicBaseUrl } : null;

  return { openai, anthropic };
}

/**
 * Face flags implied by the pre-faces shape of a provider row.
 *
 * A row is Anthropic-only when it was created as `kind: "anthropic"` or with
 * `upstreamFormat: "anthropic"` — the historical way to add an Anthropic
 * interface for a vendor that already had an OpenAI provider row. Everything
 * else is OpenAI-only. Used wherever the explicit flags are absent: creating,
 * updating and reading rows written before these fields existed.
 */
export function defaultFaceFlags(
  kind: ProviderKind,
  upstreamFormat: UpstreamFormat,
): { openaiEnabled: boolean; anthropicEnabled: boolean } {
  const anthropicByDefault = kind === "anthropic" || upstreamFormat === "anthropic";
  return {
    openaiEnabled: !anthropicByDefault,
    anthropicEnabled: anthropicByDefault,
  };
}

// ---------------------------------------------------------------------------
// UsageLog
// ---------------------------------------------------------------------------

export const UsageLogSchema = z.object({
  id: z.string().min(1),
  apiKeyId: z.string().min(1),
  userId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string(),
  upstreamModel: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** 积分 consumed by this request, in integer 0.001-积分 units. */
  creditsUsed: z.number().int().nonnegative(),
  status: z.enum(["success", "error"]),
  errorMessage: z.string().nullable(),
  /**
   * `"usage"` means the upstream reported real token counts; `"estimated"`
   * means the stream ended without a usage frame and we billed by estimate.
   * Optional so older records keep parsing.
   */
  billingMode: z.enum(["usage", "estimated"]).optional(),
  createdAt: z.string(),
});
export type UsageLog = z.infer<typeof UsageLogSchema>;

// ---------------------------------------------------------------------------
// Validation results (used by proxy)
// ---------------------------------------------------------------------------

export type KeyValidationReason =
  | "ok"
  | "missing_key"
  | "key_not_found"
  | "key_disabled"
  | "key_force_disabled"
  | "key_expired"
  | "user_disabled"
  | "quota_exceeded_credits"
  | "quota_exceeded_tokens"
  | "model_not_allowed";

export interface KeyValidationResult {
  ok: boolean;
  reason: KeyValidationReason;
  key?: ApiKey;
  user?: User;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _unused, ...rest } = user;
  void _unused;
  return rest;
}

export function toPublicProvider(provider: Provider): PublicProvider {
  const { encryptedApiKey: _unused, ...rest } = provider;
  void _unused;
  return rest;
}


/**
 * Provider with model configurations.
 * Extends the base Provider with detailed model settings.
 */
export interface ProviderWithModels {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  enabled: boolean;
  priority: number;
  models: ModelConfig[];
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
