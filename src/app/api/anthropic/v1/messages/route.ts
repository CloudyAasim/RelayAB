/**
 * app/api/anthropic/v1/messages/route.ts
 *
 * Anthropic Messages API compatible endpoint (provider-prefixed path).
 *
 * Auth: `x-api-key: sk-relay-...` (Anthropic clients / ONLYOFFICE's Anthropic
 * template) or `Authorization: Bearer sk-relay-...`.
 * Body: { model, messages, max_tokens, ... }
 *
 * The implementation lives in `lib/proxy/anthropic-route.ts` because the same
 * handler also serves `/v1/messages` (Anthropic's own path convention).
 */
import { handleAnthropicMessages } from "@/lib/proxy/anthropic-route";

export const runtime = "nodejs";
// Long generations must not be cut off at 60s.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  return handleAnthropicMessages(req);
}
