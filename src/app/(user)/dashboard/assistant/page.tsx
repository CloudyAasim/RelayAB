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
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { AssistantChat } from "./AssistantChat";
import { AssistantSettingsPanel } from "./AssistantSettingsPanel";
import { PendingActions } from "./PendingActions";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const [{ t }, settings] = await Promise.all([
    getT(),
    getPublicAssistantSettings(sessionUser.id),
  ]);
  const isAdmin = sessionUser.role === "admin";

  return (
    // No page title: the app header already says "AI 助手", and a chat screen
    // that greets you with its own name twice reads as two different screens.
    <SectionPageLayout scrollContent={false}>
      <SectionPageLayout.Content>
        <AssistantChat
          configured={Boolean(settings)}
          modelLabel={settings?.model ?? t("assistant.unconfiguredModel")}
          settingsPanel={<AssistantSettingsPanel initial={settings} />}
          pendingPanel={isAdmin ? <PendingActions isAdmin={isAdmin} /> : null}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
