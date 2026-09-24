/**
 * app/api/v1/messages/route.ts
 *
 * Anthropic Messages API at the root path, i.e. the path an Anthropic-shaped
 * client builds from a bare base URL (`https://api.aasim.l.cd` + `/v1/messages`).
 *
 * Why this alias exists: ONLYOFFICE's built-in Anthropic provider is defined as
 * `super("Anthropic", "https://api.anthropic.com", "", "v1")`, so a user who
 * mirrors that template with the relay origin posts here — not to
 * `/anthropic/v1/messages`. Without this route the model list at `/v1/models`
 * worked while the chat call 404'd, which is impossible to diagnose from the
 * editor UI.
 */
import { handleAnthropicMessages } from "@/lib/proxy/anthropic-route";

export const runtime = "nodejs";
// Long generations must not be cut off at 60s.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  return handleAnthropicMessages(req);
}
