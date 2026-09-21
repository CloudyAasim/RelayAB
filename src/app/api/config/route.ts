/**
 * app/api/config/route.ts
 *
 * GET /api/config
 *
 * Returns PUBLIC, non-secret runtime information the dashboard / docs page
 * needs to render correctly:
 *
 *   - `publicUrl`    The base URL of THIS instance (from RELAY_PUBLIC_URL).
 *                    Users paste `${publicUrl}/v1` into their OpenAI
 *                    clients. Configured at deploy time together with
 *                    RELAY_AUTH.
 *   - `endpoints`    The standard OpenAI / Anthropic / models URLs derived
 *                    from `publicUrl`. The docs page renders these as
 *                    copy-paste blocks.
 *   - `siteName`     Configurable site label (RELAY_SITE_NAME / default).
 *
 * The endpoint is reachable WITHOUT a session so the login page can also
 * display the public URL. But secrets (RELAY_AUTH, master key, upstream
 * provider keys) are never returned.
 */
import { NextResponse } from "next/server";
import { getPublicUrl } from "@/lib/config";

export async function GET(): Promise<Response> {
  const base = getPublicUrl();
  const siteName = process.env.RELAY_SITE_NAME?.trim() || "RelayAB";
  return NextResponse.json({
    ok: true,
    data: {
      siteName,
      publicUrl: base,
      endpoints: {
        openai: {
          baseUrl: `${base}/v1`,
          chatCompletions: `${base}/v1/chat/completions`,
          models: `${base}/v1/models`,
        },
        anthropic: {
          baseUrl: `${base}/anthropic`,
          messages: `${base}/anthropic/v1/messages`,
        },
      },
      authScheme: "Authorization: Bearer <your-key>",
    },
  });
}
