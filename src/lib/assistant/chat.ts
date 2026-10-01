/**
 * src/lib/assistant/chat.ts
 *
 * The turn loop: ask the model, run whatever tools it asked for, feed the
 * results back, repeat until it answers in prose.
 *
 * Two guards shape it:
 *
 *  - **A bounded round count.** A model that keeps calling the same tool
 *    forever is a hung request and an unbounded upstream bill. Past the cap the
 *    loop stops and the user is told, rather than the server quietly spinning.
 *  - **Tool errors are results, not exceptions.** A failing tool comes back to
 *    the model as text describing the failure, so the model can explain it or
 *    try something else. Letting it throw would end the turn and lose whatever
 *    the assistant had already worked out.
 */
import { callAssistantModel, UpstreamError, type ChatMessage, type UpstreamTurn } from "./client";
import { toolDefinitions, executeTool, type ToolContext } from "./tools";
import { systemPrompt } from "./prompts";
import { decryptSecret } from "../crypto/secrets";
import {
  appendAssistantMessage,
  listAssistantMessages,
  touchAssistantThread,
  isThreadUntouched,
  renameAssistantThread,
} from "../db/assistant";
import type { AssistantSettings, AssistantThread } from "./schema";
import type { AuthedUser } from "../auth/session";

/** Enough for a plan-then-execute turn; more than this is a runaway. */
const MAX_ROUNDS = 8;

/** How much history to replay. Older turns are dropped rather than truncated. */
const MAX_HISTORY_MESSAGES = 40;

export interface ChatEvent {
  type: "delta" | "tool" | "done" | "error" | "action";
  text?: string;
  toolName?: string;
  data?: unknown;
}

export interface RunChatOptions {
  user: AuthedUser;
  settings: AssistantSettings;
  thread: AssistantThread;
  message: string;
  /** The caller's own gateway key, used only by tools that need it. */
  relayKey?: string;
  /** Resolved by the route while the request context is live. */
  gatewayBase?: string;
  signal?: AbortSignal;
  emit: (event: ChatEvent) => void;
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  const { user, settings, thread, message, relayKey, signal, emit } = opts;
  const apiKey = decryptSecret(settings.encryptedApiKey);
  const isAdmin = user.role === "admin";
  const tools = toolDefinitions(isAdmin);
  const ctx: ToolContext = {
    user,
    ...(relayKey ? { relayKey } : {}),
    ...(opts.gatewayBase ? { gatewayBase: opts.gatewayBase } : {}),
  };

  // The user's turn goes in first so it is persisted even if the upstream is
  // unreachable — losing the typed message would be the worse failure.
  await appendAssistantMessage({ threadId: thread.id, role: "user", content: message });
  if (await isThreadUntouched(thread.id)) {
    await renameAssistantThread(user.id, thread.id, message);
  }

  const history = await listAssistantMessages(thread.id);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(isAdmin) },
    ...toWireMessages(history.slice(-MAX_HISTORY_MESSAGES)),
  ];

  const pendingActions: string[] = [];
  let finalText = "";
  let usage: UpstreamTurn["usage"] = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
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
    // next request can replay the exact protocol the model produced.
    await appendAssistantMessage({
      threadId: thread.id,
      role: "assistant",
      content: turn.content,
      toolCalls: turn.toolCalls,
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
      emit({ type: "tool", toolName: call.function.name, text: call.function.arguments });

      let resultText: string;
      try {
        const result = await executeTool(call.function.name, call.function.arguments, ctx);
        resultText = result.content;
        if (result.ok) {
          const actionId = (result.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
          if (actionId) pendingActions.push(actionId);
        }
      } catch (err) {
        // A tool that throws is a fact the model can reason about, not a reason
        // to end the conversation.
        resultText = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
      }

      if (resultText.length > 8000) {
        // Keep the transcript bounded: an image spec JSON can be enormous, and
        // replaying it verbatim on every later turn is what blows the context.
        resultText = `${resultText.slice(0, 8000)}\n…（内容过长已截断）`;
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
  }

  // The cap was hit. Say so rather than ending on a tool call the model never
  // got to explain.
  emit({
    type: "error",
    text: `已达到 ${MAX_ROUNDS} 轮工具调用上限，已停止。可以把问题拆小一点再试。`,
  });
  emit({ type: "done", data: { rounds: MAX_ROUNDS, usage, pendingActions, truncated: true } });
  void finalText;
}

/**
 * Stored rows → wire messages.
 *
 * Assistant rows keep their `tool_calls` so the protocol stays valid; tool
 * rows are dropped here and re-derived from the loop's own `messages` array,
 * which is the authoritative copy for the current request.
 */
function toWireMessages(rows: Awaited<ReturnType<typeof listAssistantMessages>>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const row of rows) {
    if (row.role === "tool") continue;
    if (row.role === "assistant" && row.toolCalls.length > 0) {
      // Skip an assistant turn whose tool results are not being replayed —
      // OpenAI rejects a tool_call with no following tool message.
      continue;
    }
    out.push({ role: row.role, content: row.content });
  }
  return out;
}

export { touchAssistantThread };
