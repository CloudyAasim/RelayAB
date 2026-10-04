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
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { AssistantChat } from "./AssistantChat";
import { AssistantSettingsPanel } from "./AssistantSettingsPanel";
import { PendingActions } from "./PendingActions";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const [{ t }, settings, catalog] = await Promise.all([
    getT(),
    getPublicAssistantSettings(sessionUser.id),
    cachedBuildModelCatalog(),
  ]);
  const isAdmin = sessionUser.role === "admin";

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
  const accountFacts: Record<string, { contextLength: number | null; maxOutputTokens: number | null }> =
    {};
  for (const m of catalog.models) {
    if (m.kind !== "chat") continue;
    accountFacts[m.id] = { contextLength: m.contextLength, maxOutputTokens: m.maxOutputTokens };
  }

  return (
    // No page title: the app header already says "AI 助手", and a chat screen
    // that greets you with its own name twice reads as two different screens.
    <SectionPageLayout scrollContent={false}>
      <SectionPageLayout.Content>
        <AssistantChat
          config={config}
          settingsPanel={
            <AssistantSettingsPanel
              initial={settings}
              suggestedModels={suggestedModels}
              accountModels={suggestedModels}
              accountFacts={accountFacts}
            />
          }
          pendingPanel={isAdmin ? <PendingActions isAdmin={isAdmin} /> : null}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
