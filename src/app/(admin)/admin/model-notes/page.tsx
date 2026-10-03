import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { listProviders } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { cachedGetSettings } from "@/lib/db/data-cache";
import { SectionPageLayout } from "@/components/layouts";
import { ModelConfigForm } from "./ModelConfigForm";
import { DocsPagesForm } from "../settings/DocsPagesForm";
import { buildModelRows, type ModelNoteInput } from "@/lib/admin/model-config";

export const metadata = { title: { absolute: "模型说明 - RelayAB" } };
export const dynamic = "force-dynamic";

/**
 * Models and documentation, in one place.
 *
 * Two sections, each collapsible and each with its own save button. The buttons
 * are not a detail: they used to be one button over both, and saving one thing
 * rewrote the other from whatever the form happened to be holding.
 *
 * The model section edits the *provider* records as well as the prose, so a
 * model's context window, prices and whether the gateway routes to it at all are
 * set here rather than on a different page under a different button. There is
 * still one source of truth — these are the provider's values, written through.
 */
export default async function ModelNotesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const { t } = await getT();

  const [providers, mediaProviders] = await Promise.all([
    listProviders(),
    listMediaProviders(),
  ]);

  let notes: Record<string, ModelNoteInput> = {};
  let docPages: Parameters<typeof DocsPagesForm>[0]["initial"] = [];
  try {
    const settings = await cachedGetSettings();
    notes = settings.modelNotes ?? {};
    docPages = settings.docPages ?? [];
  } catch (e) {
    console.error("Failed to load settings:", e);
  }

  const rows = buildModelRows(providers, mediaProviders, notes);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.modelNotes.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className="space-y-6">
          <ModelConfigForm rows={rows} />
          <DocsPagesForm initial={docPages} />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
