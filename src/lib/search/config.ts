/**
 * src/lib/search/config.ts
 *
 * The one place that answers "is web search on, what does it cost, and is
 * there a backend behind it".
 *
 * Three callers need the same answers: the public `/v1/search` route, the
 * assistant's `web_search` tool, and the admin panel. Reading them separately
 * is how a page comes to say "enabled" while the endpoint is refusing, or a
 * price edit reaches one door and not the other. The provider table is the
 * authority for *which* backend answers; the environment is only the fallback
 * for a deployment that has never added a provider row.
 *
 * ## There is no separate on/off switch
 *
 * The state belongs to the provider rows: a search is on when at least one
 * enabled row can answer, and off when the operator disabled them all. A
 * feature-wide switch beside the list was a second source of truth for the
 * same fact, and the two could disagree — the panel said "on" while the
 * endpoint refused, or the panel said "off" while a request went through.
 *
 * A deployment that had deliberately switched the feature off keeps that
 * meaning: the switch's "off" was folded into the rows when this landed (see
 * the migration in `src/lib/db/sqlite.ts`), so the state the operator set is
 * still the state they see.
 */
import { getSettings, type AppSettings } from "@/lib/db/settings";
import { activeSearchBackendInfo } from "./resolve";
import { listSearchProviders } from "@/lib/db/search-providers";
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
  /**
   * False means both `/v1/search` and the assistant's tool refuse.
   *
   * Read off the provider rows: on when at least one enabled row can answer,
   * off when the operator disabled them all. There is no second switch beside
   * the list — see the note at the top of this file.
   */
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
  backendSource: "db" | "env" | "user" | null;
  /** The provider's kind. */
  backendKind: SearchProvider | null;
  /** The id written into usage rows for this backend. */
  backendProviderId: string | null;
  /**
   * The client-visible name of the service that answers when nobody names one.
   *
   * The operator marks it in the panel; it is the deployment's answer to "which
   * one runs when nobody says" — a question a client speaking the other search
   * APIs has no field for. Null when nobody marked one.
   */
  defaultServiceId: string | null;
}

/**
 * Resolve the configuration, optionally reusing an already-loaded settings
 * object so a page does not read the table twice.
 */
export async function loadSearchConfig(settings?: AppSettings): Promise<SearchConfig> {
  const stored = settings ?? (await getSettings());
  // The rows are read once and used twice: the backend that answers comes from
  // them, and so does the on/off state. This runs on every search.
  const rows = await listSearchProviders();
  const backend = await activeSearchBackendInfo(process.env, rows);
  const providerPrice = backend.source === "db" ? backend.creditsPerCall : null;

  /**
   * Whether the feature is switched on, read off the provider rows.
   *
   * With rows, the state is the rows: one of them enabled means the operator
   * wants search, all of them disabled means the operator turned it off. With
   * no rows the environment fallback decides — and if that is not configured
   * either, the endpoint says "not configured", which is a different thing
   * from "off" and says so.
   */
  const enabled = rows.length === 0 ? true : rows.some((row) => row.enabled);

  return {
    enabled,
    creditsPerCall:
      providerPrice ?? stored.searchCreditsPerCall ?? envSearchCredits() ?? DEFAULT_SEARCH_CREDITS,
    creditsFromProvider: providerPrice !== null,
    backendConfigured: backend.configured,
    backendName: backend.name,
    backendUrl: backend.baseUrl,
    backendSource: backend.source,
    backendKind: backend.kind,
    backendProviderId: backend.usageProviderId,
    defaultServiceId: stored.searchDefaultServiceId ?? null,
  };
}
