/**
 * src/lib/search/config.ts
 *
 * The one place that answers "is web search on, what does it cost, and is
 * there a backend behind it".
 *
 * Three callers need the same answers: the public `/v1/search` route, the
 * assistant's `web_search` tool, and the admin panel. Reading them separately
 * is how a panel comes to say "enabled" while the endpoint is refusing, or a
 * price edit reaches one door and not the other. The provider table is the
 * authority for *which* backend answers; the environment is only the fallback
 * for a deployment that has never added a provider row.
 */
import { getSettings, type AppSettings } from "@/lib/db/settings";
import { activeSearchBackendInfo } from "./resolve";
import type { SearchProvider } from "@/lib/assistant/web-search";

/** Used when neither the settings row nor the environment names a price. */
export const DEFAULT_SEARCH_CREDITS = 1;

/** Whole credits from `SEARCH_CREDITS_PER_CALL`, or undefined when unset/invalid. */
export function envSearchCredits(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SEARCH_CREDITS_PER_CALL?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export interface SearchConfig {
  /** False means both `/v1/search` and the assistant's tool refuse. */
  enabled: boolean;
  /** Whole 积分 charged per call. 0 is a deliberate "free". */
  creditsPerCall: number;
  /**
   * Whether that price came from the active provider row.
   *
   * The provider's own price wins: two backends can have very different
   * economics, and a global number would either overcharge the cheap one or
   * lose money on the expensive one. The global setting survives only as the
   * price of the environment fallback, which has no row to hold one.
   */
  creditsFromProvider: boolean;
  /** Whether any backend is configured at all. */
  backendConfigured: boolean;
  /** Human-readable backend name ("SearXNG", "Tavily", …), never the key. */
  backendName: string | null;
  /**
   * The backend's address, when it has one worth showing.
   *
   * Admin-only: it can be an internal hostname, and putting it in a
   * user-facing response would leak a piece of network topology for no reason.
   */
  backendUrl: string | null;
  /** Where the active backend came from: the provider table or the environment. */
  backendSource: "db" | "env" | null;
  /** The provider's kind. */
  backendKind: SearchProvider | null;
  /** The id written into usage rows for this backend. */
  backendProviderId: string | null;
}

/**
 * Resolve the configuration, optionally reusing an already-loaded settings
 * object so a page does not read the table twice.
 */
export async function loadSearchConfig(settings?: AppSettings): Promise<SearchConfig> {
  const stored = settings ?? (await getSettings());
  const backend = await activeSearchBackendInfo();
  const providerPrice = backend.source === "db" ? backend.creditsPerCall : null;
  return {
    // Absent means on. The feature predates the switch, so an upgrade must not
    // silently turn it off; only an explicit `false` does.
    enabled: stored.searchEnabled !== false,
    creditsPerCall:
      providerPrice ?? stored.searchCreditsPerCall ?? envSearchCredits() ?? DEFAULT_SEARCH_CREDITS,
    creditsFromProvider: providerPrice !== null,
    backendConfigured: backend.configured,
    backendName: backend.name,
    backendUrl: backend.baseUrl,
    backendSource: backend.source,
    backendKind: backend.kind,
    backendProviderId: backend.usageProviderId,
  };
}
