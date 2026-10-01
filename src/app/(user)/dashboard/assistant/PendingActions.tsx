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

export function PendingActions({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const [actions, setActions] = useState<AssistantActionView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/assistant/actions/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!json?.ok) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        await load();
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (actions.length === 0) return null;

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
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={busyId === a.id}
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
          )}
          {a.status === "pending" && !isAdmin && (
            <p className="text-xs text-muted-foreground">{t("actions.adminOnly")}</p>
          )}
        </div>
      ))}
    </div>
  );
}
