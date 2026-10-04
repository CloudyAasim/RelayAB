/**
 * POST /api/admin/providers/probe
 * 
 * Probe endpoint for testing provider connection and fetching models
 * before creating a provider. This doesn't require an existing provider.
 * 
 * Body: { baseUrl, apiKey, path? }
 *
 * `kind` is still accepted and is deliberately ignored: the client sends it, and
 * it used to decide whether this route would even ask. It decides nothing now.
 */
import { NextResponse } from "next/server";
import { callUpstream, extractModelEntries } from "@/lib/providers/upstream";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const me = await import("@/lib/auth/session").then(m => m.getCurrentUser());
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  let body: { baseUrl?: string; apiKey?: string; kind?: string; path?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON" } },
      { status: 400 },
    );
  }

  if (!body.baseUrl) {
    return NextResponse.json(
      { ok: false, error: { code: "missing_baseUrl", message: "baseUrl is required" } },
      { status: 400 },
    );
  }

  if (!body.apiKey) {
    return NextResponse.json(
      { ok: false, error: { code: "missing_apiKey", message: "apiKey is required" } },
      { status: 400 },
    );
  }

  // Encrypt a temporary key for callUpstream
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const encryptedKey = encryptSecret(body.apiKey);
  
  // Where to ask for the model list.
  //
  // **Every provider is asked, whatever its kind.** There used to be a hardcoded
  // blocklist — anthropic, azure, custom-openai returned "not supported" without
  // being called — and that is a claim about the vendor made on the vendor's
  // behalf. It was also wrong often enough to matter: a `custom-openai` provider
  // is *usually* a normal OpenAI-compatible gateway with a working /v1/models,
  // and refusing to ask it is refusing to support it.
  //
  // So: try, and report what actually came back. A 404 here is a fact about this
  // deployment's upstream, visible as an HTTP status next to the models the
  // operator already has — which is the only honest version of "not supported".
  // The candidates are tried in order and the first that answers wins, so a
  // vendor that serves the unversioned path is found without being configured
  // for it.
  const CANDIDATE_PATHS = ["/v1/models", "/models"];
  let path = body.path;
  if (!path) {
    let attempted: Array<{ path: string; status: number; error?: string }> = [];
    let fetched: { models: unknown[]; usedPath: string } | null = null;

    for (const candidate of CANDIDATE_PATHS) {
      const r = await callUpstream({
        baseUrl: body.baseUrl,
        encryptedApiKey: encryptedKey,
        path: candidate,
      });
      if (!r.ok) {
        attempted.push({ path: candidate, status: r.status, ...(r.error ? { error: r.error } : {}) });
        continue;
      }
      const models = extractModelEntries(r.body);
      if (models.length > 0) {
        fetched = { models, usedPath: candidate };
        break;
      }
      // It answered with no models. That is a real answer, not a failure, and
      // trying the other path is still worth the one request.
      attempted.push({ path: candidate, status: r.status });
    }

    if (!fetched) {
      return NextResponse.json({
        ok: true,
        status: attempted[attempted.length - 1]?.status ?? 0,
        latencyMs: 0,
        models: [],
        // What was tried and what each one said. "不支持" was a guess; this is
        // the upstream's own answer.
        attempted,
        notice:
          "这个上游的模型列表没取到。已尝试：" +
          attempted.map((a) => `${a.path} → HTTP ${a.status}`).join("、") +
          "。可以在「路径」里直接填它的模型列表地址，或者手动添加模型。",
      });
    }

    return NextResponse.json({
      ok: true,
      status: 200,
      latencyMs: 0,
      path: fetched.usedPath,
      /** The whole entries, so a vendor's own context window is not thrown away. */
      models: fetched.models,
    });
  }

  const result = await callUpstream({
    baseUrl: body.baseUrl,
    encryptedApiKey: encryptedKey,
    path,
  });

  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error ?? `Upstream returned HTTP ${result.status}`,
    });
  }

  // The explicit path is the escape hatch the notice above points at, so it has
  // to return what discovery returns. It used to go through `extractModelIds`
  // and hand back bare ids — which meant the one instruction given to an
  // operator whose vendor has no /v1/models ("put the model-list address in the
  // path field") silently lost the context window and the output cap on the way
  // in. A fetch that answers half the question is a fetch that did not happen.
  const entries = extractModelEntries(result.body);

  return NextResponse.json({
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    path,
    models: entries,
  });
}
