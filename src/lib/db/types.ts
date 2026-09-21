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

export const ProviderKindSchema = z.enum(["openai", "anthropic", "custom-openai"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

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
  quotaType: QuotaTypeSchema,
  /**
   * Unit depends on `quotaType`:
   *   "credits" → 积分, stored as integer 0.001-积分 units (see quota/credits.ts)
   *   "tokens"  → tokens
   */
  quotaLimit: z.number().int().nonnegative(),
  /** Same unit as `quotaLimit`; incremented per successful request. */
  quotaUsed: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  enabled: z.boolean(),
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

export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  kind: ProviderKindSchema,
  baseUrl: z.string().nullable(),
  encryptedApiKey: z.string().min(1), // base64
  modelMapping: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  priority: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export type PublicProvider = Omit<Provider, "encryptedApiKey">;

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
  | "key_expired"
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
