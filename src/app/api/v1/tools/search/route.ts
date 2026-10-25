/**
 * app/api/v1/tools/search/route.ts
 *
 * The same search, under the name the other search APIs use it.
 *
 * `POST /v1/tools/search` is the path a client written against one of them
 * reaches for first, and a 404 there reads as "this gateway cannot search" —
 * which is false. So the door exists and it is the **same door**: one handler,
 * one settlement, one price. Two implementations would be two places for the
 * price to drift.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { GET, POST } from "@/app/api/v1/search/route";
