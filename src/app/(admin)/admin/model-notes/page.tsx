import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { cachedGetSettings, cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { SectionPageLayout } from "@/components/layouts";
import { ModelNotesForm, type ModelNoteInput } from "./ModelNotesForm";

export const metadata = { title: { absolute: "模型说明 - RelayAB" } };
export const dynamic = "force-dynamic";

/**
 * Per-model documentation, on its own page.
 *
 * It was a card at the bottom of the system settings, behind a save button
 * shared with the site's support contact and the custom documentation pages —
 * three unrelated things that happened to be stored in one table. The list
 * itself is a list over every model the deployment serves, and editing it is
 * its own job.
 */
export default async function ModelNotesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const { t } = await getT();

  let initial: Record<string, ModelNoteInput> = {};
  let models: Array<{ id: string; kind: "chat" | "media"; displayName: string }> = [];

  try {
    const settings = await cachedGetSettings();
    initial = settings.modelNotes ?? {};
  } catch (e) {
    console.error("Failed to load model notes:", e);
  }

  try {
    // The ids that actually exist, taken from the live catalogue, so the
    // operator never has to type a model name from memory and get it wrong.
    const catalog = await cachedBuildModelCatalog();
    models = catalog.models.map((m) => ({
      id: m.id,
      kind: m.kind,
      displayName: m.displayName,
    }));
  } catch (e) {
    console.error("Failed to load catalog:", e);
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.modelNotes.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className="space-y-6">
          <ModelNotesForm initial={initial} models={models} />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
