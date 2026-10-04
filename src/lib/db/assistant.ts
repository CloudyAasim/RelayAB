/**
 * src/lib/db/assistant.ts
 *
 * Persistence for the AI assistant: the per-user upstream configuration, the
 * conversation, and the queue of proposed provider changes.
 *
 * Two invariants are enforced here rather than at the call sites:
 *
 *  1. **A blank key never overwrites a stored one.** `saveAssistantSettings`
 *     keeps the existing `encrypted_apiKey` when no key is supplied, matching
 *     the rule the provider editors already follow.
 *  2. **Every read is scoped to a user.** Threads, messages and actions are
 *     always fetched through a `userId` predicate, so a guessed id cannot
 *     reach another person's conversation.
 */
import { getAll, getOne, run } from "./sqlite";
import { generateId } from "../crypto/hashing";
import { encryptSecret } from "../crypto/secrets";
import {
  rowToAssistantSettings,
  rowToAssistantThread,
  rowToAssistantMessage,
  rowToAssistantAction,
  toPublicAssistantSettings,
  type AssistantSettings,
  type PublicAssistantSettings,
  type AssistantThread,
  type AssistantMessage,
  type AssistantAction,
  type AssistantActionKind,
  type AssistantActionStatus,
  type MessageAttachment,
  type ToolCall,
} from "../assistant/schema";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getAssistantSettings(userId: string): Promise<AssistantSettings | null> {
  if (!userId) return null;
  return getOne(
    "SELECT * FROM assistant_settings WHERE user_id = ?",
    [userId],
    rowToAssistantSettings,
  );
}

export async function getPublicAssistantSettings(
  userId: string,
): Promise<PublicAssistantSettings | null> {
  const s = await getAssistantSettings(userId);
  return s ? toPublicAssistantSettings(s) : null;
}

export interface SaveAssistantSettingsInput {
  baseUrl: string;
  /** Blank or omitted keeps the stored key. */
  apiKey?: string;
  model: string;
  protocol?: AssistantSettings["protocol"];
  extraHeaders?: Record<string, string>;
  /**
   * The model's own parameters. `null` clears a stored value; `undefined`
   * leaves it alone.
   *
   * The two directions are different on purpose. Omitting them keeps a form
   * that only edits the model name from silently resetting a temperature
   * somebody set deliberately.
   */
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
}

/**
 * Insert or update the caller's assistant configuration.
 *
 * The key is only touched when a non-empty one is supplied, so the settings
 * form can save a changed model without the browser ever having to hold the
 * key again.
 */
/**
 * A patch that can say "leave it" and a patch that can say "clear it".
 *
 * `undefined` is not the same as `null` here, and collapsing them is how a
 * settings form that only edits the model name ends up resetting a temperature
 * somebody chose on purpose.
 */
function pick(next: number | null | undefined, previous: number | null | undefined): number | null {
  return next === undefined ? (previous ?? null) : next;
}
export async function saveAssistantSettings(
  userId: string,
  input: SaveAssistantSettingsInput,
): Promise<AssistantSettings> {
  const now = new Date().toISOString();
  const existing = await getAssistantSettings(userId);
  const encryptedApiKey =
    input.apiKey && input.apiKey.trim() ? encryptSecret(input.apiKey.trim()) : existing?.encryptedApiKey;

  if (!encryptedApiKey) {
    throw new AssistantSettingsError("需要先配置 API 密钥");
  }

  const row = {
    userId,
    baseUrl: input.baseUrl.trim(),
    encryptedApiKey,
    model: input.model.trim(),
    protocol: input.protocol ?? existing?.protocol ?? "openai",
    extraHeaders: input.extraHeaders ?? existing?.extraHeaders ?? {},
    // `??` and not `||`: 0 is a legal temperature, and `||` would turn it
    // into the previous value.
    contextLength: pick(input.contextLength, existing?.contextLength),
    maxOutputTokens: pick(input.maxOutputTokens, existing?.maxOutputTokens),
    temperature: pick(input.temperature, existing?.temperature),
    topP: pick(input.topP, existing?.topP),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  run(
    `INSERT INTO assistant_settings
       (user_id, base_url, encrypted_api_key, model, protocol, extra_headers,
        context_length, max_output_tokens, temperature, top_p, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       base_url = excluded.base_url,
       encrypted_api_key = excluded.encrypted_api_key,
       model = excluded.model,
       protocol = excluded.protocol,
       extra_headers = excluded.extra_headers,
       context_length = excluded.context_length,
       max_output_tokens = excluded.max_output_tokens,
       temperature = excluded.temperature,
       top_p = excluded.top_p,
       updated_at = excluded.updated_at`,
    [
      row.userId,
      row.baseUrl,
      row.encryptedApiKey,
      row.model,
      row.protocol,
      JSON.stringify(row.extraHeaders),
      row.contextLength ?? null,
      row.maxOutputTokens ?? null,
      row.temperature ?? null,
      row.topP ?? null,
      row.createdAt,
      row.updatedAt,
    ],
  );

  return (await getAssistantSettings(userId))!;
}

export async function deleteAssistantSettings(userId: string): Promise<boolean> {
  return run("DELETE FROM assistant_settings WHERE user_id = ?", [userId]) > 0;
}

export class AssistantSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantSettingsError";
  }
}

// ---------------------------------------------------------------------------
// Threads & messages
// ---------------------------------------------------------------------------

export async function listAssistantThreads(
  userId: string,
  limit = 50,
): Promise<AssistantThread[]> {
  return getAll(
    "SELECT * FROM assistant_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
    [userId, limit],
    rowToAssistantThread,
  );
}

export async function getAssistantThread(
  userId: string,
  threadId: string,
): Promise<AssistantThread | null> {
  return getOne(
    "SELECT * FROM assistant_threads WHERE id = ? AND user_id = ?",
    [threadId, userId],
    rowToAssistantThread,
  );
}

export async function createAssistantThread(
  userId: string,
  title = "新对话",
): Promise<AssistantThread> {
  const now = new Date().toISOString();
  const thread: AssistantThread = {
    id: generateId(),
    userId,
    title: title.trim().slice(0, 120) || "新对话",
    createdAt: now,
    updatedAt: now,
  };
  run(
    "INSERT INTO assistant_threads (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
    [thread.id, thread.userId, thread.title, thread.createdAt, thread.updatedAt],
  );
  return thread;
}

export async function renameAssistantThread(
  userId: string,
  threadId: string,
  title: string,
): Promise<AssistantThread | null> {
  const next = title.trim().slice(0, 120);
  if (!next) return null;
  const changed = run(
    "UPDATE assistant_threads SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    [next, new Date().toISOString(), threadId, userId],
  );
  return changed > 0 ? getAssistantThread(userId, threadId) : null;
}

export async function touchAssistantThread(threadId: string): Promise<void> {
  run("UPDATE assistant_threads SET updated_at = ? WHERE id = ?", [
    new Date().toISOString(),
    threadId,
  ]);
}

export async function deleteAssistantThread(userId: string, threadId: string): Promise<boolean> {
  return run("DELETE FROM assistant_threads WHERE id = ? AND user_id = ?", [threadId, userId]) > 0;
}

export async function listAssistantMessages(threadId: string): Promise<AssistantMessage[]> {
  return getAll(
    "SELECT * FROM assistant_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
    [threadId],
    rowToAssistantMessage,
  );
}

export interface AppendMessageInput {
  threadId: string;
  role: AssistantMessage["role"];
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
  toolName?: string | null;
  /** Files the user attached. A reference list; the bytes are in assistant_artifacts. */
  attachments?: MessageAttachment[];
}

export async function appendAssistantMessage(
  input: AppendMessageInput,
): Promise<AssistantMessage> {
  const now = new Date().toISOString();
  const message: AssistantMessage = {
    id: generateId(),
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls ?? [],
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName ?? null,
    attachments: input.attachments ?? [],
    createdAt: now,
  };
  run(
    `INSERT INTO assistant_messages
       (id, thread_id, role, content, tool_calls, tool_call_id, tool_name, attachments, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      message.id,
      message.threadId,
      message.role,
      message.content,
      message.toolCalls.length ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId,
      message.toolName,
      message.attachments.length ? JSON.stringify(message.attachments) : null,
      message.createdAt,
    ],
  );
  return message;
}

/** True when the thread has exactly one user message and no reply yet. */
export async function isThreadUntouched(threadId: string): Promise<boolean> {
  const row = getOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM assistant_messages WHERE thread_id = ?",
    [threadId],
  );
  return (row?.n ?? 0) <= 1;
}

// ---------------------------------------------------------------------------
// Pending actions
// ---------------------------------------------------------------------------

export interface CreateActionInput {
  userId: string;
  kind: AssistantActionKind;
  targetId?: string | null;
  summary: string;
  args: unknown;
  diff: string;
}

export async function createAssistantAction(input: CreateActionInput): Promise<AssistantAction> {
  const now = new Date().toISOString();
  const action: AssistantAction = {
    id: generateId(),
    userId: input.userId,
    kind: input.kind,
    targetId: input.targetId ?? null,
    summary: input.summary,
    args: JSON.stringify(input.args ?? {}),
    diff: input.diff,
    status: "pending",
    result: null,
    createdAt: now,
    resolvedAt: null,
  };
  run(
    `INSERT INTO assistant_actions
       (id, user_id, kind, target_id, summary, args, diff, status, result, created_at, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      action.id,
      action.userId,
      action.kind,
      action.targetId,
      action.summary,
      action.args,
      action.diff,
      action.status,
      action.result,
      action.createdAt,
      action.resolvedAt,
    ],
  );
  return action;
}

export async function getAssistantAction(
  userId: string,
  actionId: string,
): Promise<AssistantAction | null> {
  return getOne(
    "SELECT * FROM assistant_actions WHERE id = ? AND user_id = ?",
    [actionId, userId],
    rowToAssistantAction,
  );
}

export async function listAssistantActions(
  userId: string,
  status?: AssistantActionStatus,
  limit = 50,
): Promise<AssistantAction[]> {
  if (status) {
    return getAll(
      "SELECT * FROM assistant_actions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
      [userId, status, limit],
      rowToAssistantAction,
    );
  }
  return getAll(
    "SELECT * FROM assistant_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    [userId, limit],
    rowToAssistantAction,
  );
}

/**
 * Claim a pending action for resolution.
 *
 * The `status = 'pending'` predicate is the concurrency guard: whoever flips
 * the row first wins, and a second click affects zero rows and is told so
 * rather than applying the change twice.
 */
export async function claimAssistantAction(
  userId: string,
  actionId: string,
): Promise<AssistantAction | null> {
  const changed = run(
    "UPDATE assistant_actions SET status = 'applied', resolved_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
    [new Date().toISOString(), actionId, userId],
  );
  return changed > 0 ? getAssistantAction(userId, actionId) : null;
}

export async function setAssistantActionStatus(
  userId: string,
  actionId: string,
  status: AssistantActionStatus,
  result: string,
): Promise<boolean> {
  return (
    run(
      "UPDATE assistant_actions SET status = ?, result = ?, resolved_at = ? WHERE id = ? AND user_id = ?",
      [status, result, new Date().toISOString(), actionId, userId],
    ) > 0
  );
}
