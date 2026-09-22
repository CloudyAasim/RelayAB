"use client";

import { useState, useRef } from "react";
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
  // Use ref to always get the latest disabled state, avoiding stale closure issues
  const disabledRef = useRef(user.disabled);
  disabledRef.current = user.disabled;

  async function toggle() {
    const currentDisabled = disabledRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !currentDisabled }),
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
        title={user.username}
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
            {user.disabled ? t("admin.users.action.enable") : t("admin.users.action.disable")}
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setMenuOpen(false);
              reset();
            }}
            disabled={loading}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            {t("admin.users.action.resetPassword")}
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

      {/* Password Reset Modal */}
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
    </>
  );
}
