"use client";

/**
 * src/app/(user)/dashboard/models/ModelsWorkspace.tsx
 *
 * The three model tools, and the one piece of state they share.
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
import { ModelTester } from "./ModelTester";
import { MediaTester } from "./MediaTester";
import { CustomModelProbe } from "./CustomModelProbe";

type GatewayLabels = React.ComponentProps<typeof ModelTester>["labels"];
type MediaLabels = React.ComponentProps<typeof MediaTester>["labels"];
type ProbeLabels = React.ComponentProps<typeof CustomModelProbe>["labels"];
type MediaModel = React.ComponentProps<typeof MediaTester>["models"][number];

export function ModelsWorkspace({
  catalogChatModels,
  catalogMediaModels,
  gatewayLabels,
  mediaLabels,
  probeLabels,
}: {
  catalogChatModels: string[];
  catalogMediaModels: MediaModel[];
  gatewayLabels: GatewayLabels;
  mediaLabels: MediaLabels;
  probeLabels: ProbeLabels;
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

  const chatModels = [...new Set([...catalogChatModels, ...probed])];
  const mediaModels = [
    ...catalogMediaModels,
    // A probed id has no capability or provider until the catalogue catches
    // up; the tester copes with that (no badge rather than a wrong one).
    ...probed.map((id) => ({ id, capability: "", provider: "" })),
  ];

  return (
    <div className="space-y-4">
      <ModelTester chatModels={chatModels} labels={gatewayLabels} />

      <MediaTester models={mediaModels} labels={mediaLabels} />

      <CustomModelProbe labels={probeLabels} onFetched={onFetched} />
    </div>
  );
}
