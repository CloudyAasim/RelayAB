/**
 * POST /api/admin/model-config/detect-levels
 *
 * Ask a vendor which thinking levels its model takes, then write the answer
 * down.
 *
 * The previous attempt at this read a vendor's model list, which does not carry
 * levels — MiniMax documents `reasoning_effort = "max"` and says the control
 * exists on one model in the family, and none of that appears in `/v1/models`.
 * It therefore detected nothing and fell back to four invented names, which
 * looked like a working feature. This asks the only source that knows: the
 * vendor itself, by sending a value and reading the reaction.
 *
 * Two calls in the common case. A sentinel level that cannot exist goes out
 * first, and a vendor that validates the value usually names what it does
 * accept in the refusal — one request, the whole vocabulary. Only the levels
 * that refusal did not settle are then tried one by one, and a 4xx is a no
 * while a 429 or a 5xx is the vendor declining to answer, which is not the same
 * thing and is not allowed to delete a level.
 *
 * Every call is a real request against a real quota, which is why the candidate
 * list is capped and why the whole report — including what was rejected — is
 * returned rather than just the survivors.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getProviderById, updateProvider } from "@/lib/db/providers";
import { callUpstream } from "@/lib/providers/upstream";
import {
  ASSISTANT_REASONING_SUGGESTIONS,
} from "@/lib/assistant/config";
import {
  PROBE_SENTINEL,
  candidatesFor,
  decideLevels,
  isRefusal,
  refusalVocabulary,
  type LevelProbe,
} from "@/lib/assistant/detect-levels";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  providerId: z.string().min(1),
  /** The client-facing id, which is what the config is keyed by. */
  clientId: z.string().min(1).max(200),
});

/** Cheapest question that still has to be answered. */
const PROBE_MAX_TOKENS = 1;
const PROBE_PROMPT = "hi";

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "providerId 和 clientId 都不能为空" } },
      { status: 400 },
    );
  }

  const provider = await getProviderById(parsed.data.providerId);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "找不到这个服务商" } },
      { status: 404 },
    );
  }

  const upstreamId = provider.modelMapping?.[parsed.data.clientId];
  if (!upstreamId) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "这个模型还没有映射到上游" } },
      { status: 404 },
    );
  }

  const declared = provider.modelConfigs?.[parsed.data.clientId]?.reasoningLevels ?? [];

  /** One request, exactly as a client would send it. */
  const ask = async (
    level: string,
  ): Promise<{ ok: boolean; status?: number; error?: string }> => {
    const r = await callUpstream({
      baseUrl: provider.baseUrl ?? "",
      encryptedApiKey: provider.encryptedApiKey,
      path: "/chat/completions",
      // The parameter under the name the OpenAI-compatible surface uses, and a
      // ceiling of one token: this call exists to be answered, not to be read.
      body: {
        model: upstreamId,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        reasoning_effort: level,
      },
    });
    return r.ok
      ? { ok: true, status: 200 }
      : { ok: false, status: r.status, error: (r.error ?? "").slice(0, 400) };
  };

  // Step one: the sentinel, which may return the whole vocabulary.
  const sentinel = await ask(PROBE_SENTINEL);
  const fromRefusal =
    sentinel.ok || !sentinel.error ? null : refusalVocabulary(sentinel.error);

  const candidates = candidatesFor({
    declared,
    fromRefusal,
    fallback: ASSISTANT_REASONING_SUGGESTIONS,
  });

  const probes: LevelProbe[] = [];
  for (const level of candidates) {
    if (level === PROBE_SENTINEL) continue; // already asked
    const r = await ask(level);
    // Only a refusal counts against a level. A timeout, a 5xx or a rate limit is
    // the vendor not answering, and treating that as "no" would delete a level
    // the model takes — the exact failure this whole path is fixing.
    probes.push({
      level,
      accepted: r.ok,
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.error && isRefusal(r.status, r.error) ? { error: r.error } : {}),
    });
  }

  const levels = decideLevels(probes);

  // Nothing learned means nothing written: a run where every probe failed to
  // answer must not empty a good list.
  const answered = probes.some((p) => p.accepted || p.error);
  if (answered) {
    const configs = { ...(provider.modelConfigs ?? {}) };
    configs[parsed.data.clientId] = {
      ...(configs[parsed.data.clientId] ?? {
        upstreamId,
        contextLength: 128000,
        maxOutputTokens: 8192,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      }),
      reasoningLevels: levels,
    };
    await updateProvider(provider.id, { modelConfigs: configs });
  }

  return NextResponse.json({
    ok: true,
    data: {
      levels,
      probes,
      fromRefusal: fromRefusal !== null,
      sentinel: { ok: sentinel.ok, ...(sentinel.status ? { status: sentinel.status } : {}) },
      written: answered,
    },
  });
}
