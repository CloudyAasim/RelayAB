/**
 * app/(user)/dashboard/models/page.tsx
 *
 * The model testing page.
 *
 * Two ways in, deliberately kept separate because their trust models differ:
 *
 *  1. **Test a model this gateway serves**, using the caller's own `sk-relay-…`
 *     key. That key stays in the browser and is sent per request, so the test
 *     exercises the same path a real client would, including the caller's own
 *     quota and model permissions.
 *  2. **Test an arbitrary model** the caller found elsewhere, by pasting a base
 *     URL and key. That key is used for one request and never stored — see
 *     `/api/models/probe`.
 *
 * The model list is rendered server-side from the provider table so the page is
 * useful on first paint and cannot be used to enumerate models the caller is
 * not entitled to (the API is the one that enforces the filter).
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { ModelTester } from "./ModelTester";
import { MediaTester } from "./MediaTester";
import { CustomModelProbe } from "./CustomModelProbe";

export const dynamic = "force-dynamic";

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
  const chatModels = catalog.models
    .filter((m) => m.kind === "chat" && visible(m.id))
    .map((m) => m.id);
  const mediaModels = catalog.models
    .filter((m) => m.kind === "media" && visible(m.id))
    .map((m) => ({ id: m.id, capability: m.capability ?? "", provider: m.provider }));

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("dashboard.models.title")}</SectionPageLayout.Title>

      {/* SectionPageLayout renders only its four slots and silently drops any
          other child — a page without this wrapper shows its title and nothing
          else. */}
      <SectionPageLayout.Content>
        <div className="space-y-4">
          <ModelTester
            chatModels={chatModels}
            labels={{
              title: t("dashboard.models.gateway.title"),
              desc: t("dashboard.models.gateway.desc"),
              keyLabel: t("dashboard.models.gateway.keyLabel"),
              keyHint: t("dashboard.models.gateway.keyHint"),
              keyPlaceholder: t("dashboard.models.gateway.keyPlaceholder"),
              prompt: t("dashboard.models.gateway.prompt"),
              send: t("dashboard.models.gateway.send"),
              stop: t("dashboard.models.gateway.stop"),
              empty: t("dashboard.models.gateway.empty"),
              needsKey: t("dashboard.models.gateway.needsKey"),
            }}
          />

          <MediaTester
            models={mediaModels}
            labels={{
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
          />

          <CustomModelProbe
            labels={{
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
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
