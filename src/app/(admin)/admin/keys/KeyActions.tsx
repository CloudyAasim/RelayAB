"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { ApiKey } from "@/lib/db/types";
import { MoreHorizontal, Power, Trash2, Ban, Pencil } from "lucide-react";

export function KeyActions({ apiKey }: { apiKey: ApiKey }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Rename state
  const [renameModal, setRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState(apiKey.label);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);

  async function toggle(enabled: boolean) {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!data.ok) alert(data.error?.message ?? t("admin.keys.action.failed"));
      else window.location.reload();
    } catch {
      alert(t("admin.keys.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function forceDisable() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, forceDisabled: true }),
      });
      const data = await res.json();
      if (!data.ok) alert(data.error?.message ?? t("admin.keys.action.failed"));
      else window.location.reload();
    } catch {
      alert(t("admin.keys.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  /**
   * Lift an admin force-disable.
   *
   * This previously reused `toggle(false)`, which only sends `{enabled:false}`
   * — the `forceDisabled` flag was never cleared, so the action looked like a
   * no-op. The key stays disabled afterwards; the admin can enable it with the
   * regular button once the flag is gone.
   */
  async function clearForceDisable() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceDisabled: false }),
      });
      const data = await res.json();
      if (!data.ok) alert(data.error?.message ?? t("admin.keys.action.failed"));
      else window.location.reload();
    } catch {
      alert(t("admin.keys.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    if (!confirm(t("admin.keys.action.confirmDelete"))) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) alert(data.error?.message ?? t("admin.keys.action.failed"));
      else window.location.reload();
    } catch {
      alert(t("admin.keys.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  // Determine effective status
  const effectiveStatus = apiKey.forceDisabled === true
    ? "force_disabled"
    : apiKey.enabled
    ? "enabled"
    : "disabled";

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setMenuOpen(true)}
        aria-label={t("common.actions")}
        disabled={loading}
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
          {effectiveStatus === "force_disabled" ? (
            <p className="text-sm text-muted-foreground py-2">
              {t("admin.keys.status.forceDisabled")}
            </p>
          ) : effectiveStatus === "enabled" ? (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                setMenuOpen(false);
                toggle(false);
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
                toggle(true);
              }}
              disabled={loading}
            >
              <Power className="mr-2 h-4 w-4" />
              {t("admin.keys.action.enable")}
            </Button>
          )}

          {/* Force-disable is an admin override over the key's own state, so it
              must be available even when the key is already disabled —
              otherwise the admin has to enable it first just to lock it. */}
          {effectiveStatus !== "force_disabled" && (
            <Button
              variant="outline"
              className="w-full justify-start text-orange-600 hover:text-orange-700"
              onClick={() => {
                setMenuOpen(false);
                forceDisable();
              }}
              disabled={loading}
            >
              <Ban className="mr-2 h-4 w-4" />
              {t("admin.keys.action.forceDisable")}
            </Button>
          )}

          {effectiveStatus === "force_disabled" && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                setMenuOpen(false);
                clearForceDisable();
              }}
              disabled={loading}
            >
              <Power className="mr-2 h-4 w-4" />
              {t("admin.keys.action.removeForceDisable")}
            </Button>
          )}

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setRenameValue(apiKey.label);
              setRenameError(null);
              setMenuOpen(false);
              setRenameModal(true);
            }}
            disabled={loading}
          >
            <Pencil className="mr-2 h-4 w-4" />
            {t("admin.keys.action.rename")}
          </Button>

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

      <Modal
        open={renameModal}
        onClose={() => setRenameModal(false)}
        title={t("admin.keys.rename.title")}
      >
        <div className="space-y-3">
          <Input
            label={t("admin.keys.rename.title")}
            value={renameValue}
            onChange={(e) => {
              setRenameValue(e.target.value);
              setRenameError(null);
            }}
            error={renameError ?? undefined}
            maxLength={64}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameModal(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={renameLoading}
              onClick={async () => {
                const trimmed = renameValue.trim();
                if (!trimmed) {
                  setRenameError(t("admin.keys.rename.errorEmpty"));
                  return;
                }
                if (trimmed.length > 64) {
                  setRenameError(t("admin.keys.rename.errorTooLong"));
                  return;
                }
                setRenameLoading(true);
                setRenameError(null);
                try {
                  const res = await fetch(`/api/admin/keys/${apiKey.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ label: trimmed }),
                  });
                  const json = await res.json();
                  if (!res.ok || !json.ok) {
                    setRenameError(
                      apiErrorMessage(t, json?.error?.code, t("common.failed")),
                    );
                    return;
                  }
                  setRenameModal(false);
                  window.location.reload();
                } catch {
                  setRenameError(apiErrorMessage(t, undefined, t("common.failed")));
                } finally {
                  setRenameLoading(false);
                }
              }}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
