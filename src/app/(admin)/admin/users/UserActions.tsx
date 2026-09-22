"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";

// Bumped whenever the deployed client bundle changes meaningfully.
// Find this in the browser console with:  [UserActions] deployed v...
const CLIENT_VERSION = "v3-toggle-reload-2025-09-22";

export function UserActions({ user: serverUser }: { user: User }) {
  const t = useT();
  const router = useRouter();

  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function toggle() {
    if (loading) return;

    console.log(`[UserActions ${CLIENT_VERSION}] toggle() called for ${serverUser.username} (id=${serverUser.id})`);
    console.log(`[UserActions ${CLIENT_VERSION}] current disabled =`, serverUser.disabled);

    const targetDisabled = !serverUser.disabled;
    setLoading(true);
    try {
      const url = `/api/admin/users/${serverUser.id}/toggle`;
      console.log(`[UserActions ${CLIENT_VERSION}] POST ${url} body=`, JSON.stringify({ disabled: targetDisabled }));

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
        body: JSON.stringify({ disabled: targetDisabled }),
      });

      console.log(`[UserActions ${CLIENT_VERSION}] response status=${res.status}`);
      const data = await res.json();
      console.log(`[UserActions ${CLIENT_VERSION}] response body=`, JSON.stringify(data));

      if (!res.ok || !data.ok) {
        const msg =
          apiErrorMessage(t, data?.error?.code, data?.error?.message) ??
          t("admin.users.action.failed");
        console.warn(`[UserActions ${CLIENT_VERSION}] toggle failed:`, msg);
        alert(msg);
        return;
      }

      console.log(`[UserActions ${CLIENT_VERSION}] toggle succeeded, server disabled =`, data.data?.user?.disabled);

      // Trigger RSC refresh first
      try {
        router.refresh();
      } catch (e) {
        console.warn(`[UserActions ${CLIENT_VERSION}] router.refresh threw:`, e);
      }

      // Hard reload as a fallback. We use location.replace so the back-button
      // doesn't bring back the stale page.
      setTimeout(() => {
        const sep = window.location.href.includes("?") ? "&" : "?";
        const newUrl = `${window.location.href.split("?")[0]}${sep}_=${Date.now()}`;
        console.log(`[UserActions ${CLIENT_VERSION}] hard-reloading to`, newUrl);
        window.location.replace(newUrl);
      }, 100);
    } catch (err) {
      console.error(`[UserActions ${CLIENT_VERSION}] toggle exception:`, err);
      alert(t("admin.users.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${serverUser.id}/reset-password`, {
        method: "POST",
        headers: { "Cache-Control": "no-store" },
        cache: "no-store",
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
      const res = await fetch(`/api/admin/users/${serverUser.id}`, { method: "DELETE" });
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

      <Modal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={serverUser.username}
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
            {serverUser.disabled ? t("admin.users.action.enable") : t("admin.users.action.disable")}
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

      <Modal
        open={newPassword !== null}
        onClose={() => setNewPassword(null)}
        title={t("admin.users.action.passwordReset")}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{serverUser.username}</p>
          {newPassword && (
            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 font-mono text-sm break-all select-all">
              {newPassword}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("admin.users.action.passwordResetHint")}
          </p>
          <div className="flex justify-end pt-2">
            <Button onClick={() => setNewPassword(null)}>{t("common.close")}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
