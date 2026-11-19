"use client";

/**
 * app/(admin)/admin/announcements/AnnouncementActions.tsx
 *
 * Row actions: edit, switch on/off, delete.
 *
 * The switch is the row's most-used control — an announcement is usually taken
 * down rather than deleted, because the people who already read it are the reason
 * it exists — so it sits next to the pencil and shows the action it will perform.
 */
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { AnnouncementForm, type AnnouncementRow } from "./AnnouncementForm";

export function AnnouncementActions({ announcement }: { announcement: AnnouncementRow }) {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "delete" | "">("");
  const [isPending, startTransition] = useTransition();

  async function toggle() {
    setBusy("toggle");
    try {
      const res = await fetch(`/api/admin/announcements/${announcement.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !announcement.enabled }),
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
    if (!confirm(t("admin.announcements.confirmDelete", { title: announcement.title }))) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/admin/announcements/${announcement.id}`, { method: "DELETE" });
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
      <div className={`flex flex-row items-center gap-1 ${isPending ? "opacity-60" : ""}`}>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setEditOpen(true)}
          title={t("common.edit")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        {/* Icon shows the action, title spells it out — one icon for two
            opposite actions is a button nobody can read. */}
        <Button
          size="icon"
          variant="ghost"
          onClick={toggle}
          loading={busy === "toggle"}
          title={
            announcement.enabled
              ? t("admin.announcements.disable")
              : t("admin.announcements.enable")
          }
          aria-label={
            announcement.enabled
              ? t("admin.announcements.disable")
              : t("admin.announcements.enable")
          }
          className={
            announcement.enabled
              ? "text-muted-foreground hover:text-destructive"
              : "text-foreground"
          }
        >
          {announcement.enabled ? (
            <PowerOff className="h-4 w-4" />
          ) : (
            <Power className="h-4 w-4" />
          )}
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
        title={t("admin.announcements.edit")}
        wide
      >
        <AnnouncementForm
          announcement={announcement}
          onSaved={() => {
            setEditOpen(false);
            startTransition(() => window.location.reload());
          }}
        />
      </Modal>
    </>
  );
}