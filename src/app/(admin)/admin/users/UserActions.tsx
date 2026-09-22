"use client";

import { useState, useTransition, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";
import { toggleUserAction, resetPasswordAction, deleteUserAction } from "./actions";

/**
 * UserActions — per-row action menu for the admin users table.
 *
 * Mutations are dispatched via Server Actions imported from ./actions.
 * Each Server Action ends with redirect("/admin/users") after
 * revalidatePath(); the browser follows the 303 to a freshly-rendered
 * page that reads the new state from Redis.
 */
export function UserActions({ user: serverUser }: { user: User }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModal, setPasswordModal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showError(msg: string) {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 5000);
  }

  function isNextNavError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message;
    return (
      msg.includes("NEXT_REDIRECT") ||
      msg.includes("NEXT_NOT_FOUND") ||
      // Next.js sometimes attaches the marker on the digest, not the message.
      (e as { digest?: string }).digest?.startsWith("NEXT_") === true
    );
  }

  function runToggle() {
    setError(null);
    setMenuOpen(false);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("userId", serverUser.id);
        fd.set("disabled", String(!serverUser.disabled));
        await toggleUserAction(fd);
        // On success, toggleUserAction redirected — control never reaches here.
      } catch (e) {
        if (isNextNavError(e)) return; // normal redirect, ignore
        const msg = e instanceof Error ? e.message : "unknown error";
        console.error("[UserActions] toggle failed:", e);
        showError(apiErrorMessage(t, undefined, msg));
        setMenuOpen(true);
      }
    });
  }

  function runReset() {
    setError(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("userId", serverUser.id);
        const result = await resetPasswordAction(fd);
        setPasswordModal(result.generatedPassword);
        setMenuOpen(false);
      } catch (e) {
        if (isNextNavError(e)) return;
        const msg = e instanceof Error ? e.message : "unknown error";
        showError(apiErrorMessage(t, undefined, msg));
      }
    });
  }

  function runDelete() {
    if (!confirm(t("admin.users.action.confirmDelete"))) return;
    setError(null);
    setMenuOpen(false);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("userId", serverUser.id);
        await deleteUserAction(fd);
      } catch (e) {
        if (isNextNavError(e)) return;
        const msg = e instanceof Error ? e.message : "unknown error";
        showError(apiErrorMessage(t, undefined, msg));
        setMenuOpen(true);
      }
    });
  }

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setMenuOpen(true)}
        aria-label={t("common.actions")}
        disabled={isPending}
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
            onClick={runToggle}
            disabled={isPending}
          >
            <Power className="mr-2 h-4 w-4" />
            {serverUser.disabled ? t("admin.users.action.enable") : t("admin.users.action.disable")}
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={runReset}
            disabled={isPending}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            {t("admin.users.action.resetPassword")}
          </Button>
          <div className="border-t border-border pt-2">
            <Button
              variant="ghost"
              className="w-full justify-start text-destructive hover:bg-destructive/10"
              onClick={runDelete}
              disabled={isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common.delete")}
            </Button>
          </div>
          {error && (
            <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={passwordModal !== null}
        onClose={() => setPasswordModal(null)}
        title={t("admin.users.action.passwordReset")}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{serverUser.username}</p>
          {passwordModal && (
            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 font-mono text-sm break-all select-all">
              {passwordModal}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("admin.users.action.passwordResetHint")}
          </p>
          <div className="flex justify-end pt-2">
            <Button onClick={() => setPasswordModal(null)}>{t("common.close")}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
