/**
 * app/api/v1/media/jobs/[id]/route.ts
 *
 * `GET /v1/media/jobs/<id>` — poll a job.
 * `DELETE /v1/media/jobs/<id>` — stop one that is still in flight.
 *
 * Reads cannot spend, so they skip the quota check; they still require the key
 * and answer `404` for a job belonging to another account (a `403` would confirm
 * that the id exists).
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById as lookupUserById } from "@/lib/db/users";
import { proxyError } from "@/lib/proxy/errors";
import { cancelMediaJob, describeMediaJob, mediaJobView } from "@/lib/media/jobs";
import { getMediaJobForUser } from "@/lib/db/media-jobs";

export const runtime = "nodejs";

async function owner(req: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    // A poll cannot spend anything, and it must not fail because the account is
    // out of quota — the job it is polling may still be running.
    skipQuotaCheck: true,
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return { ok: false, response: proxyError(http.status, http.code, http.message) };
  }
  const user = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!user) {
    return {
      ok: false,
      response: proxyError(403, "user_not_found", "The account owning this key no longer exists"),
    };
  }
  return { ok: true, userId: user.id };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const who = await owner(req);
  if (!who.ok) return who.response;

  const { id } = await params;
  const job = await describeMediaJob(id, who.userId);
  if (!job) return proxyError(404, "job_not_found", `No job '${id}' for this key`);
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const who = await owner(req);
  if (!who.ok) return who.response;

  const { id } = await params;
  const existing = await getMediaJobForUser(id, who.userId);
  if (!existing) return proxyError(404, "job_not_found", `No job '${id}' for this key`);

  await cancelMediaJob(id, who.userId);
  const after = await getMediaJobForUser(id, who.userId);
  return NextResponse.json(after ? mediaJobView(after) : {}, {
    headers: { "Cache-Control": "no-store" },
  });
}
