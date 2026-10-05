"use client";

/**
 * app/(user)/dashboard/assistant/PendingActions.tsx
 *
 * The human half of the assistant's write path.
 *
 * Every card here is a change the assistant *wants* to make. Nothing has
 * happened yet — the provider layer is untouched until 确认 is pressed, and the
 * diff shown is computed from the current row, not from what the assistant
 * believed the row to be.
 *
 * The approve button disables itself the moment it is pressed. That is not
 * cosmetic: the server claims the action with a `status = 'pending'` predicate,
 * so a double-click or a second tab is reported as "already handled" instead of
 * writing twice, and the UI should not pretend otherwise.
 */
import { useCallback, useEffect, useState } from "react";
import { announcePendingChanged, onPendingChanged } from "@/lib/assistant/pending-bus";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/components/i18n/I18nProvider";

export interface AssistantActionView {
  id: string;
  kind: string;
  targetId: string | null;
  summary: string;
  diff: string;
  status: "pending" | "applied" | "rejected" | "failed";
  result: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<AssistantActionView["status"], "warning" | "success" | "slate" | "danger"> = {
  pending: "warning",
  applied: "success",
  rejected: "slate",
  failed: "danger",
};

/** A create cannot be completed without a key, and the key is not in the action. */
const CREATE_KINDS = new Set(["provider.create", "media_provider.create"]);

export function PendingActions({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [actions, setActions] = useState<AssistantActionView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Key drafts, per action.
   *
   * Kept here and nowhere else: not in the action, not in localStorage, and
   * cleared the moment the decision is sent — the same lifetime the key has on
   * the server. A draft that survived an approval would be a secret sitting in
   * a tab long after the thing it was for.
   */
  const [keys, setKeys] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/assistant/actions?status=pending", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { actions?: AssistantActionView[] } }
      | null;
    setActions(json?.data?.actions ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The other half of the page.
   *
   * This list used to be read on mount and after this component's own approve
   * or reject, and at no other time. A turn that created proposals updated the
   * badge above and left this list showing nothing, and returning to a tab left
   * both showing whatever was true when it was last looked at.
   */
  useEffect(() => onPendingChanged(() => void load()), [load]);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    // Read and clear before awaiting, so the field is empty from the moment the
    // request goes out rather than when it comes back.
    const apiKey = keys[id]?.trim() || undefined;
    setKeys((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/assistant/actions/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(apiKey ? { apiKey } : {}) }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!json?.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        // Put the key back only when it was refused for a reason the admin can
        // fix — retyping a secret because the server hiccupped helps nobody.
        if (apiKey && decision === "approve" && res.status !== 400) {
          setKeys((prev) => ({ ...prev, [id]: apiKey }));
        }
        await load();
        return;
      }
      await load();
      // The badge over this panel keeps its own copy of the count. Announcing
      // after the list settles means the two are never briefly disagreeing.
      announcePendingChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (actions.length === 0) {
    // Inside the drawer this used to render nothing at all, which reads as a
    // broken panel rather than an empty queue.
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        {t("actions.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <pre className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </pre>
      )}
      {actions.map((a) => (
        <div key={a.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[a.status]}>{t(`actions.status.${a.status}`)}</Badge>
            <span className="text-xs text-muted-foreground">{a.kind}</span>
          </div>
          <p className="text-sm font-medium">{a.summary}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">
            {a.diff}
          </pre>
          {a.status === "pending" && isAdmin && (
            <div className="space-y-2">
              {/* Only a create needs one, and it is not in the diff above —
                  which is the point. The assistant never handles a key, so
                  this field is the only place one is ever typed. */}
              {CREATE_KINDS.has(a.kind) && (
                <div className="space-y-1">
                  <label htmlFor={`key-${a.id}`} className="block text-xs font-medium text-foreground">
                    {t("actions.apiKeyLabel")}
                  </label>
                  <input
                    id={`key-${a.id}`}
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={keys[a.id] ?? ""}
                    onChange={(e) => setKeys((prev) => ({ ...prev, [a.id]: e.target.value }))}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">{t("actions.apiKeyHint")}</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={busyId === a.id || (CREATE_KINDS.has(a.kind) && !keys[a.id]?.trim())}
                  onClick={() => decide(a.id, "approve")}
                >
                  {t("actions.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === a.id}
                  onClick={() => decide(a.id, "reject")}
                >
                  {t("actions.reject")}
                </Button>
              </div>
            </div>
          )}
          {a.status === "pending" && !isAdmin && (
            <p className="text-xs text-muted-foreground">{t("actions.adminOnly")}</p>
          )}
        </div>
      ))}
    </div>
  );
}
