/**
 * src/lib/assistant/chat.ts
 *
 * The turn loop: ask the model, run whatever tools it asked for, feed the
 * results back, repeat until it answers in prose.
 *
 * Three guards shape it:
 *
 *  - **Tool errors are results, not exceptions.** A failing tool comes back to
 *    the model as text describing the failure, so the model can explain it or
 *    try something else. Letting it throw would end the turn and lose whatever
 *    the assistant had already worked out.
 *  - **A round ceiling that is out of the way.** It used to be eight, which is
 *    below what a real task needs: look up the model, read the provider, probe
 *    the host, propose the change — that is four rounds before the conversation
 *    has even started, and the turn ended mid-thought with a message about a
 *    budget the reader had never heard of. It is high now, and the loop shapes
 *    that actually go wrong are caught on their own terms instead.
 *  - **Progress, not budget.** A model that calls the same tool with the same
 *    arguments three rounds running is not working, it is stuck, and no round
 *    count can tell the two apart. So that is checked directly, along with a
 *    wall-clock deadline — the two failures that would otherwise hang a request
 *    open and run up an upstream bill.
 */
import { callAssistantModel, UpstreamError, type ChatMessage, type ContentPart, type UpstreamTurn } from "./client";
import { toolDefinitions, executeTool, type ToolContext } from "./tools";
import { systemPrompt } from "./prompts";
import type { ResolvedCredential } from "./credentials";
import type { RawArtifact } from "./tools";
import { artifactRef, getAssistantArtifact, saveAssistantArtifact, type ArtifactRef } from "../db/assistant-artifacts";
import { decryptSecret } from "../crypto/secrets";
import {
  appendAssistantMessage,
  listAssistantMessages,
  touchAssistantThread,
  isThreadUntouched,
  renameAssistantThread,
} from "../db/assistant";
import type { AssistantSettings, AssistantThread, MessageAttachment } from "./schema";
import type { Locale } from "../i18n/dict";
import type { DocPage } from "../docs/custom";
import type { AuthedUser } from "../auth/session";

/**
 * Out of the way on purpose.
 *
 * Still a ceiling — an unbounded loop is a hung request and an unbounded
 * upstream bill — but high enough that no real task reaches it. The checks that
 * matter are `MAX_IDENTICAL_CALLS` and `MAX_TURN_MS` below.
 */
const MAX_ROUNDS = 40;

/** The same call, with the same arguments, this many rounds running. */
export const MAX_IDENTICAL_CALLS = 3;

/** A turn nobody would sit and wait for. */
export const MAX_TURN_MS = 10 * 60 * 1000;

/** How much history to replay. Older turns are dropped rather than truncated. */
const MAX_HISTORY_MESSAGES = 40;

/**
 * The ceiling on one tool result.
 *
 * Sized against the largest payload a tool legitimately returns — the media
 * provider configuration, which is a few thousand characters of spec documents
 * that the model has to be able to read in full and copy. Set too low it does
 * not shorten a result so much as corrupt it.
 */
export const MAX_TOOL_RESULT_CHARS = 24_000;

/**
 * What makes a tool call the *same* call.
 *
 * Key order is not identity: a model that re-emits `{a,b}` as `{b,a}` has not
 * learned anything, and treating it as a new call would let a stuck loop run
 * forever. Unparseable arguments are compared as written, which is the only
 * honest thing to do with them.
 */
export function callSignature(name: string, args: string): string {
  let canonical = args;
  try {
    const parsed: unknown = JSON.parse(args);
    const sort = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(sort);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, val]) => [k, sort(val)]),
        );
      }
      return v;
    };
    canonical = JSON.stringify(sort(parsed)) ?? args;
  } catch {
    /* not JSON — compare as written */
  }
  return `${name}(${canonical})`;
}

/**
 * The call that is repeating at the tail of this turn, if any.
 *
 * `limit` identical signatures in a row is the shape of a model that is not
 * making progress. Two in a row is normal — read a provider, then act on it —
 * so the threshold is three.
 */
export function repeatedCall(
  signatures: readonly string[],
  limit: number = MAX_IDENTICAL_CALLS,
): string | null {
  if (limit < 2 || signatures.length < limit) return null;
  const tail = signatures.slice(-limit);
  return tail.every((s) => s === tail[0]) ? tail[0] : null;
}

/** `generate_image({"prompt":"a"})` → `generate_image`, for a message a person reads. */
function toolNameOf(signature: string): string {
  const at = signature.indexOf("(");
  return at === -1 ? signature : signature.slice(0, at);
}

/**
 * Field names that hold a secret, whatever the model was told.
 *
 * The tools have no parameter a key could go in, which makes the stored action
 * safe. It does not make the *transcript* safe: the model's tool call is
 * persisted verbatim, so a model that ignored the instruction and passed an
 * `apiKey` anyway would write a plaintext key into `assistant_messages` — and
 * that is the row every later turn replays.
 *
 * So the field is redacted on the way to the database. The model still sees its
 * own argument in the live request, so nothing about the turn's behaviour
 * changes; only the copy that outlives it is scrubbed.
 */
const SECRET_FIELDS = /("(?:api[_-]?key|secret|password|token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** The tool calls as they are stored, with anything key-shaped taken out. */
export function redactToolCalls(
  toolCalls: UpstreamTurn["toolCalls"],
): UpstreamTurn["toolCalls"] {
  return toolCalls.map((call) => ({
    ...call,
    function: {
      ...call.function,
      arguments: call.function.arguments.replace(SECRET_FIELDS, '$1"***"'),
    },
  }));
}

export interface ChatEvent {
  type: "delta" | "tool" | "done" | "error" | "action" | "artifact";
  text?: string;
  toolName?: string;
  data?: unknown;
  /** Media a tool just produced, so the conversation can show it as it lands. */
  artifacts?: ArtifactRef[];
}

export interface RunChatOptions {
  user: AuthedUser;
  settings: AssistantSettings;
  thread: AssistantThread;
  message: string;
  /**
   * Files the user attached to this turn, already stored as artefacts.
   *
   * The bytes never appear here — only references. That keeps a 2 MB
   * screenshot out of the stored transcript, which is the same rule tool
   * artefacts follow, and it is the route the conversation renders from.
   */
  attachments?: MessageAttachment[];
  /**
   * What the tools are allowed to spend, already resolved by the route.
   *
   * Required rather than optional, so every call site has to decide. An earlier
   * version inferred a credential here — reusing the assistant's own upstream key
   * whenever it happened to point at this deployment — which made the feature
   * work without asking but also meant a switch the user had turned off kept
   * working. Resolving it once, in the route, is what makes the switch real.
   */
  credential: ResolvedCredential;
  /** Resolved by the route while the request context is still live. */
  gatewayBase?: string;
  /**
   * The reader's language, resolved by the route.
   *
   * The route has to do it, because the tool loop runs inside a stream callback
   * where `next/headers` no longer resolves. A documentation tool that answered
   * in the wrong language would be worse than not having one.
   */
  locale?: Locale;
  /** The operator's own documentation pages, resolved by the route. */
  docPages?: DocPage[];
  signal?: AbortSignal;
  emit: (event: ChatEvent) => void;
}

/**
 * Persist what a tool produced and hand back short references to it.
 *
 * A row per artefact, owned by the user and cascading with their thread. The
 * failure path is deliberately quiet: a conversation that cannot store a picture
 * still gets the tool's text, because losing the transcript over an unwritable
 * blob would be a much worse outcome than a missing image.
 */
async function storeArtifacts(args: {
  userId: string;
  threadId: string;
  artifacts: RawArtifact[];
}): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  for (const artifact of args.artifacts) {
    try {
      const saved = await saveAssistantArtifact({
        userId: args.userId,
        threadId: args.threadId,
        kind: artifact.kind,
        contentType: artifact.contentType,
        ...(artifact.url ? { url: artifact.url } : {}),
        ...(artifact.base64 ? { bytes: new Uint8Array(Buffer.from(artifact.base64, "base64")) } : {}),
      });
      refs.push(artifactRef(saved));
    } catch {
      // Skip this one and keep the rest.
    }
  }
  return refs;
}

/**
 * Add the references to a tool's JSON result, leaving anything that is not
 * parseable JSON alone — a refusal message is prose, and rewriting it as JSON
 * would only confuse the model.
 */
function withArtifactRefs(content: string, refs: ArtifactRef[]): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return content;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), artifacts: refs }, null, 2);
  } catch {
    return content;
  }
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  const { user, settings, thread, message, credential, signal, emit } = opts;
  const apiKey = decryptSecret(settings.encryptedApiKey);
  const isAdmin = user.role === "admin";
  const tools = toolDefinitions(isAdmin);
  const ctx: ToolContext = {
    user,
    ...(credential.kind === "key" ? { relayKey: credential.relayKey } : {}),
    ...(credential.kind === "account" ? { account: credential.account } : {}),
    ...(opts.gatewayBase ? { gatewayBase: opts.gatewayBase } : {}),
    // So a tool can be told "use the picture the user just sent" instead of the
    // model having to paste a megabyte of base64 to name it.
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.docPages ? { docPages: opts.docPages } : {}),
  };

  // The user's turn goes in first so it is persisted even if the upstream is
  // unreachable — losing the typed message would be the worse failure.
  const attachments = opts.attachments ?? [];
  await appendAssistantMessage({ threadId: thread.id, role: "user", content: message, attachments });
  if (await isThreadUntouched(thread.id)) {
    await renameAssistantThread(user.id, thread.id, message);
  }

  const history = await listAssistantMessages(thread.id);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(isAdmin) },
    ...(await toWireMessages(history.slice(-MAX_HISTORY_MESSAGES), user.id)),
  ];

  const pendingActions: string[] = [];
  let finalText = "";
  let usage: UpstreamTurn["usage"] = null;

  // What a stop is *for*, decided at the end of each round rather than guessed
  // at from a counter. Null means "keep going".
  let stopReason: string | null = null;
  let rounds = 0;
  const signatures: string[] = [];
  const startedAt = Date.now();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    let turn: UpstreamTurn;
    try {
      turn = await callAssistantModel({
        baseUrl: settings.baseUrl,
        apiKey,
        model: settings.model,
        extraHeaders: settings.extraHeaders,
        messages,
        tools,
        signal,
        onText: (delta) => emit({ type: "delta", text: delta }),
      });
    } catch (err) {
      const message_ =
        err instanceof UpstreamError
          ? `上游调用失败（HTTP ${err.status}）：${err.message}`
          : `调用失败：${err instanceof Error ? err.message : String(err)}`;
      emit({ type: "error", text: message_ });
      return;
    }

    usage = turn.usage ?? usage;
    finalText = turn.content;

    // Persist the assistant turn together with any tool calls it made, so the
    // next request can replay the exact protocol the model produced. The tool
    // calls are redacted on the way in: a key-shaped argument has no business
    // outliving the request, and this row is replayed on every later turn.
    await appendAssistantMessage({
      threadId: thread.id,
      role: "assistant",
      content: turn.content,
      toolCalls: redactToolCalls(turn.toolCalls),
    });

    if (turn.toolCalls.length === 0) {
      if (round > 0 && !turn.content.trim()) {
        emit({ type: "error", text: "模型结束了回合但没有给出文字回复。" });
      }
      emit({ type: "done", data: { rounds: round + 1, usage, pendingActions } });
      return;
    }

    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls,
    });

    for (const call of turn.toolCalls) {
      signatures.push(callSignature(call.function.name, call.function.arguments));
      emit({ type: "tool", toolName: call.function.name, text: call.function.arguments });

      let resultText: string;
      try {
        const result = await executeTool(call.function.name, call.function.arguments, ctx);
        resultText = result.content;
        if (result.ok) {
          const actionId = (result.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
          if (actionId) pendingActions.push(actionId);
        }

        // Media the tool produced is stored here and referenced by a short
        // first-party URL, so the model is handed a link it can cite and the
        // reader gets something playable. Both the payload and the upstream's
        // own long-lived CDN link stay out of the transcript on purpose.
        if (result.artifacts?.length) {
          const refs = await storeArtifacts({
            userId: user.id,
            threadId: thread.id,
            artifacts: result.artifacts,
          });
          resultText = withArtifactRefs(resultText, refs);
          emit({ type: "artifact", artifacts: refs });
        }
      } catch (err) {
        // A tool that throws is a fact the model can reason about, not a reason
        // to end the conversation.
        resultText = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
      }

      if (resultText.length > MAX_TOOL_RESULT_CHARS) {
        // Keep the transcript bounded: a user list or a model catalogue can be
        // enormous, and replaying it verbatim on every later turn is what blows
        // the context.
        //
        // The size has to be big enough for the *legitimate* payloads, though,
        // because a truncation lands wherever it lands rather than at a
        // boundary. At 8000 this clipped the media-spec listing in the middle
        // of a video spec's `async.poll`, so the model copied a spec with no
        // `statusMap` and the approval rejected it — a result that looked
        // complete and was not.
        resultText = `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}\n…（内容过长已截断）`;
      }

      await appendAssistantMessage({
        threadId: thread.id,
        role: "tool",
        content: resultText,
        toolCallId: call.id,
        toolName: call.function.name,
      });
      messages.push({ role: "tool", content: resultText, tool_call_id: call.id });
    }

    // Progress, checked after the round's work is done so the model has seen
    // the results — a model that repeats itself usually does so once *after*
    // being handed an answer it did not like, and stopping earlier would cut
    // off exactly the case where reading the result would have fixed it.
    const stuck = repeatedCall(signatures);
    if (stuck) {
      stopReason = `助手连续 ${MAX_IDENTICAL_CALLS} 次调用了同一个工具（${toolNameOf(stuck)}）却没有新的进展，已停止。换一种问法或先看它的返回内容，通常能解开。`;
    } else if (Date.now() - startedAt > MAX_TURN_MS) {
      stopReason = `这一轮已经跑了 ${Math.round(MAX_TURN_MS / 60000)} 分钟，已停止。可以把问题拆小一点再试。`;
    }
  }

  // Out of rounds. Rare, and it says so plainly rather than blaming a budget
  // the reader never set.
  if (!stopReason) {
    stopReason = `这一轮用完了 ${MAX_ROUNDS} 次模型往返，已停止。可以把问题拆小一点再试。`;
  }
  emit({ type: "error", text: stopReason });
  emit({ type: "done", data: { rounds, usage, pendingActions, truncated: true } });
  void finalText;
}

/**
 * Image types worth sending to a vision model.
 *
 * Anything else is named to the model in text instead. A user who attaches a
 * PDF or an audio clip should be told it arrived and that it could not be
 * looked at — not handed a conversation where the model is looking at nothing
 * and does not know why.
 */
const MODEL_VIEWABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * A whole turn's worth of inline images.
 *
 * A phone screenshot is a few MB, and a turn replays its whole history, so
 * without a ceiling one message with four photos makes every later request
 * enormous. Past it the oldest picture is dropped and the omission is stated,
 * because a model reasoning confidently about a conversation it is no longer
 * being sent is worse than a shorter one.
 */
const MAX_INLINE_BYTES = 16 * 1024 * 1024;

/**
 * Stored rows → wire messages, with a user turn's attachments inlined.
 *
 * The image travels as a data URL rather than as our artefact URL. The upstream
 * is the user's own provider: it has no session here, and `/api/assistant/
 * artifacts/:id` is owner-scoped, so a URL would come back 401 to a model that
 * had done nothing wrong. The bytes are read back per turn and never written
 * into the stored transcript.
 */
async function toWireMessages(
  rows: Awaited<ReturnType<typeof listAssistantMessages>>,
  userId: string,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const row of rows) {
    if (row.role === "tool") continue;
    if (row.role === "assistant" && row.toolCalls.length > 0) {
      // Skip an assistant turn whose tool results are not being replayed —
      // OpenAI rejects a tool_call with no following tool message.
      continue;
    }
    out.push(
      row.attachments.length
        ? { role: row.role, content: await withAttachments(row, userId) }
        : { role: row.role, content: row.content },
    );
  }
  return out;
}

/** One user turn, as the model receives it. Exported shape: text, then images. */
async function withAttachments(
  row: { content: string; attachments: MessageAttachment[] },
  userId: string,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  const notes: string[] = [];
  let budget = MAX_INLINE_BYTES;

  for (const attachment of row.attachments) {
    if (attachment.kind !== "image" || !MODEL_VIEWABLE.has(attachment.contentType)) {
      notes.push(
        `- ${attachment.name}（${attachment.contentType}）：这是一个 ${attachment.kind === "image" ? "图片" : attachment.kind === "audio" ? "音频" : "视频"}附件，但你这次看不到它的内容。`,
      );
      continue;
    }
    const artifact = await getAssistantArtifact(attachment.id, userId);
    if (!artifact?.bytes) {
      notes.push(`- ${attachment.name}：图片读不出来了，你这次看不到它。`);
      continue;
    }
    const size = artifact.bytes.byteLength;
    if (size > budget) {
      notes.push(`- ${attachment.name}：太大了，这次没有发给你。`);
      continue;
    }
    budget -= size;
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${attachment.contentType};base64,${Buffer.from(artifact.bytes).toString("base64")}`,
      },
    });
  }

  const text = [
    row.content || "（这条消息没有文字，只有下面的附件。）",
    ...notes,
  ].join("\n");
  parts.unshift({ type: "text", text });
  return parts;
}
export { touchAssistantThread };
