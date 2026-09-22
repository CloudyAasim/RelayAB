"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { ApiKey } from "@/lib/db/types";
import { formatDate } from "@/lib/utils";
import { MoreHorizontal, Edit3, Power, Trash2 } from "lucide-react";

/**
 * Per-row actions for a key the current user OWNS:
 *   - rename (label)
 *   - change expiry
 *   - toggle enabled
 *   - delete
 *
 * Quota and allowed models are NOT editable from here — those are
 * admin-controlled.
 */
export function UserKeyActions({ apiKey }: { apiKey: ApiKey }) {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);
  const [label, setLabel] = useState(apiKey.label);
  const [enabled, setEnabled] = useState(apiKey.enabled);
  const [expiresAt, setExpiresAt] = useState(toLocalInput(apiKey.expiresAt));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function reset() {
    setLabel(apiKey.label);
    setEnabled(apiKey.enabled);
    setExpiresAt(toLocalInput(apiKey.expiresAt));
    setError(null);
  }

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

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
    setLoading(true);
    try {
      const res = await fetch(`/api/user/keys/${apiKey.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !apiKey.enabled }),
      });
      const data = await res.json();
      if (!data.ok) alert(apiErrorMessage(t, data.error?.code, data.error?.message));
      else window.location.reload();
    } catch {
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

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={t("common.actions")}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-md border border-border bg-popover text-popover-foreground shadow-lg animate-slide-down">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
              onClick={() => {
                setMenuOpen(false);
                setEditOpen(true);
              }}
            >
              <Edit3 className="h-4 w-4 text-muted-foreground" />
              {t("common.edit")}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
              onClick={() => {
                setMenuOpen(false);
                toggle();
              }}
              disabled={loading}
            >
              <Power className="h-4 w-4 text-muted-foreground" />
              {apiKey.enabled ? t("admin.keys.action.disable") : t("admin.keys.action.enable")}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-sm text-destructive hover:bg-destructive/5"
              onClick={() => {
                setMenuOpen(false);
                remove();
              }}
              disabled={loading}
            >
              <Trash2 className="h-4 w-4" />
              {t("common.delete")}
            </button>
          </div>
        </>
      )}

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
            />
            {t("dashboard.keyActions.enabled")}
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
    </div>
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
