import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { getSettings } from "@/lib/db/settings";
import { loadSearchConfig } from "@/lib/search/config";
import { searchServices } from "@/lib/search/resolve";
import { listSearchProviders } from "@/lib/db/search-providers";
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

  const [{ t }, fullUser, catalog, settings] = await Promise.all([
    getT(),
    getUserById(sessionUser.id),
    cachedBuildModelCatalog(),
    getSettings(),
  ]);

  // Only an administrator can run the search probe; the route enforces it too,
  // and the card is not rendered at all for anyone else.
  const searchConfig =
    sessionUser.role === "admin" ? await loadSearchConfig(settings) : null;
  // The services on offer, for the tester to pick from. There is no default
  // one, so the operator says which to test.
  const searchServicesOnOffer =
    sessionUser.role === "admin" ? searchServices(await listSearchProviders()) : [];

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

  const rawLabels = {
    title: t("dashboard.models.probe.raw"),
    hint: t("dashboard.models.probe.rawHint"),
    method: t("dashboard.models.probe.method"),
    url: t("dashboard.models.probe.url"),
    headers: t("dashboard.models.probe.headers"),
    body: t("dashboard.models.probe.body"),
    send: t("dashboard.models.probe.send"),
    sending: t("dashboard.models.probe.sending"),
    status: t("dashboard.models.probe.status"),
    response: t("dashboard.models.probe.response"),
    failed: t("common.failed"),
  };

  const otherMediaLabels = {
    hint: t("dashboard.models.other.hint"),
    capability: t("dashboard.models.other.capability"),
    capabilities: {
      "image.generate": t("dashboard.models.other.capabilities.image"),
      "video.generate": t("dashboard.models.other.capabilities.video"),
      "audio.tts": t("dashboard.models.other.capabilities.tts"),
      "audio.stt": t("dashboard.models.other.capabilities.stt"),
      "music.generate": t("dashboard.models.other.capabilities.music"),
    },
    baseUrl: t("dashboard.models.custom.baseUrl"),
    apiKey: t("dashboard.models.custom.apiKey"),
    model: t("dashboard.models.custom.model"),
    prompt: t("dashboard.models.media.prompt"),
    size: t("dashboard.models.media.size"),
    voice: t("dashboard.models.media.voice"),
    duration: t("dashboard.models.media.duration"),
    n: t("dashboard.models.other.n"),
    audioFile: t("dashboard.models.media.audioFile"),
    negativePrompt: t("dashboard.models.other.negativePrompt"),
    seed: t("dashboard.models.other.seed"),
    speed: t("dashboard.models.other.speed"),
    format: t("dashboard.models.other.format"),
    language: t("dashboard.models.other.language"),
    endpoint: t("dashboard.models.probe.endpoint"),
    run: t("dashboard.models.media.run"),
    running: t("dashboard.models.media.running"),
    ok: t("dashboard.models.custom.ok"),
    failed: t("dashboard.models.custom.failed"),
    result: t("dashboard.models.other.result"),
    raw: t("dashboard.models.probe.raw"),
  };

  const otherSearchLabels = {
    hint: t("dashboard.models.searchOther.hint"),
    kind: t("dashboard.models.searchOther.kind"),
    kinds: {
      searxng: t("dashboard.models.searchOther.kinds.searxng"),
      tavily: t("dashboard.models.searchOther.kinds.tavily"),
      brave: t("dashboard.models.searchOther.kinds.brave"),
      "openai-compatible": t("dashboard.models.searchOther.kinds.openai"),
    },
    baseUrl: t("dashboard.models.custom.baseUrl"),
    apiKey: t("dashboard.models.custom.apiKey"),
    query: t("dashboard.models.searchOther.query"),
    limit: t("dashboard.models.searchOther.limit"),
    endpoint: t("dashboard.models.probe.endpoint"),
    run: t("dashboard.models.searchOther.run"),
    running: t("dashboard.models.searchOther.running"),
    ok: t("dashboard.models.custom.ok"),
    failed: t("dashboard.models.custom.failed"),
    raw: t("dashboard.models.probe.raw"),
    options: t("dashboard.models.searchOther.options"),
    language: t("dashboard.models.searchOther.language"),
    safesearch: t("dashboard.models.searchOther.safesearch"),
    timeRange: t("dashboard.models.searchOther.timeRange"),
    categories: t("dashboard.models.searchOther.categories"),
    pageno: t("dashboard.models.searchOther.pageno"),
    searchDepth: t("dashboard.models.searchOther.searchDepth"),
    topic: t("dashboard.models.searchOther.topic"),
    includeAnswer: t("dashboard.models.searchOther.includeAnswer"),
    includeRawContent: t("dashboard.models.searchOther.includeRawContent"),
    days: t("dashboard.models.searchOther.days"),
    country: t("dashboard.models.searchOther.country"),
    freshness: t("dashboard.models.searchOther.freshness"),
    extraSnippets: t("dashboard.models.searchOther.extraSnippets"),
    offset: t("dashboard.models.searchOther.offset"),
  };


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
          rawLabels={rawLabels}
          otherSearchLabels={otherSearchLabels}
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
            endpoint: t("dashboard.models.probe.endpoint"),
            reasoning: t("assistant.settings.reasoning"),
            reasoningOff: t("assistant.settings.reasoningOff"),
            thinkingMode: t("assistant.settings.thinkingMode"),
            thinkingVendorDefault: t("assistant.settings.thinkingVendorDefault"),
            thinkingOn: t("assistant.settings.thinkingOn"),
            thinkingOff: t("assistant.settings.thinkingOff"),
            sampling: t("dashboard.models.sampling"),
            systemPrompt: t("dashboard.models.test.system"),
            clear: t("dashboard.models.test.clear"),
            you: t("dashboard.models.test.you"),
            assistantRole: t("dashboard.models.test.assistant"),

            config: {
              account: t("dashboard.models.config.account"),
              key: t("dashboard.models.config.key"),
              other: t("dashboard.models.config.other"),
            },
          }}
          tabLabels={{
            text: t("dashboard.models.tabs.text"),
            media: t("dashboard.models.tabs.media"),
            search: t("dashboard.models.tabs.search"),
          }}
          mediaLabels={{
            title: t("dashboard.models.media.title"),
            configAccount: t("dashboard.models.config.account"),
            configKey: t("dashboard.models.config.key"),
            configOther: t("dashboard.models.config.other"),
            endpointLabel: t("dashboard.models.probe.endpoint"),
            otherLabels: otherMediaLabels,
            rawLabels,
           
            keyLabel: t("dashboard.models.media.keyLabel"),
            keyHint: t("dashboard.models.media.keyHint"),
            keyPlaceholder: t("dashboard.models.gateway.keyPlaceholder"),
            model: t("dashboard.models.media.model"),
            prompt: t("dashboard.models.media.prompt"),
            promptPlaceholder: t("dashboard.models.media.promptPlaceholder"),
            size: t("dashboard.models.media.size"),
            voice: t("dashboard.models.media.voice"),
            voiceHint: t("dashboard.models.media.voiceHint"),
            voiceCustom: t("dashboard.models.media.voiceCustom"),
            voiceLoading: t("dashboard.models.media.voiceLoading"),
            voiceEmpty: t("dashboard.models.media.voiceEmpty"),
            voiceListHint: t("dashboard.models.media.voiceListHint"),
            voiceUnavailable: t("dashboard.models.media.voiceUnavailable", { names: "{names}" }),
            voiceFailed: t("dashboard.models.media.voiceFailed", { reason: "{reason}" }),
            duration: t("dashboard.models.media.duration"),
            durationHint: t("dashboard.models.media.durationHint"),
            ratio: t("dashboard.models.media.ratio"),
            language: t("dashboard.models.media.language"),
            audioFile: t("dashboard.models.media.audioFile"),
            run: t("dashboard.models.media.run"),
            running: t("dashboard.models.media.running"),
            progressHint: t("dashboard.models.media.progressHint"),
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
            download: t("dashboard.models.media.download"),
          }}
          isAdmin={sessionUser.role === "admin"}
          searchUi={{
            config: {
              account: t("dashboard.models.config.account"),
              key: t("dashboard.models.config.key"),
              other: t("dashboard.models.config.other"),
            },
            resultCount: t("dashboard.models.search.resultCount"),
            limitHint: t("dashboard.models.search.limitHint"),
            serviceKey: t("dashboard.models.search.serviceKey"),
            notAdmin: t("dashboard.models.search.notAdmin"),
          }}
          searchTest={{
                  labels: {
                    title: t("admin.search.test.title"),
                    desc: t("admin.search.test.desc"),
                    query: t("admin.search.test.query"),
                    placeholder: t("admin.search.test.placeholder"),
                    run: t("admin.search.test.run"),
                    billed: t("admin.search.test.billed"),
                    // The numbers are only known after the probe runs, so the
                    // placeholders are kept as tokens and filled in the client.
                    latency: t("admin.search.test.latency", {
                      ms: "{ms}",
                      backend: "{backend}",
                    }),
                    charged: t("admin.search.test.charged", {
                      credits: "{credits}",
                      remaining: "{remaining}",
                    }),
                    empty: t("admin.search.test.empty"),
                    unavailable: t("admin.search.status.backendMissing"),
                    failed: t("common.failed"),
                    whichService: t("admin.search.test.whichService"),
                    whichServiceNone: t("admin.search.test.whichServiceNone"),
                    whichServiceNoneOne: t("admin.search.test.whichServiceNoneOne"),
                    viewList: t("admin.search.test.viewList"),
                    viewMarkdown: t("admin.search.test.viewMarkdown"),
                    copy: t("admin.search.test.copy"),
                    copied: t("admin.search.test.copied"),
                  },
                  backendName: searchConfig?.backendConfigured ? searchConfig.backendName : null,
                  // The services on offer, so the operator can pick the one to
                  // test: there is no default one to test.
                  services: searchServicesOnOffer.map((service) => ({
                    id: service.id,
                    name: service.name,
                  })),
          }}
          probeLabels={{
            ephemeral: t("dashboard.models.custom.ephemeral"),
            baseUrl: t("dashboard.models.custom.baseUrl"),
            apiKey: t("dashboard.models.custom.apiKey"),
            model: t("dashboard.models.custom.model"),
            prompt: t("dashboard.models.custom.prompt"),
            listModels: t("dashboard.models.custom.listModels"),
            testChat: t("dashboard.models.custom.testChat"),
            testing: t("dashboard.models.custom.testing"),
            ok: t("dashboard.models.custom.ok"),
            failed: t("dashboard.models.custom.failed"),
            foundModels: t("dashboard.models.custom.foundModels"),
            path: t("dashboard.models.probe.path"),
            endpoint: t("dashboard.models.probe.endpoint"),
            reasoning: t("assistant.settings.reasoning"),
            reasoningOff: t("assistant.settings.reasoningOff"),
            thinkingMode: t("assistant.settings.thinkingMode"),
            thinkingVendorDefault: t("assistant.settings.thinkingVendorDefault"),
            thinkingOn: t("assistant.settings.thinkingOn"),
            thinkingOff: t("assistant.settings.thinkingOff"),
            sampling: t("dashboard.models.sampling"),

            parameters: t("dashboard.models.gateway.parameters"),
            extraParameters: t("dashboard.models.gateway.extraParameters"),
            stream: t("dashboard.models.probe.stream"),
            raw: t("dashboard.models.probe.raw"),
            systemPrompt: t("dashboard.models.test.system"),
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
