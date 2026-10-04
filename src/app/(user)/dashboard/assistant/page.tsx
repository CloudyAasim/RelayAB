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

  return (
    // No page title: the app header already says "AI 助手", and a chat screen
    // that greets you with its own name twice reads as two different screens.
    <SectionPageLayout scrollContent={false}>
      <SectionPageLayout.Content>
        <AssistantChat
          configured={Boolean(settings)}
          modelLabel={settings?.model ?? t("assistant.unconfiguredModel")}
          accountModels={suggestedModels}
          settingsPanel={
            <AssistantSettingsPanel initial={settings} suggestedModels={suggestedModels} />
          }
          pendingPanel={isAdmin ? <PendingActions isAdmin={isAdmin} /> : null}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
