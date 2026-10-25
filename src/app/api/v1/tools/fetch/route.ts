/**
 * app/api/v1/tools/fetch/route.ts
 *
 * The same fetch, under the name the other fetch APIs use it.
 *
 * `POST /v1/tools/fetch` takes `{"url": "https://…"}` and gives back the
 * page's text — the same answer `POST /v1/fetch` gives, from the same
 * handler, with the same address checks in front of it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { POST } from "@/app/api/v1/fetch/route";
