"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { ApiKey } from "@/lib/db/types";
import { formatDate } from "@/lib/utils";
import { MoreHorizontal, Edit3, Power, Trash2, Ban } from "lucide-react";

/**
 * Per-row actions for a key the current user OWNS:
 *   - rename (label)
 *   - change expiry
 *   - toggle enabled (unless admin force-disabled)
 *   - delete
 *
 * Uses a modal-based menu instead of a dropdown to avoid table overflow issues.
 */
export function UserKeyActions({ apiKey }: { apiKey: ApiKey }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [label, setLabel] = useState(apiKey.label);
  const [enabled, setEnabled] = useState(Boolean(apiKey.enabled));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(apiKey.expiresAt));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setLabel(apiKey.label);
    setEnabled(Boolean(apiKey.enabled));
    setExpiresAt(toLocalInput(apiKey.expiresAt));
    setError(null);
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/user/keys/${apiKey.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          enabled,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(apiErrorMessage(t, data.error?.code, data.error?.message));
        return;
      }
      setEditOpen(false);
      window.location.reload();
    } catch {
      setError(t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    const newEnabled = !Boolean(apiKey.enabled);
    console.log("[toggle] apiKey.enabled:", apiKey.enabled, "-> newEnabled:", newEnabled);
    setLoading(true);
    try {
      const res = await fetch(`/api/user/keys/${apiKey.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      const data = await res.json();
      console.log("[toggle] Response:", JSON.stringify(data));
      if (!data.ok) {
        alert(apiErrorMessage(t, data.error?.code, data.error?.message));
        return;
      }
      window.location.reload();
    } catch (err) {
      console.error("[toggle] Error:", err);
      alert(t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    if (!confirm(t("dashboard.keyActions.confirmDelete"))) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/user/keys/${apiKey.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) alert(apiErrorMessage(t, data.error?.code, data.error?.message));
      else window.location.reload();
    } catch {
      alert(t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  // Determine effective status
  const isForceDisabled = apiKey.forceDisabled === true;
  const isEnabled = apiKey.enabled === true;

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setMenuOpen(true)}
        aria-label={t("common.actions")}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>

      {/* Action Menu Modal */}
      <Modal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={apiKey.label}
        description={t("common.actions")}
      >
        <div className="space-y-2">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setMenuOpen(false);
              setEditOpen(true);
            }}
          >
            <Edit3 className="mr-2 h-4 w-4" />
            {t("common.edit")}
          </Button>

          {isForceDisabled ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-orange-600">
              <Ban className="h-4 w-4" />
              {t("admin.keys.status.forceDisabled")}
            </div>
          ) : isEnabled ? (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                setMenuOpen(false);
                toggle();
              }}
              disabled={loading}
            >
              <Power className="mr-2 h-4 w-4" />
              {t("admin.keys.action.disable")}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                setMenuOpen(false);
                toggle();
              }}
              disabled={loading}
            >
              <Power className="mr-2 h-4 w-4" />
              {t("admin.keys.action.enable")}
            </Button>
          )}

          <div className="border-t border-border pt-2">
            <Button
              variant="ghost"
              className="w-full justify-start text-destructive hover:bg-destructive/10"
              onClick={() => {
                setMenuOpen(false);
                remove();
              }}
              disabled={loading}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common.delete")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
          reset();
        }}
        title={t("dashboard.keyActions.editTitle")}
      >
        <form onSubmit={save} className="space-y-4">
          <Input
            label={t("admin.keys.create.label")}
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            label={t("dashboard.createKey.expiresAt")}
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            hint={apiKey.expiresAt ? `${t("common.current")}: ${formatDate(apiKey.expiresAt)}` : undefined}
          />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
              disabled={isForceDisabled}
            />
            {t("dashboard.keyActions.enabled")}
            {isForceDisabled && (
              <span className="text-xs text-orange-600">({t("admin.keys.status.forceDisabled")})</span>
            )}
          </label>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => { setEditOpen(false); reset(); }}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={loading}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Convert ISO timestamp to `<input type=datetime-local>` value (no seconds / tz). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}
