"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";

export function UserActions({ user }: { user: User }) {
  const t = useT();
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !user.disabled }),
      });
      const data = await res.json();
      if (!data.ok) alert(apiErrorMessage(t, data.error?.code, data.error?.message));
      else window.location.reload();
    } catch {
      alert(t("admin.users.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/reset-password`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        alert(apiErrorMessage(t, data.error?.code, data.error?.message));
      } else {
        setNewPassword(data.data?.generatedPassword ?? null);
        setMenuOpen(false);
      }
    } catch {
      alert(t("admin.users.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    if (!confirm(t("admin.users.action.confirmDelete"))) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) alert(apiErrorMessage(t, data.error?.code, data.error?.message));
      else window.location.reload();
    } catch {
      alert(t("admin.users.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative inline-block text-left">
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={t("common.actions")}
        disabled={loading}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg animate-slide-down">
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
              {user.disabled ? t("admin.users.action.enable") : t("admin.users.action.disable")}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
              onClick={() => {
                setMenuOpen(false);
                reset();
              }}
              disabled={loading}
            >
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("admin.users.action.resetPassword")}
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
        open={newPassword !== null}
        onClose={() => setNewPassword(null)}
        title={t("admin.users.action.passwordReset")}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{user.username}</p>
          {newPassword && (
            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 font-mono text-sm break-all select-all">
              {newPassword}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("admin.users.action.passwordResetHint")}</p>
          <div className="flex justify-end pt-2">
            <Button onClick={() => setNewPassword(null)}>{t("common.close")}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
