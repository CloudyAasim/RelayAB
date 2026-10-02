"use client";

/**
 * src/lib/assistant/credential-store.ts
 *
 * One fetch, one truth, every panel.
 *
 * The tester page mounts two CredentialPanels and the assistant drawer mounts
 * a third. Each used to hold its own copy of the state and fetch it on mount,
 * so creating a credential in one left the others showing "you have not
 * created one" until a full page reload - which looks exactly like the create
 * button being broken.
 *
 * A store rather than a prop: the panels are siblings in different trees and in
 * different routes, so there is nowhere sensible to hoist the state to, and
 * lifting it would only move the duplication.
 *
 * Deliberately not a cache with a TTL. This is one row per user, it is only
 * ever read when a panel is on screen, and a stale answer here means the UI
 * claims a capability is unavailable when it is not.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

export interface CredentialState {
  created: boolean;
  enabled: boolean;
  keyPrefix: string | null;
  createdAt: string | null;
  usable: boolean;
}

export const EMPTY_CREDENTIAL: CredentialState = {
  created: false,
  enabled: false,
  keyPrefix: null,
  createdAt: null,
  usable: false,
};

type Snapshot = {
  data: CredentialState;
  /** null until the first fetch has answered; the panels show a real state. */
  loaded: boolean;
  /** Non-null while a mutation is in flight, so several panels agree. */
  busy: string | null;
  error: string | null;
};

let snapshot: Snapshot = { data: EMPTY_CREDENTIAL, loaded: false, busy: null, error: null };
const listeners = new Set<() => void>();

function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable identity, so useSyncExternalStore does not resubscribe every render. */
function getSnapshot(): Snapshot {
  return snapshot;
}

async function readError(res: Response, body: unknown): Promise<string> {
  const code = (body as { error?: { code?: string; message?: string } } | null)?.error?.code;
  const message = (body as { error?: { message?: string } } | null)?.error?.message;
  return message ?? (code ? String(code) : `HTTP ${res.status}`);
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/assistant/credentials", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as { data?: CredentialState } | null;
    if (res.ok && json?.data) publish({ data: json.data, error: null });
    else publish({ data: EMPTY_CREDENTIAL, error: await readError(res, json) });
  } catch (err) {
    publish({
      data: EMPTY_CREDENTIAL,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    publish({ loaded: true });
  }
}

let inFlight: Promise<void> | null = null;

/** Fetch once no matter how many panels mount at the same time. */
function ensureLoaded(): void {
  if (snapshot.loaded || inFlight) return;
  inFlight = refresh().finally(() => {
    inFlight = null;
  });
}

export type CredentialAction = "create" | "enable" | "disable" | "rotate" | "remove";

/**
 * Apply a change and tell every mounted panel about it.
 *
 * The response is written into the store directly rather than fetched again,
 * so the panel that made the change and the ones that did not all settle on the
 * same answer in the same tick.
 */
export async function mutateCredential(action: CredentialAction): Promise<boolean> {
  publish({ busy: action, error: null });
  try {
    const res = await fetch("/api/assistant/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const json = (await res.json().catch(() => null)) as { data?: CredentialState } | null;
    if (!res.ok || !json?.data) {
      publish({ error: await readError(res, json) });
      return false;
    }
    publish({ data: json.data, error: null });
    return true;
  } catch (err) {
    publish({ error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    publish({ busy: null });
  }
}

export function useCredentialStore(): Snapshot & {
  refresh: () => void;
  mutate: (action: CredentialAction) => Promise<boolean>;
  /** Re-render the server components around the panels. */
  refreshServer: () => void;
} {
  const router = useRouter();
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refreshServer = useCallback(() => router.refresh(), [router]);

  // An effect, not render: kicking off a fetch while rendering is a side
  // effect in the render phase, which React is right to complain about and
  // which double-fires under StrictMode.
  useEffect(() => {
    ensureLoaded();
  }, []);

  return {
    ...value,
    refresh: refresh,
    mutate: mutateCredential,
    refreshServer,
  };
}
