/**
 * src/lib/assistant/tool-failure.ts
 *
 * The marker a crashed tool leaves on its result.
 *
 * The assistant's tool results are written in the deployment's language: the
 * model reads them, and a reader sees them in the tool card. So the marker is
 * written in that language too — it is part of the assistant's output, not
 * part of the interface's furniture.
 *
 * It lives in one file because the producer and the reader have to agree, and
 * there used to be a copy in each: the server wrote the sentence and the card
 * looked for it, and a change to one of them would have left the card showing
 * a failed tool in the colour of a successful one.
 */

/** What a crashed tool's result starts with. */
export const TOOL_FAILURE_PREFIX = "工具执行失败：";

/**
 * Did this tool crash?
 *
 * The other signal — a result that carries `"ok": false` — is the structural
 * one and lives with the card; this is the one that says the tool threw rather
 * than returned a refusal.
 */
export function isToolFailure(content: string): boolean {
  return content.startsWith(TOOL_FAILURE_PREFIX);
}
