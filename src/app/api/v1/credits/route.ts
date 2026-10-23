/**
 * app/api/v1/credits/route.ts
 *
 * GET /v1/credits — what is left in the calling account's pool.
 *
 * **Why this exists and not just the response headers.** Every `/v1/*` response
 * already carries `x-ratelimit-remaining`, read as that response is produced, so
 * the header is never stale. But a header only exists once you have made a
 * request, which means it cannot answer the question that comes first: *should I
 * make this request at all?* A client that wants to skip an expensive call
 * because the balance cannot cover it has to be able to ask before it spends.
 *
 * DeepSeek (`GET /user/balance`) and MiniMax (`GET /v1/token_plan/remains`) both
 * ship a dedicated endpoint for the same reason. OpenAI has none, but what it does
 * put in headers is the *rate limit* — a per-window allowance — which is a
 * different thing from a spendable balance, and borrowing its shape for this was
 * the wrong call.
 *
 * **`is_available` is the field that earns the round trip.** A client asking
 * "can I still call anything" otherwise has to take `remaining` and compare it
 * against a threshold of its own, and pick a unit to reason in. That is the
 * caller assembling an answer the server already has — the same mistake as
 * computing a cache hit rate from a percentage and a total it was handed
 * separately. DeepSeek returns the same field for the same reason.
 *
 * **Any valid key may ask.** The pool belongs to the account, not to the key, so
 * there is no separate "balance key" to issue and no key type that can be denied
 * it. MiniMax has to make that distinction explicitly; it costs us nothing.
 *
 * The figures are a snapshot, exactly as they would be on any read. A concurrent
 * request can spend from the same pool in between — that is inherent to asking
 * about a shared account, not something this endpoint could arrange away.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById } from "@/lib/db/users";
import { CREDIT_SCALE } from "@/lib/quota/credits";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    // Reading the balance spends nothing, so an empty pool cannot be a reason to
    // refuse. Without this the endpoint answers only while there is credit left —
    // useless in exactly the situation it was added for.
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

  // Floored, matching the header: an overspent pool reads as zero rather than as
  // a debt. `limit === 0` is how "nothing was ever granted" is stored, so a
  // client can tell "granted and spent" from "never granted" off this one number
  // — there is no second flag that could disagree with it.
  const remaining = Math.max(0, user.quotaLimit - user.quotaUsed);

  return NextResponse.json(
    {
      object: "credit_balance",
      // The decision, not the raw figure: is there anything left to spend.
      is_available: remaining > 0,
      // The unit travels with the numbers. `quotaType` can be tokens, and a bare
      // figure does not say which.
      unit: user.quotaType,
      // How many stored units make one unit of the above, so a client formats
      // this correctly without hardcoding it.
      scale: CREDIT_SCALE,
      limit: user.quotaLimit,
      used: user.quotaUsed,
      remaining,
    },
    { headers: quotaHeaders(user) },
  );
}
