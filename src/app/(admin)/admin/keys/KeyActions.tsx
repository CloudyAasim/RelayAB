"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import type { ApiKey } from "@/lib/db/types";
import { MoreHorizontal, Power, Trash2, Ban } from "lucide-react";

export function KeyActions({ apiKey }: { apiKey: ApiKey }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

          {effectiveStatus !== "force_disabled" && apiKey.enabled && (
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
                toggle(false); // Disable first
              }}
              disabled={loading}
            >
              <Power className="mr-2 h-4 w-4" />
              {t("admin.keys.action.removeForceDisable")}
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
    </>
  );
}
