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
import { listProviders } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { getUserById } from "@/lib/db/users";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { ModelTester } from "./ModelTester";
import { CustomModelProbe } from "./CustomModelProbe";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const [{ t }, fullUser, providers, mediaProviders] = await Promise.all([
    getT(),
    getUserById(sessionUser.id),
    listProviders(),
    listMediaProviders(),
  ]);

  // A key that is not enabled can never be used, so do not offer it. The
  // whitelist is the user's own allocation, mirrored from the dashboard.
  const allowed = fullUser?.allowedModels ?? [];
  const chatModels = [...new Set(providers.filter((p) => p.enabled).flatMap((p) => Object.keys(p.modelMapping ?? {})))]
    .filter((m) => allowed.length === 0 || allowed.includes(m))
    .sort();
  const mediaModels = [...new Set(mediaProviders.filter((p) => p.enabled).flatMap((p) => Object.keys(p.models ?? {})))]
    .filter((m) => allowed.length === 0 || allowed.includes(m))
    .sort();

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
            mediaModels={mediaModels}
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
              mediaHint: t("dashboard.models.gateway.mediaHint"),
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
