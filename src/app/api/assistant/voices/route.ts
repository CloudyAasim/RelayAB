/**
 * app/api/assistant/voices/route.ts
 *
 *   GET /api/assistant/voices → this deployment's voice catalogue
 *
 * The media test page's voice picker needs the catalogue, and the public
 * `/v1/audio/voices` needs a bearer key — which the tester's "account"
 * credential mode does not have. So the same read is offered here, on the
 * session.
 *
 * **The same read, not a second one.** `collectVoiceCatalogue` is what
 * `/v1/audio/voices` and the assistant's `list_voices` tool read, so the
 * picker, the API and the assistant cannot list different voices.
 *
 * **Not charged, and not on the page load.** A voice listing is a read of the
 * vendors' own listings; nothing is produced, so nothing settles, and the
 * catalogue is cached per provider for five minutes. It is fetched by the
 * browser when a text-to-speech model is selected rather than with the page,
 * because `discoverMedia` has no deadline of its own — it runs on the
 * caller's signal — and a vendor that stops answering would otherwise hold the
 * whole models page open for whoever visits it, most of whom are not testing
 * speech.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { collectVoiceCatalogue } from "@/lib/media/voices";

export const dynamic = "force-dynamic";

/**
 * A vendor that stops answering must not hold the request open.
 *
 * The catalogue is cached for five minutes and a failure is not cached, so a
 * vendor that recovers is read again on the next attempt — the deadline costs
 * one failed listing, not a stuck page.
 */
const VOICE_LISTING_TIMEOUT_MS = 15_000;

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  const { voices, unavailable } = await collectVoiceCatalogue({
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(VOICE_LISTING_TIMEOUT_MS)]),
  });

  return NextResponse.json({ ok: true, data: { voices, unavailable } });
}
