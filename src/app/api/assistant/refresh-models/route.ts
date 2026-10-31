/**
 * POST /api/assistant/refresh-models
 *
 * Re-read this deployment's own model configuration, and refresh the two
 * numbers only the vendor can state.
 *
 * **There is no probe here, and there was never supposed to be one.** The
 * thinking levels are a configuration question — what *this relay* has been told
 * a model takes — so the answer belongs in the model configuration the operator
 * fills in, and the relay forwards it through the provider's own protocol
 * rules. Five rounds went into discovering a model's levels by sending it values
 * and reading the refusals, and the cost was real: a billed request per model
 * per refresh, a verdict that could not tell "publishes no levels" from "ignores
 * the parameter", and five different ways for the same silence to be reported as
 * a fact about the vendor.
 *
 * What remains is the model list, because a context window and an output cap
 * are the two numbers a vendor states and an operator cannot. One request per
 * provider, and nothing is invented from it.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listProviders, updateProvider } from "@/lib/db/providers";
import { callUpstream, extractModelEntries } from "@/lib/providers/upstream";
import type { ModelEntryFacts } from "@/lib/providers/upstream";
import { routesOf, keyCarrierOfRoutes, modelListPathOf } from "@/lib/protocol/surface-routes";

export const dynamic = "force-dynamic";

interface ProviderOutcome {
  providerId: string;
  name: string;
  ok: boolean;
  updated: number;
  /** Models this provider's list mentioned, whether or not anything changed. */
  seen: number;
  error?: string;
}

/**
 * Write back only what the vendor said, and only where it is a fact.
 *
 * A model the vendor says nothing about is left exactly as it was: its window
 * and its cap were the operator's numbers, and overwriting them with nothing is
 * how a working configuration is lost to a refresh.
 *
 * The thinking levels are deliberately *not* touched. They are declared, not
 * discovered — a fetch has no business replacing a decision somebody made.
 */
function applyFacts(config: Record<string, unknown>, fact: ModelEntryFacts): boolean {
  let changed = false;
  if (fact.contextLength !== undefined && config.contextLength !== fact.contextLength) {
    config.contextLength = fact.contextLength;
    changed = true;
  }
  if (fact.maxOutputTokens !== undefined && config.maxOutputTokens !== fact.maxOutputTokens) {
    config.maxOutputTokens = fact.maxOutputTokens;
    changed = true;
  }
  return changed;
}

export async function POST(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  const providers = await listProviders();
  const outcomes: ProviderOutcome[] = [];

  for (const provider of providers) {
    if (!provider.enabled || !provider.baseUrl) continue;
    try {
      // Where the list lives and how the key travels both come from the row's
      // own routing — a Gemini vendor's list is at `/models` and its key goes
      // in `x-goog-api-key`.
      const routes = routesOf(provider);
      const entries = await callUpstream({
        baseUrl: provider.baseUrl,
        encryptedApiKey: provider.encryptedApiKey,
        path: modelListPathOf(routes),
        keyCarrier: keyCarrierOfRoutes(routes),
      });
      if (!entries.ok) {
        outcomes.push({
          providerId: provider.id,
          name: provider.name,
          ok: false,
          updated: 0,
          seen: 0,
          error: `HTTP ${entries.status}`,
        });
        continue;
      }

      const facts = extractModelEntries(entries.body);
      const byUpstreamId = new Map(facts.map((f) => [f.id, f]));
      const configs = { ...(provider.modelConfigs ?? {}) };
      let updated = 0;
      let seen = 0;

      for (const [clientId, upstreamId] of Object.entries(provider.modelMapping ?? {})) {
        const fact = byUpstreamId.get(upstreamId) ?? byUpstreamId.get(clientId);
        if (!fact) continue;
        seen += 1;
        const current = configs[clientId] ?? {};
        const next = { ...current };
        if (applyFacts(next, fact)) {
          configs[clientId] = next;
          updated += 1;
        }
      }

      if (updated > 0) {
        await updateProvider(provider.id, { modelConfigs: configs });
      }
      outcomes.push({ providerId: provider.id, name: provider.name, ok: true, updated, seen });
    } catch (err) {
      outcomes.push({
        providerId: provider.id,
        name: provider.name,
        ok: false,
        updated: 0,
        seen: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    data: {
      outcomes,
      updated: outcomes.reduce((n, o) => n + o.updated, 0),
      seen: outcomes.reduce((n, o) => n + o.seen, 0),
    },
  });
}
