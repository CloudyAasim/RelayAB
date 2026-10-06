/**
 * src/lib/proxy/errors.ts
 *
 * The one place a failure becomes an HTTP response.
 *
 * Every `/v1/*` route used to hand-build the same literal —
 * `NextResponse.json({ ok: false, error: { code, message } }, { status })` — and
 * several of them copied it verbatim. That is why the body had no `error.type`:
 * nothing dropped the field, there was simply no single definition to add it to.
 * Fixing it in place would have meant editing a dozen call sites and hoping the
 * next route remembered. This module is the definition instead, so the twelfth
 * route gets it for free.
 *
 * ## Why `type` is derived, not declared
 *
 * OpenAI's taxonomy is small — `invalid_request_error`, `authentication_error`,
 * `permission_error`, `not_found_error`, `rate_limit_error`, `insufficient_quota`,
 * `server_error` — and a status code picks almost all of them. So the mapping is a
 * function of the status, not a per-code table: a table would be one more thing to
 * keep in sync with `reasonToHttp`, and a row that disagrees with the status code
 * would be indistinguishable from a bug.
 *
 * There is exactly one exception, and it is the reason this is not purely
 * arithmetic. An exhausted pool is a 429, but it is not rate limiting and must not
 * read as such: a client that backs off and retries a 429 will retry forever. That
 * case is `insufficient_quota`, and it is what the quota codes map to.
 *
 * ## The `code` is still ours
 *
 * `code` stays exactly as it was. Clients that already branch on
 * `quota_exceeded_credits` keep working; `type` is additive information, not a
 * replacement. That is the whole compatibility story: a client that knows nothing
 * about `type` sees the same thing it always did.
 */
import { NextResponse } from "next/server";
import type { User } from "@/lib/db/types";

/** Quota exhaustion. 429 for OpenAI's sake, but never `rate_limit_error`. */
const QUOTA_CODES = new Set(["quota_exceeded_credits", "quota_exceeded_tokens"]);

/**
 * The OpenAI error taxonomy, derived from the status.
 *
 * Exported for the tests that assert the mapping is a function of the status and
 * not of the code, which is the property that keeps it from drifting.
 */
export function openAiErrorType(status: number, code: string): string {
  if (QUOTA_CODES.has(code)) return "insufficient_quota";
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  return "server_error";
}

export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string };
}

/** The body only, for callers that need to merge it into something larger. */
export function proxyErrorBody(status: number, code: string, message: string): OpenAiErrorBody {
  return { error: { message, type: openAiErrorType(status, code), code } };
}

/**
 * A failure as an HTTP response, in the shape an OpenAI client expects.
 *
 * `param` is deliberately absent. OpenAI sends `param: null` on every error, and
 * no client branches on whether it is there — adding it in a dozen places to
 * match a field nobody reads is the kind of compatibility that costs more than it
 * buys. `type` and `code` are the two a client actually dispatches on.
 */
export function proxyError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return NextResponse.json(proxyErrorBody(status, code, message), {
    status,
    ...(headers ? { headers } : {}),
  });
}

/**
 * The caller's remaining balance, as OpenAI reports limit state in headers rather
 * than in a body — `x-ratelimit-*` on every response, which is how OpenAI itself
 * communicates "how much is left" (there is no balance endpoint to call).
 *
 * One pool, so one pair of numbers. OpenAI spells the unit into the header name
 * because it enforces two independent limits, requests and tokens; copying that
 * here would be answering a question this deployment does not have, and a client
 * would still have to know which header to look for. `x-ratelimit-unit` says it
 * outright instead.
 *
 * The figures are read at response time, so they describe the balance as of this
 * call — a client polling this header never has a stale copy, which is the reason
 * to prefer it over a separate balance endpoint that could answer just before a
 * concurrent request spent from the same pool.
 */
export function quotaHeaders(user: User): Record<string, string> {
  return {
    "x-ratelimit-limit": String(user.quotaLimit),
    "x-ratelimit-remaining": String(Math.max(0, user.quotaLimit - user.quotaUsed)),
    // `quotaLimit === 0` means nothing was ever granted, not that the balance is
    // zero. The two are told apart by the limit itself: a granted pool reports a
    // positive limit, so a client reading `limit` needs no separate flag, and no
    // second field can contradict the first.
    "x-ratelimit-unit": user.quotaType,
  };
}
