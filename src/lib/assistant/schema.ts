/**
 * src/lib/assistant/schema.ts
 *
 * Entities for the AI assistant: the per-user upstream configuration, the
 * conversation, and the pending-change queue.
 *
 * These live here rather than in `db/types.ts` because the proxy/billing core
 * and the assistant are separate bounded contexts — nothing in the request path
 * imports an assistant type, and the tables are only ever touched by the
 * assistant's own modules. The row↔entity mapping convention is the same one
 * `db/types.ts` uses: one Zod schema, read straight through on every load.
 */
import { z } from "zod";

/**
 * How the user's own upstream speaks. Only OpenAI-compatible chat completions
 * is supported today; `protocol` exists so an Anthropic-style upstream can be
 * added without a second settings table, and so a stored row from a future
 * version fails validation loudly instead of being silently mis-routed.
 */
export const AssistantProtocolSchema = z.enum(["openai"]);
export type AssistantProtocol = z.infer<typeof AssistantProtocolSchema>;

export const AssistantSettingsSchema = z.object({
  userId: z.string().min(1),
  /**
   * Empty is allowed, and it means "not stored".
   *
   * The column is `NOT NULL` — SQLite cannot drop that without rebuilding the
   * table on a live deployment — so the account path, which by construction has
   * no upstream of its own, stores the empty string rather than the row not
   * existing. A row is needed to remember which model the account path uses,
   * and a fake base URL would be worse than an honest blank.
   */
  baseUrl: z.string(),
  encryptedApiKey: z.string(),
  model: z.string(),
  /** Which credential the next turn spends. NULL means the key path. */
  credentialMode: z.enum(["account", "key"]).nullable().default(null),
  /** The account path's model: one of this deployment's own. */
  accountModel: z.string().nullable().default(null),
  protocol: AssistantProtocolSchema.default("openai"),
  /** Extra headers some gateways require (e.g. an OpenAI org id). Never the key. */
  extraHeaders: z.record(z.string(), z.string()).default({}),
  /**
   * The model's own parameters, all optional.
   *
   * The assistant's model is the caller's own upstream rather than one of the
   * operator's provider rows, so nothing forced these to exist — and the
   * consequences were real: the history was bounded by a message count with
   * no idea what it weighed, and the upstream chose the answer length.
   *
   * **No defaults.** Absent means "do not send this", not "send a sensible
   * one": a defaulted temperature makes a model answer differently after a
   * deploy, and a defaulted output cap silently shortens long answers. These
   * are the caller's numbers about the caller's model, and `null` is how they
   * say "I have not decided".
   */
  /** Declared context window; the history is trimmed to fit it. */
  contextLength: z.number().int().positive().nullable().optional(),
  /** Sent as `max_tokens`; absent leaves the length to the upstream. */
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  /**
   * How hard the model thinks, as this model's own spelling of its levels.
   *
   * Free text rather than an enum, and nullable on top of that: the levels are
   * published per model, some models can switch thinking off, and a model that
   * does not think has none to publish. An enum would be a list that is wrong
   * for most of the models here, and wrong silently.
   */
  reasoningEffort: z.string().min(1).max(64).nullable().optional(),
  /**
   * Whether the model thinks, in the vendor's own spelling.
   *
   * Its own field rather than another value of `reasoningEffort` because on the
   * wire it is a different parameter with a different shape — a level answers
   * "how hard", this answers "whether at all", and a vendor that accepts one
   * does not accept the other.
   */
  thinkingType: z.string().min(1).max(64).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantSettings = z.infer<typeof AssistantSettingsSchema>;

/** Settings as the API returns them: the key is never echoed back. */
export const PublicAssistantSettingsSchema = AssistantSettingsSchema.omit({
  encryptedApiKey: true,
}).extend({
  /** Whether a key is stored, so the UI can show "configured" without the value. */
  hasApiKey: z.boolean(),
});
export type PublicAssistantSettings = z.infer<typeof PublicAssistantSettingsSchema>;

export const AssistantThreadSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantThread = z.infer<typeof AssistantThreadSchema>;

export const AssistantRoleSchema = z.enum(["user", "assistant", "tool"]);
export type AssistantRole = z.infer<typeof AssistantRoleSchema>;

/**
 * One OpenAI-shaped tool call, kept verbatim so the next request can replay the
 * exact call the model made. Re-serialising it from a narrower shape would lose
 * provider-specific fields and break the protocol on the following turn.
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.string().default("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Files a user attached to a message.
 *
 * Kept beside `content` rather than inside it. A screenshot is 200 KB of
 * base64 that the model does not need in the stored transcript, and the same
 * argument that keeps tool artefacts out of `content` keeps uploads out of it.
 * The bytes live in `assistant_artifacts`; this is the reference to them, which
 * is what lets the conversation show the picture and the next turn still have
 * it available.
 */
export const MessageAttachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "audio", "video"]),
  contentType: z.string(),
  url: z.string(),
  bytes: z.number().nullable(),
  name: z.string(),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const AssistantMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: AssistantRoleSchema,
  content: z.string(),
  /** The thinking, or null for a turn that had none or predates the column. */
  reasoning: z.string().nullable().default(null),
  toolCalls: z.array(ToolCallSchema).default([]),
  toolCallId: z.string().nullable().default(null),
  toolName: z.string().nullable().default(null),
  attachments: z.array(MessageAttachmentSchema).default([]),
  createdAt: z.string(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/**
 * What the assistant is allowed to *propose*. It can never write provider
 * configuration itself — every one of these lands in `assistant_actions` and
 * waits for a human.
 */
export const AssistantActionKindSchema = z.enum([
  "provider.update",
  "provider.create",
  "media_provider.update",
  "media_provider.create",
  // The operator's own documentation chapter. A whole-list replacement like the
  // others, and for the same reason: the diff is the only thing between the
  // model and somebody's own writing disappearing.
  "doc_pages.update",
]);
export type AssistantActionKind = z.infer<typeof AssistantActionKindSchema>;

export const AssistantActionStatusSchema = z.enum([
  "pending",
  "applied",
  "rejected",
  "failed",
]);
export type AssistantActionStatus = z.infer<typeof AssistantActionStatusSchema>;

export const AssistantActionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kind: AssistantActionKindSchema,
  targetId: z.string().nullable().default(null),
  summary: z.string(),
  /** Exactly what will be handed to the provider layer on approval. */
  args: z.string(),
  /** Rendered before/after preview. Stored so the decision outlives the page. */
  diff: z.string(),
  status: AssistantActionStatusSchema.default("pending"),
  result: z.string().nullable().default(null),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
});
export type AssistantAction = z.infer<typeof AssistantActionSchema>;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt column must not take down the read; the schema's defaults and
    // the caller's own validation take over.
    return fallback;
  }
}

export function rowToAssistantSettings(row: Record<string, unknown>): AssistantSettings {
  return AssistantSettingsSchema.parse({
    userId: row.user_id,
    baseUrl: row.base_url,
    encryptedApiKey: row.encrypted_api_key,
    model: row.model,
    credentialMode: (row.credential_mode as "account" | "key" | null) ?? null,
    accountModel: (row.account_model as string | null) ?? null,
    protocol: row.protocol,
    extraHeaders: parseJson(row.extra_headers, {}),
    // Passed through as null rather than coerced: absent and 0 are different
    // for `temperature`, and only one of them is a number the upstream wants.
    contextLength: (row.context_length as number | null) ?? null,
    maxOutputTokens: (row.max_output_tokens as number | null) ?? null,
    temperature: (row.temperature as number | null) ?? null,
    topP: (row.top_p as number | null) ?? null,
    reasoningEffort: (row.reasoning_effort as string | null) ?? null,
    thinkingType: (row.thinking_type as string | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function toPublicAssistantSettings(s: AssistantSettings): PublicAssistantSettings {
  const { encryptedApiKey, ...rest } = s;
  void encryptedApiKey;
  return { ...rest, hasApiKey: Boolean(s.encryptedApiKey) };
}

export function rowToAssistantThread(row: Record<string, unknown>): AssistantThread {
  return AssistantThreadSchema.parse({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function rowToAssistantMessage(row: Record<string, unknown>): AssistantMessage {
  return AssistantMessageSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    // Absent on every row written before the column existed, which is correct:
    // those turns either had no reasoning or lost it before it could be stored.
    reasoning: (row.reasoning as string | null) ?? null,
    toolCalls: parseJson(row.tool_calls, []),
    toolCallId: row.tool_call_id ?? null,
    toolName: row.tool_name ?? null,
    attachments: parseJson(row.attachments, []),
    createdAt: row.created_at,
  });
}

export function rowToAssistantAction(row: Record<string, unknown>): AssistantAction {
  return AssistantActionSchema.parse({
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    targetId: row.target_id ?? null,
    summary: row.summary,
    args: row.args,
    diff: row.diff,
    status: row.status,
    result: row.result ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  });
}
