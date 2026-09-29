"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { Pencil, Power, Trash2 } from "lucide-react";
import { MediaProviderForm, type MediaProviderRow } from "./MediaProviderForm";

/**
 * Row actions for the media provider table — the media counterpart of
 * `ProviderActions`: the table row stays collapsed, and the full editor only
 * opens when you hit the pencil.
 */
export function MediaProviderActions({
  provider,
}: {
  provider: MediaProviderRow;
}) {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "delete" | "">("");
  const [isPending, startTransition] = useTransition();

  async function toggle() {
    setBusy("toggle");
    try {
      const res = await fetch(`/api/admin/media-providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !provider.enabled }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error?.message ?? t("common.failed"));
        return;
      }
      startTransition(() => window.location.reload());
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!confirm(t("admin.mediaProviders.confirmDelete", { name: provider.name }))) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/admin/media-providers/${provider.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error?.message ?? t("common.failed"));
        return;
      }
      startTransition(() => window.location.reload());
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <div
        className={`flex flex-row items-center gap-1 ${isPending ? "opacity-60" : ""}`}
      >
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setEditOpen(true)}
          title={t("common.edit")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={toggle}
          loading={busy === "toggle"}
          title={
            provider.enabled
              ? t("admin.mediaProviders.disable")
              : t("admin.mediaProviders.enable")
          }
        >
          <Power className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={remove}
          loading={busy === "delete"}
          title={t("common.delete")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t("admin.mediaProviders.edit")}
        wide
      >
        <MediaProviderForm
          provider={provider}
          onSaved={() => {
            setEditOpen(false);
            startTransition(() => window.location.reload());
          }}
        />
      </Modal>
    </>
  );
}
