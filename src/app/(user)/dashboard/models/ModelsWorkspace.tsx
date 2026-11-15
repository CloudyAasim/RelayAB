"use client";

/**
 * src/app/(user)/dashboard/models/ModelsWorkspace.tsx
 *
 * The test page: one card, three tabs, one shared piece of state.
 *
 * **Why one card.** The page used to stack three cards — chat, media, and a
 * separate "other provider" probe — each with its own key input and its own
 * idea of what "configured" meant. They answer the same question ("what does
 * this thing do when I call it"), so they share one surface, and the tabs are
 * the only thing separating them. The other-provider form is now the text
 * tab's third configuration (其他服务商), not a fourth card.
 *
 * **Why this is a client component at all.** The probe can ask a vendor what
 * models it serves, and the testers can only choose from what they are given.
 * So the probe's result has to reach the testers' lists — which means state,
 * which means a client component. `page.tsx` is a server component (it reads
 * the session and builds the catalogue), so the state lives here instead.
 *
 * The first attempt put `useState` in `page.tsx`. Every type checked, `tsc` was
 * green, the whole unit suite passed — and `next build` failed with "You're
 * importing a component that needs `useState`. This React Hook only works in a
 * Client Component." The client/server boundary is not a type rule, so nothing
 * short of the build would have caught it.
 */
import { useCallback, useState } from "react";
import { Card } from "@/components/ui/Card";
import { ModelTester } from "./ModelTester";
import { MediaTester } from "./MediaTester";
import { SearchTester, type SearchTestLabels } from "./SearchTester";
import type { RawRequestLabels } from "./RawRequestPanel";
import type { OtherSearchLabels } from "./OtherSearchProbe";

type GatewayLabels = React.ComponentProps<typeof ModelTester>["labels"];
type MediaLabels = React.ComponentProps<typeof MediaTester>["labels"];
type ProbeLabels = React.ComponentProps<typeof ModelTester>["otherLabels"];
type MediaModel = React.ComponentProps<typeof MediaTester>["models"][number];

type Tab = "text" | "media" | "search";

export function ModelsWorkspace({
  catalogChatModels,
  catalogMediaModels,
  gatewayLabels,
  mediaLabels,
  probeLabels,
  rawLabels,
  otherSearchLabels,
  searchUi,
  isAdmin,
  tabLabels,
  searchTest,
}: {
  catalogChatModels: string[];
  catalogMediaModels: MediaModel[];
  gatewayLabels: GatewayLabels;
  mediaLabels: MediaLabels;
  /** Labels for the text tab's 其他服务商 form. */
  probeLabels: ProbeLabels;
  rawLabels: RawRequestLabels;
  /** Labels for the search tab's 其他服务商 form. */
  otherSearchLabels: OtherSearchLabels;
  /** Labels for the search tab's three configurations and the result count. */
  searchUi: {
    config: { account: string; key: string; other: string };
    resultCount: string;
    limitHint: string;
    serviceKey: string;
    notAdmin: string;
    configLabel: string;
  };
  /** Only an administrator can run the deployment's own search. */
  isAdmin: boolean;
  /** What the three tabs are called. */
  tabLabels: { text: string; media: string; search: string };
  /**
   * The deployment's search facts. Only an administrator can run the account
   * path; `backendName` is null for everyone else, and the other two
   * configurations still work.
   */
  searchTest: {
    labels: SearchTestLabels;
    backendName: string | null;
    /** The deployment's search services, so the operator can pick one to test. */
    services: Array<{ id: string; name: string }>;
  };
}) {
  /**
   * Models a vendor listed through the probe, for this page view only.
   *
   * The catalogue is a snapshot of what was configured when the page was
   * rendered, so a vendor added since — or one still only reachable by its own
   * key — is not in it. This is where those become selectable. Held in state
   * rather than persisted: it is a lookup aid, and a list of ids nobody chose
   * to keep should not outlive the page.
   */
  const [probed, setProbed] = useState<string[]>([]);
  const onFetched = useCallback(
    (ids: string[]) => setProbed((prev) => [...new Set([...prev, ...ids])]),
    [],
  );

  const [tab, setTab] = useState<Tab>("text");

  const chatModels = [...new Set([...catalogChatModels, ...probed])];
  const mediaModels = [
    ...catalogMediaModels,
    // A probed id has no capability or provider until the catalogue catches
    // up; the tester copes with that (no badge rather than a wrong one).
    ...probed.map((id) => ({ id, capability: "", provider: "" })),
  ];

  const tabs: Array<{ id: Tab; label: string; visible: boolean }> = [
    { id: "text", label: tabLabels.text, visible: true },
    { id: "media", label: tabLabels.media, visible: true },
    { id: "search", label: tabLabels.search, visible: true },
  ];

  return (
    <Card>
      <div role="tablist" className="mb-4 flex gap-1 border-b border-border">
        {tabs
          .filter((entry) => entry.visible)
          .map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={
                tab === entry.id
                  ? "-mb-px border-b-2 border-primary px-3 pb-2 pt-1 text-sm font-medium text-foreground"
                  : "-mb-px border-b-2 border-transparent px-3 pb-2 pt-1 text-sm text-muted-foreground hover:text-foreground"
              }
            >
              {entry.label}
            </button>
          ))}
      </div>

      {tab === "text" && (
        <ModelTester
          embedded
          chatModels={chatModels}
          labels={gatewayLabels}
          otherLabels={probeLabels}
          rawLabels={rawLabels}
          onFetched={onFetched}
        />
      )}

      {tab === "media" && (
        <MediaTester embedded models={mediaModels} labels={mediaLabels} />
      )}

      {tab === "search" && (
        <SearchTester
          labels={searchTest.labels}
          backendName={searchTest.backendName}
          services={searchTest.services}
          isAdmin={isAdmin}
          config={searchUi.config}
          resultCount={searchUi.resultCount}
          limitHint={searchUi.limitHint}
          serviceKey={searchUi.serviceKey}
          notAdmin={searchUi.notAdmin}
          configLabel={searchUi.configLabel}
          otherLabels={otherSearchLabels}
          rawLabels={rawLabels}
          embedded
        />
      )}
    </Card>
  );
}
