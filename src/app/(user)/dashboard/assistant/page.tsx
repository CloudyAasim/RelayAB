/**
 * app/(user)/dashboard/assistant/page.tsx
 *
 * The assistant.
 *
 * One page for both tiers, with the difference made by the role rather than by
 * a separate screen: a regular user gets the chat plus their own settings, an
 * admin additionally gets the pending-change queue. Splitting into two routes
 * would have meant maintaining the same chat surface twice and would have made
 * "what can this person actually do" a question about URLs rather than about
 * the session.
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicAssistantSettings } from "@/lib/db/assistant";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { resolveAssistantConfig } from "@/lib/assistant/config";
import { loadSearchConfig } from "@/lib/search/config";
import { useOwnSearchService } from "@/lib/search/user";
import { getAssistantCredential } from "@/lib/db/assistant-keys";
import { DEFAULT_WEB_SEARCH_LIMIT } from "@/lib/search/usage";
import { MAX_SEARCH_RESULTS } from "@/lib/assistant/web-search";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { AssistantChat } from "./AssistantChat";
import { AssistantSettingsPanel } from "./AssistantSettingsPanel";
import { PendingActions } from "./PendingActions";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const [{ t }, settings, catalog, searchConfig] = await Promise.all([
    getT(),
    getPublicAssistantSettings(sessionUser.id),
    cachedBuildModelCatalog(),
    loadSearchConfig(),
  ]);
  const isAdmin = sessionUser.role === "admin";
  /**
   * Whether **this** account can search.
   *
   * The deployment's own backend is one way in and the account's own search
   * service is the other: a user who configured one of those should not be
   * told the deployment has no search. The administrator's switch still
   * governs — the deployment's search being off is a statement about the
   * deployment, and it is not a user's to overrule.
   *
   * The deployment's side additionally needs the **account identity**: the
   * assistant credential the user created and switched on. It is what makes
   * the deployment's resources spendable on their behalf, and the search goes
   * through the same gate as the model calls do.
   */
  const ownSearch = useOwnSearchService(settings);
  const credential = await getAssistantCredential(sessionUser.id);
  const accountSearchAvailable = Boolean(credential?.enabled);
  const webSearchAvailable =
    searchConfig.enabled &&
    (ownSearch || (searchConfig.backendConfigured && accountSearchAvailable));
  const webSearchDefault = settings?.webSearchDefault ?? true;
  const webSearchLimit = settings?.webSearchLimit ?? DEFAULT_WEB_SEARCH_LIMIT;

  /**
   * What the model field offers before anybody presses anything.
   *
   * The datalist is fed by `测试连通`, which needs the key retyped — so on a
   * fresh visit the list was empty and the dropdown simply did not exist, which
   * is how "there is still no dropdown" happens on a field that has one.
   *
   * This deployment's own chat models are a better default than nothing: the
   * common case is the assistant pointed at this very instance (the base URL
   * field is often already `…/v1`), and where it is not, these are only
   * suggestions on a field that accepts anything.
   */
  const suggestedModels = catalog.models
    .filter((m) => m.kind === "chat")
    .map((m) => m.id);

  /**
   * One answer, computed here, for everything on the page.
   *
   * The page, the chat and the chat route each used to decide this separately
   * and disagree, which is why a chosen model vanished on refresh and an
   * unconfigured assistant still answered. `resolveAssistantConfig` is the
   * single rule; the page only forwards what it says.
   */
  const config = resolveAssistantConfig(settings);

  /**
   * What this deployment knows about its own models, for the account path.
   *
   * Read live from the provider tables, which is the same source the proxy
   * enforces, so the window the form fills in is the window the turn will
   * actually have. A model with nothing configured resolves to nulls, and the
   * form leaves those two boxes blank rather than inventing numbers.
   */
  const accountFacts: Record<
    string,
    {
      contextLength: number | null;
      maxOutputTokens: number | null;
      reasoningLevels: string[];
      /**
       * Whether the model acts on `reasoning_effort`. Carried separately from
       * the levels because an empty list is ambiguous on its own — it is also
       * the answer for a model that has no levels *because the vendor ignores
       * the parameter*, and the form has to grey that out rather than offer a
       * free-text field for it.
       */
      reasoningEffortSupported: boolean;
      /**
       * Whether the model obeys a request to stop thinking. The same three
       * states, and the same reason: a model can take levels and still refuse to
       * be switched off, and only an explicit false should grey the control.
       */
      thinkingSwitchSupported: boolean;
    }
  > = {};
  for (const m of catalog.models) {
    if (m.kind !== "chat") continue;
    accountFacts[m.id] = {
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      // The vendor's own list for this model, or nothing. Empty is the answer
      // for a model that does not think, and the picker falls back to a field
      // the operator fills rather than to four names that would be wrong.
      reasoningLevels: m.reasoningLevels ?? [],
      // Absent from the catalogue means the row predates the flag, which is not
      // the same as the vendor refusing it. Only an explicit false greys the
      // control out.
      reasoningEffortSupported: m.reasoningEffortSupported !== false,
      // Same three states, same reason: only an explicit false greys the switch.
      thinkingSwitchSupported: m.thinkingSwitchSupported !== false,
    };
  }

  return (
    // No page title: the app header already says "AI 助手", and a chat screen
    // that greets you with its own name twice reads as two different screens.
    <SectionPageLayout scrollContent={false}>
      <SectionPageLayout.Content>
        <AssistantChat
          config={config}
          webSearchAvailable={webSearchAvailable}
          webSearchDefault={webSearchDefault}
          settingsPanel={
            <AssistantSettingsPanel
              initial={settings}
              suggestedModels={suggestedModels}
              accountModels={suggestedModels}
              accountFacts={accountFacts}
              isAdmin={isAdmin}
              webSearch={{
                available: webSearchAvailable,
                defaultOn: webSearchDefault,
                limit: webSearchLimit,
                maxResults: MAX_SEARCH_RESULTS,
                // The deployment's backend is named by an administrator, for an
                // administrator. A regular user has no business seeing which
                // vendor the operator buys search from — so the name is not
                // sent to them at all, rather than sent and hidden in the UI.
                backendName: isAdmin ? searchConfig.backendName : null,
                backendSource: isAdmin ? searchConfig.backendSource : null,
                ownBaseUrl: settings?.searchBaseUrl ?? null,
                ownHasKey: settings?.hasSearchApiKey ?? false,
                // The server's own answer about which backend is live, so the
                // form and the assistant cannot disagree about it.
                ownInUse: useOwnSearchService(settings),
              }}
            />
          }
          pendingPanel={isAdmin ? <PendingActions isAdmin={isAdmin} /> : null}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
