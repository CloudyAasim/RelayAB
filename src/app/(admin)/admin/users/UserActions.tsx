"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";

export function UserActions({ user: serverUser }: { user: User }) {
  const t = useT();
  const router = useRouter();

  // We treat the SERVER as the source of truth. `serverUser` is the prop
  // coming from the parent server component (re-renders on every page refresh
  // because UsersPage declares `export const dynamic = "force-dynamic"`).
  //
  // We do NOT maintain a local copy of `disabled` because that creates a
  // two-source-of-truth problem: a sync effect can fight the optimistic update.
  // Instead, after a successful toggle we trigger router.refresh() + a hard
  // navigation, both of which cause the parent to re-render with fresh data
  // from Redis.

  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function toggle() {
    if (loading) return;

    const targetDisabled = !serverUser.disabled;

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

      if (!res.ok || !data.ok) {
        const msg =
          apiErrorMessage(t, data?.error?.code, data?.error?.message) ??
          t("admin.users.action.failed");
        alert(msg);
        return;
      }

      // Tell Next.js to re-render the server component with fresh data.
      // The parent's `dynamic = "force-dynamic"` guarantees a fresh fetch
      // from Redis on this refresh.
      try {
        router.refresh();
      } catch {
        // ignore
      }

      // Hard reload as a fallback — guaranteed to bypass any cache layer.
      // We do this after a tick so router.refresh() gets a chance first
      // (router.refresh is the smooth UX path; the hard reload is the
      // belt-and-suspenders backup).
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("_", String(Date.now()));
        window.location.assign(url.toString());
      }, 200);
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
      else {
        router.refresh();
        setTimeout(() => window.location.reload(), 200);
      }
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
