"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import type { ApiKey } from "@/lib/db/types";
import { MoreHorizontal, Power, Trash2, Edit3 } from "lucide-react";

export function KeyActions({ apiKey }: { apiKey: ApiKey }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.id}/toggle`, { method: "POST" });
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
            {apiKey.enabled ? t("admin.keys.action.disable") : t("admin.keys.action.enable")}
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
    </>
  );
}
