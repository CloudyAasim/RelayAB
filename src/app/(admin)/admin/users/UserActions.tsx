"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";

const CLIENT_VERSION = "v5-dom-and-reload-2025-09-22";

export function UserActions({ user: serverUser }: { user: User }) {
  const t = useT();
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function toggle() {
    if (loading) return;

    const targetDisabled = !serverUser.disabled;

    // ─── Immediate optimistic DOM update ──────────────────────────
    // We update the badge directly in the DOM so the user sees the
    // change instantly, without waiting for the API call or a page
    // refresh. The server-side value will catch up after navigation.
    const td = document.querySelector(
      `td[data-user-id="${serverUser.id}"]`,
    );
    if (td) {
      td.setAttribute("data-disabled", String(targetDisabled));
      const badgeSpan = td.querySelector("span");
      if (badgeSpan) {
        badgeSpan.textContent = targetDisabled
          ? t("dashboard.status.disabled")
          : t("dashboard.status.enabled");
      }
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${serverUser.id}/toggle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
        body: JSON.stringify({ disabled: targetDisabled }),
      });

      const data = await res.json();

      console.log(`[UserActions ${CLIENT_VERSION}] response:`, { status: res.status, data });

      if (!res.ok || !data.ok) {
        // Revert the optimistic update if the API failed.
        if (td) {
          td.setAttribute("data-disabled", String(serverUser.disabled));
          const badgeSpan = td.querySelector("span");
          if (badgeSpan) {
            badgeSpan.textContent = serverUser.disabled
              ? t("dashboard.status.disabled")
              : t("dashboard.status.enabled");
          }
        }
        const msg =
          apiErrorMessage(t, data?.error?.code, data?.error?.message) ??
          t("admin.users.action.failed");
        alert(msg);
        setLoading(false);
        return;
      }

      // ─── Hard navigation to sync with server ─────────────────────
      // The DOM update above gives instant feedback. We then force a
      // full navigation so the parent server component re-renders
      // with fresh data from Redis (and our optimistic update is
      // confirmed by the server's response).
      const baseUrl = window.location.origin + window.location.pathname;
      const target = `${baseUrl}?_=${Date.now()}`;
      console.log(`[UserActions ${CLIENT_VERSION}] navigating to`, target);
      window.location.href = target;
    } catch (err) {
      console.error(`[UserActions ${CLIENT_VERSION}] toggle exception:`, err);
      alert(t("admin.users.action.failed"));
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
      else window.location.href = window.location.origin + window.location.pathname;
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
