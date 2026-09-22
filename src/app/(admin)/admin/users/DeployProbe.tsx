"use client";

import { useEffect, useState } from "react";

/**
 * Deployment probe rendered inside the version stamp of the admin users page.
 *
 * The stamp tells us *which build* is live; this tells us whether that build's
 * client JavaScript actually booted. If the bundle fails to load or hydration
 * never completes, every button on the page is inert — which looks exactly
 * like "the action does nothing", no matter how correct the server is.
 *
 * Server-rendered default is "未加载"; the effect flips it once React is live.
 */
export function DeployProbe() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    document.documentElement.dataset.relayJs = "ready";
  }, []);

  return (
    <span data-js-ready={hydrated ? "yes" : "no"}>
      {hydrated ? "JS 已加载" : "JS 未加载"}
    </span>
  );
}
