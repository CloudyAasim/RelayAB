/**
 * src/lib/search/config.ts
 *
 * The one place that answers "is web search on, what does it cost, and is
 * there a backend behind it".
 *
 * Three callers need the same answers: the public `/v1/search` route, the
 * assistant's `web_search` tool, and the admin panel. Reading them separately
 * is how a panel comes to say "enabled" while the endpoint is refusing, or a
 * price edit reaches one door and not the other. The environment is the
 * fallback rather than the authority, so an operator can change the price in
 * the panel without redeploying.
 */
import { getSettings, type AppSettings } from "@/lib/db/settings";
import { resolveSearchBackend } from "@/lib/assistant/web-search";

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
  /** Whether any backend is configured at all. */
  backendConfigured: boolean;
  /** Human-readable backend name ("SearXNG", "Tavily", …), never the key. */
  backendName: string | null;
  /**
   * The internal SearXNG address, when that is the backend.
   *
   * Admin-only: it is an internal hostname, and putting it in a user-facing
   * response would be a small piece of network topology leaked for no reason.
   */
  backendUrl: string | null;
}

/**
 * Resolve the configuration, optionally reusing an already-loaded settings
 * object so a page does not read the table twice.
 */
export async function loadSearchConfig(settings?: AppSettings): Promise<SearchConfig> {
  const stored = settings ?? (await getSettings());
  const backend = resolveSearchBackend();
  return {
    // Absent means on. The feature predates the switch, so an upgrade must not
    // silently turn it off; only an explicit `false` does.
    enabled: stored.searchEnabled !== false,
    creditsPerCall:
      stored.searchCreditsPerCall ?? envSearchCredits() ?? DEFAULT_SEARCH_CREDITS,
    backendConfigured: backend !== null,
    backendName: backend?.describe ?? null,
    backendUrl: process.env.SEARXNG_URL?.trim() || null,
  };
}
