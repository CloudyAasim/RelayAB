import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { ModelsWorkspace } from "./ModelsWorkspace";

/**
 * **A server component.** It reads the session and builds the catalogue, so it
 * must not hold React state. An earlier version collected the ids the probe
 * lists right here; every type checked, the whole unit suite passed, and
 * `next build` refused it — the client/server boundary is not a type rule.
 * That state now lives in `ModelsWorkspace`, which is the client half.
 */
export default async function ModelsPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const [{ t }, fullUser, catalog] = await Promise.all([
    getT(),
    getUserById(sessionUser.id),
    cachedBuildModelCatalog(),
  ]);

  // One catalogue feeds both the docs page and this tester, so the two can
  // never list different models.
  const allowed = fullUser?.allowedModels ?? [];
  const visible = (id: string) => allowed.length === 0 || allowed.includes(id);

  const catalogChatModels = catalog.models
    .filter((m) => m.kind === "chat" && visible(m.id))
    .map((m) => m.id);
  const catalogMediaModels = catalog.models
    .filter((m) => m.kind === "media" && visible(m.id))
    .map((m) => ({ id: m.id, capability: m.capability ?? "", provider: m.provider }));

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("dashboard.models.title")}</SectionPageLayout.Title>

      {/* SectionPageLayout renders only its four slots and silently drops any
          other child — a page without this wrapper shows its title and nothing
          else. */}
      <SectionPageLayout.Content>
        <ModelsWorkspace
          catalogChatModels={catalogChatModels}
          catalogMediaModels={catalogMediaModels}
          gatewayLabels={{
            title: t("dashboard.models.gateway.title"),
            desc: t("dashboard.models.gateway.desc"),
            model: t("dashboard.models.gateway.model"),
            modelCustom: t("dashboard.models.gateway.modelCustom"),
            keyLabel: t("dashboard.models.gateway.keyLabel"),
            keyHint: t("dashboard.models.gateway.keyHint"),
            keyPlaceholder: t("dashboard.models.gateway.keyPlaceholder"),
            prompt: t("dashboard.models.gateway.prompt"),
            send: t("dashboard.models.gateway.send"),
            stop: t("dashboard.models.gateway.stop"),
            empty: t("dashboard.models.gateway.empty"),
            needsKey: t("dashboard.models.gateway.needsKey"),
            parameters: t("dashboard.models.gateway.parameters"),
            parametersHint: t("dashboard.models.gateway.parametersHint"),
            extraParameters: t("dashboard.models.gateway.extraParameters"),
            extraParametersHint: t("dashboard.models.gateway.extraParametersHint"),
            decisionAction: {
              kept: t("dashboard.models.gateway.action.kept"),
              dropped: t("dashboard.models.gateway.action.dropped"),
              defaulted: t("dashboard.models.gateway.action.defaulted"),
              forced: t("dashboard.models.gateway.action.forced"),
              clamped: t("dashboard.models.gateway.action.clamped"),
              renamed: t("dashboard.models.gateway.action.renamed"),
            },
            decidedBy: t("dashboard.models.tester.decidedBy"),
          }}
          mediaLabels={{
            title: t("dashboard.models.media.title"),
            desc: t("dashboard.models.media.desc"),
            keyLabel: t("dashboard.models.media.keyLabel"),
            keyHint: t("dashboard.models.media.keyHint"),
            keyPlaceholder: t("dashboard.models.gateway.keyPlaceholder"),
            model: t("dashboard.models.media.model"),
            prompt: t("dashboard.models.media.prompt"),
            promptPlaceholder: t("dashboard.models.media.promptPlaceholder"),
            size: t("dashboard.models.media.size"),
            voice: t("dashboard.models.media.voice"),
            voiceHint: t("dashboard.models.media.voiceHint"),
            duration: t("dashboard.models.media.duration"),
            durationHint: t("dashboard.models.media.durationHint"),
            ratio: t("dashboard.models.media.ratio"),
            language: t("dashboard.models.media.language"),
            audioFile: t("dashboard.models.media.audioFile"),
            run: t("dashboard.models.media.run"),
            running: t("dashboard.models.media.running"),
            needsKey: t("dashboard.models.media.needsKey"),
            needsPrompt: t("dashboard.models.media.needsPrompt"),
            needsFile: t("dashboard.models.media.needsFile"),
            imageResult: t("dashboard.models.media.imageResult"),
            audioResult: t("dashboard.models.media.audioResult"),
            videoResult: t("dashboard.models.media.videoResult"),
            textResult: t("dashboard.models.media.textResult"),
            failed: t("dashboard.models.media.failed"),
            empty: t("dashboard.models.media.empty"),
            unsupported: t("dashboard.models.media.unsupported"),
          }}
          probeLabels={{
            title: t("dashboard.models.custom.title"),
            desc: t("dashboard.models.custom.desc"),
            ephemeral: t("dashboard.models.custom.ephemeral"),
            baseUrl: t("dashboard.models.custom.baseUrl"),
            apiKey: t("dashboard.models.custom.apiKey"),
            model: t("dashboard.models.custom.model"),
            listModels: t("dashboard.models.custom.listModels"),
            testChat: t("dashboard.models.custom.testChat"),
            testing: t("dashboard.models.custom.testing"),
            ok: t("dashboard.models.custom.ok"),
            failed: t("dashboard.models.custom.failed"),
            foundModels: t("dashboard.models.custom.foundModels"),
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
