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
  /**
   * The key path's upstream. Empty on the account path, which has none of its
   * own — the turn runs through this deployment, so there is nothing to point
   * at and nothing to authenticate with.
   */
  baseUrl: string;
  /** Blank or omitted keeps the stored key. */
  apiKey?: string;
  /** The key path's model. Empty on the account path. */
  model: string;
  /** Which credential the next turn spends. Omitted keeps the stored one. */
  credentialMode?: "account" | "key" | null;
  /** The account path's model. `null` clears it; omitted leaves it alone. */
  accountModel?: string | null;
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
  /** How hard the model thinks, in its own spelling. `null` clears it. */
  reasoningEffort?: string | null;
  /**
   * Whether it thinks at all, in the vendor's own spelling. `null` clears it.
   *
   * Its own field because that is how the wire has it. MiniMax answers a
   * request carrying only `reasoning_effort` with a level, never a switch, so
   * without this column a user whose model supports turning thinking off has no
   * way to turn it off and no way to say so.
   */
  thinkingType?: string | null;
  /** New conversations start with search on/off. `null` means "the default". */
  webSearchDefault?: boolean | null;
  /** Results per search. `null` means six. */
  webSearchLimit?: number | null;
  /**
   * The user's own search service, as one complete endpoint URL.
   *
   * `null` clears it and `undefined` leaves it alone, the same two-way rule
   * as every other field here. An empty string is the same as `null`: there
   * is no search service any more, and the deployment's providers answer.
   */
  searchBaseUrl?: string | null;
  /**
   * Which search backend the assistant uses.
   *
   * `null` clears it back to the automatic rule (own service when there is an
   * address, the deployment's otherwise); `undefined` leaves it alone.
   */
  searchSource?: "deployment" | "own" | null;
  /**
   * Which of the **deployment's** search services the assistant searches with,
   * by its client-visible name.
   *
   * `null` means "the one the deployment serves by default", which is what
   * every account had before the services could be named. Only meaningful
   * when the source is the deployment's — the user's own service has no name
   * here, because it is not one of the deployment's.
   */
  searchServiceId?: string | null;
  /**
   * The key for that service. Blank or omitted keeps the stored one, exactly
   * like the assistant's own upstream key.
   *
   * `null` is different from blank: it is the explicit "delete it", which a
   * blank password box cannot express — a blank box has to mean "I did not
   * type it", not "remove what is there".
   */
  searchApiKey?: string | null;
}

/**
 * A patch that can say "leave it" and a patch that can say "clear it".
 *
 * `undefined` is not the same as `null` here, and collapsing them is how a
 * settings form that only edits the model name ends up resetting a temperature
 * somebody chose on purpose.
 */
function pick<T>(next: T | null | undefined, previous: T | null | undefined): T | null {
  return next === undefined ? (previous ?? null) : next;
}

/**
 * Insert or update the caller's assistant configuration.
 *
 * The key is only touched when a non-empty one is supplied, so the settings
 * form can save a changed model without the browser ever having to hold the
 * key again. It is also not *required* on the account path, which is the
 * change that lets the account path keep a model: a row has to exist to
 * remember one, and the old "no key, no row" rule meant there was nowhere to
 * put it.
 */
export async function saveAssistantSettings(
  userId: string,
  input: SaveAssistantSettingsInput,
): Promise<AssistantSettings> {
  const now = new Date().toISOString();
  const existing = await getAssistantSettings(userId);
  const encryptedApiKey =
    input.apiKey && input.apiKey.trim() ? encryptSecret(input.apiKey.trim()) : existing?.encryptedApiKey;

  const credentialMode = input.credentialMode === undefined ? (existing?.credentialMode ?? null) : input.credentialMode;

  // The key is required everywhere except the account path, which is the one
  // that has no upstream of its own. Refusing to save an account-path
  // configuration because it has no key was the rule that made the account
  // path impossible to configure at all.
  //
  // `!== "account"` and not `=== "key"`: a caller that names no mode is on the
  // key path (that is what a NULL column means), so the omission must not be a
  // way to write a keyless row and only find out on the first turn.
  if (credentialMode !== "account" && !encryptedApiKey) {
    throw new AssistantSettingsError("需要先配置 API 密钥");
  }

  const row = {
    userId,
    baseUrl: input.baseUrl.trim(),
    encryptedApiKey: encryptedApiKey ?? "",
    model: input.model.trim(),
    credentialMode,
    accountModel: input.accountModel === undefined ? (existing?.accountModel ?? null) : input.accountModel,
    protocol: input.protocol ?? existing?.protocol ?? "openai",
    extraHeaders: input.extraHeaders ?? existing?.extraHeaders ?? {},
    // `??` and not `||`: 0 is a legal temperature, and `||` would turn it
    // into the previous value.
    contextLength: pick(input.contextLength, existing?.contextLength),
    maxOutputTokens: pick(input.maxOutputTokens, existing?.maxOutputTokens),
    temperature: pick(input.temperature, existing?.temperature),
    topP: pick(input.topP, existing?.topP),
    reasoningEffort: pick(input.reasoningEffort, existing?.reasoningEffort),
    thinkingType: pick(input.thinkingType, existing?.thinkingType),
    webSearchDefault: pick(input.webSearchDefault, existing?.webSearchDefault ?? null),
    webSearchLimit: pick(input.webSearchLimit, existing?.webSearchLimit ?? null),
    // The user's own search service. An empty address means "no service of my
    // own" — the same answer as clearing it — and the key is kept, because
    // somebody who puts the address back does not want to retype the key.
    //
    // `undefined` is "leave it" and `null` is "clear it", the contract `pick`
    // states. Collapsing the two here is what made a cleared box come back
    // after a reload: the form said "saved" and the address was still there.
    // The route has always read `null` as "cleared" — it validates the address
    // that will be in effect *after* the save — so the two halves disagreed
    // about the same request.
    searchBaseUrl:
      input.searchBaseUrl === undefined
        ? (existing?.searchBaseUrl ?? null)
        : input.searchBaseUrl === null
          ? null
          : input.searchBaseUrl.trim() || null,
    // Which of the two the assistant searches. `null` is the automatic rule.
    searchSource: pick(input.searchSource, existing?.searchSource ?? null),
    // Which of the deployment's services, by its client-visible name.
    //
    // `null` clears the choice: the picker has an explicit "not chosen" entry
    // and picking it has to stick, or the form saves and then shows the old
    // answer again. `undefined` leaves the stored one alone.
    searchServiceId:
      input.searchServiceId === undefined
        ? (existing?.searchServiceId ?? null)
        : input.searchServiceId === null
          ? null
          : input.searchServiceId.trim() || null,
    // `null` is the explicit "delete it"; blank means "I did not type one" and
    // keeps whatever is stored.
    encryptedSearchApiKey:
      input.searchApiKey === null
        ? null
        : input.searchApiKey && input.searchApiKey.trim()
          ? encryptSecret(input.searchApiKey.trim())
          : (existing?.encryptedSearchApiKey ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  run(
    `INSERT INTO assistant_settings
       (user_id, base_url, encrypted_api_key, model, credential_mode, account_model,
        protocol, extra_headers, context_length, max_output_tokens, temperature, top_p,
        reasoning_effort, thinking_type, web_search_default, web_search_limit,
        search_base_url, encrypted_search_api_key, search_source, search_service_id,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       base_url = excluded.base_url,
       encrypted_api_key = excluded.encrypted_api_key,
       model = excluded.model,
       credential_mode = excluded.credential_mode,
       account_model = excluded.account_model,
       protocol = excluded.protocol,
       extra_headers = excluded.extra_headers,
       context_length = excluded.context_length,
       max_output_tokens = excluded.max_output_tokens,
       temperature = excluded.temperature,
       top_p = excluded.top_p,
       reasoning_effort = excluded.reasoning_effort,
       thinking_type = excluded.thinking_type,
       web_search_default = excluded.web_search_default,
       web_search_limit = excluded.web_search_limit,
       search_base_url = excluded.search_base_url,
       encrypted_search_api_key = excluded.encrypted_search_api_key,
       search_source = excluded.search_source,
       search_service_id = excluded.search_service_id,
       updated_at = excluded.updated_at`,
    [
      row.userId,
      row.baseUrl,
      row.encryptedApiKey,
      row.model,
      row.credentialMode,
      row.accountModel,
      row.protocol,
      JSON.stringify(row.extraHeaders),
      row.contextLength ?? null,
      row.maxOutputTokens ?? null,
      row.temperature ?? null,
      row.topP ?? null,
      row.reasoningEffort ?? null,
      row.thinkingType ?? null,
      // Boolean columns are INTEGER in SQLite; `pick` keeps null meaning "use
      // the default", so it must not be coerced to false here.
      row.webSearchDefault === null || row.webSearchDefault === undefined
        ? null
        : row.webSearchDefault
          ? 1
          : 0,
      row.webSearchLimit ?? null,
      row.searchBaseUrl ?? null,
      row.encryptedSearchApiKey ?? null,
      row.searchSource ?? null,
      row.searchServiceId ?? null,
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
  /**
   * The conversation's name.
   *
   * The callers pass it in the reader's language — it is stored, so it has to
   * be right the first time. The default is a last resort for a caller that
   * has no title to offer.
   */
  title = "新对话",
  webSearch: boolean | null = null,
): Promise<AssistantThread> {
  const now = new Date().toISOString();
  const thread: AssistantThread = {
    id: generateId(),
    userId,
    title: title.trim().slice(0, 120) || "新对话",
    webSearch,
    createdAt: now,
    updatedAt: now,
  };
  run(
    `INSERT INTO assistant_threads (id, user_id, title, web_search, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    [
      thread.id,
      thread.userId,
      thread.title,
      webSearch === null ? null : webSearch ? 1 : 0,
      thread.createdAt,
      thread.updatedAt,
    ],
  );
  return thread;
}

/** Remember this conversation's web-search choice. */
export async function setAssistantThreadWebSearch(
  userId: string,
  threadId: string,
  webSearch: boolean,
): Promise<AssistantThread | null> {
  const changed = run(
    "UPDATE assistant_threads SET web_search = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    [webSearch ? 1 : 0, new Date().toISOString(), threadId, userId],
  );
  return changed > 0 ? getAssistantThread(userId, threadId) : null;
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
  /** What the model thought, kept so a reload shows the same turn again. */
  reasoning?: string | null;
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
    reasoning: input.reasoning ?? null,
    toolCalls: input.toolCalls ?? [],
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName ?? null,
    attachments: input.attachments ?? [],
    createdAt: now,
  };
  run(
    `INSERT INTO assistant_messages
       (id, thread_id, role, content, reasoning, tool_calls, tool_call_id, tool_name, attachments, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      message.id,
      message.threadId,
      message.role,
      message.content,
      message.reasoning ?? null,
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

/**
 * Take a pending proposal back out of the queue.
 *
 * Separate from {@link setAssistantActionStatus} because the condition is the
 * point: only a `pending` row can be withdrawn, and a row that has already been
 * resolved cannot. Without the predicate, "withdraw" would be a quieter way to
 * rewrite history — a status update on an applied row would leave the
 * configuration it produced in place and the queue disagreeing with the
 * database.
 *
 * Returns false when there was nothing pending to withdraw, which is the honest
 * answer to "did you take it back": a proposal that was already approved is
 * still approved.
 */
export async function withdrawAssistantAction(
  userId: string,
  actionId: string,
  result = "助手撤回",
): Promise<boolean> {
  return (
    run(
      "UPDATE assistant_actions SET status = 'rejected', result = ?, resolved_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
      [result, new Date().toISOString(), actionId, userId],
    ) > 0
  );
}

/**
 * Write a terminal status onto a proposal, from a state it has to still be in.
 *
 * The condition is the point — the same reason
 * {@link withdrawAssistantAction} carries its own. This setter had none, so the
 * reject path could land on a row an approve had already resolved: one proposal
 * open in two tabs, 同意 in the first and 拒绝 in the second, and the
 * configuration was changed and marked `applied` before the second request's
 * unconditional UPDATE overwrote it with `rejected`. The queue then said the
 * change was refused while the database held it — the exact state
 * {@link withdrawAssistantAction} was written to prevent, reached through the
 * generic setter written to be safe everywhere.
 *
 * `from` defaults to `pending`, which is what a decision on an unclaimed row
 * needs. The paths that run *after* {@link claimAssistantAction} have already
 * moved the row to `applied` — the claim writes that status before the change
 * is attempted, so a failure still leaves a row that is not pending — and those
 * pass `"applied"` to say so. Without that, every post-apply write would match
 * no row and silently drop the message the administrator reads.
 *
 * Returns false when the row was not in `from` — the honest answer to "did this
 * land", rather than reporting a status it did not write.
 */
export async function setAssistantActionStatus(
  userId: string,
  actionId: string,
  status: AssistantActionStatus,
  result: string,
  from: AssistantActionStatus = "pending",
): Promise<boolean> {
  return (
    run(
      "UPDATE assistant_actions SET status = ?, result = ?, resolved_at = ? WHERE id = ? AND user_id = ? AND status = ?",
      [status, result, new Date().toISOString(), actionId, userId, from],
    ) > 0
  );
}
