/**
 * One number, two components that cannot see each other.
 *
 * The chat holds the pending **count**, for the badge, and refreshes it when a
 * turn creates a proposal. The panel holds the pending **list**, and fetched it
 * on mount and after its own approve or reject. The page hands the panel in as
 * a `pendingPanel` prop, so there is no shared state and no shared parent — and
 * the result was a badge that updated while the list under it did not, which
 * reads as the queue being empty when it is not.
 *
 * `router.refresh()` does not help: it re-renders the server components and
 * leaves a client component's state exactly where it was.
 *
 * So the two announce to each other instead. It is a bus rather than a context
 * because the prop boundary is the whole reason they cannot share state, and
 * restructuring the page to lift the list would mean moving the approve flow —
 * which owns a per-proposal API-key draft — up a level for no gain.
 */
export const PENDING_CHANGED = "relayab:assistant-pending-changed";

/** Tell the other side its copy of the queue is out of date. */
export function announcePendingChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PENDING_CHANGED));
}

/**
 * Run `fn` whenever the queue may have changed. Returns the unsubscribe.
 *
 * Also fires on returning to the foreground, because the most likely way for
 * this page to be wrong is for it to have been in a background tab while the
 * queue changed somewhere else.
 */
export function onPendingChanged(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onVisible = () => {
    if (document.visibilityState === "visible") fn();
  };
  window.addEventListener(PENDING_CHANGED, fn);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
    window.removeEventListener(PENDING_CHANGED, fn);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}
