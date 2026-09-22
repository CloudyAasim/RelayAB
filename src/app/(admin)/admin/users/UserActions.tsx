"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";

export function UserActions({ user: initialUser }: { user: User }) {
  const t = useT();
  const router = useRouter();

  const [user, setUser] = useState(initialUser);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  if (
    user.disabled !== initialUser.disabled ||
    user.role !== initialUser.role ||
    user.quotaLimit !== initialUser.quotaLimit
  ) {
    setUser(initialUser);
  }

  async function toggle() {
    if (loading) return;

    const targetDisabled = !user.disabled;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/toggle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
        body: JSON.stringify({ disabled: targetDisabled }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        const msg =
          apiErrorMessage(t, data?.error?.code, data?.error?.message) ??
          t("admin.users.action.failed");
        alert(msg);
        return;
      }

      // Apply optimistic update from server response
      if (data.data?.user) {
        const updated = data.data.user as User;
        setUser(updated);
      }

      // Force a full server re-render. We try router.refresh() first
      // (the canonical Next.js way), then fall back to a hard navigation
      // with a cache-busting query param so no CDN / browser cache can
      // possibly serve a stale page.
      try {
        router.refresh();
      } catch {
        // ignore
      }

      // Belt-and-suspenders: after a tick, do a hard navigation. This is
      // guaranteed to fetch a fresh server-rendered page because the URL
      // changes (?_= timestamp) — no cache layer can match.
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("_", String(Date.now()));
        window.location.assign(url.toString());
      }, 150);
    } catch (err) {
      console.error("[toggle] error:", err);
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
