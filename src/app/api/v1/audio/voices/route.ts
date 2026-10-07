/**
 * app/api/v1/audio/voices/route.ts
 *
 * GET /v1/audio/voices — every voice this deployment can be spoken with.
 *
 * **This is a RelayAB addition, not an OpenAI endpoint.** OpenAI has no
 * voice-listing call: its voices are a type union inside the `voice` parameter,
 * so there is nothing for a client to fetch. What it borrows from OpenAI is only
 * the envelope — `{object: "list", data: [...]}` — so that a client already
 * parsing list responses does not need a second parser. Nothing about the shape
 * is a compatibility claim.
 *
 * **A read, so it cannot be refused for having no money left.** The pool check is
 * skipped for the same reason `/v1/credits` skips it: "what can I speak with" is
 * asked while wiring something up or after something has drained the account,
 * which is exactly when a quota refusal would make the answer useless.
 *
 * **It is not charged, and that is deliberate rather than forgotten.** No
 * `executeMediaRequest` runs here, so nothing settles — the only upstream calls
 * are the vendors' own voice listings, which are reads. That is also why the
 * catalogue is cached per provider for five minutes (`collectVoiceCatalogue`):
 * the usual rate-limit argument for caching an unauthenticated read applies here
 * with nothing to authenticate against.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById } from "@/lib/db/users";
import { collectVoiceCatalogue } from "@/lib/media/voices";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    // Reading a list spends nothing, so an empty pool cannot be a reason to
    // refuse — same reasoning as /v1/credits, and for the same reason: the
    // question gets asked precisely when the balance is short.
    skipQuotaCheck: true,
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  // The owner comes back with the validation result; the lookup is a fallback
  // for a caller that resolved the key by another route.
  const user = auth.user ?? (await getUserById(auth.key.userId));
  if (!user) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
    );
  }

  // Deliberately no `executeMediaRequest` and therefore no `settleMediaUsage`:
  // nothing is produced, so nothing is charged. The only upstream work is the
  // vendors' voice listings, which are reads and are cached for five minutes.
  const { voices, unavailable } = await collectVoiceCatalogue({ signal: req.signal });

  return NextResponse.json(
    { object: "list", data: voices, unavailable },
    { headers: quotaHeaders(user) },
  );
}