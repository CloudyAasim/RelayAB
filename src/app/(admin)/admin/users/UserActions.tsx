"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { PublicUser } from "@/lib/db/types";
import { MoreHorizontal, KeyRound, Trash2 } from "lucide-react";
import { resetPasswordAction } from "./actions";

/**
 * UserActions — per-row action menu for the admin users table.
 */
export function UserActions({ user: serverUser }: { user: PublicUser }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModal, setPasswordModal] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [isResetting, startResetTransition] = useTransition();
  const [pending, setPending] = useState<"delete" | null>(null);

  async function runReset() {
    setResetError(null);
    startResetTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("userId", serverUser.id);
        const result = await resetPasswordAction(fd);
        setPasswordModal(result.generatedPassword);
        setMenuOpen(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("NEXT_REDIRECT") || msg.includes("NEXT_NOT_FOUND")) return;
        setResetError(apiErrorMessage(t, undefined, msg));
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
            onClick={runReset}
            disabled={isResetting || pending !== null}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            {t("admin.users.action.resetPassword")}
          </Button>

          <div className="border-t border-border pt-2">
            <form
              method="POST"
              action={`/api/admin/users/${serverUser.id}/delete-form`}
              onSubmit={(e) => {
                if (!confirm(t("admin.users.action.confirmDelete"))) {
                  e.preventDefault();
                  return;
                }
                setPending("delete");
              }}
            >
              <input type="hidden" name="userId" value={serverUser.id} />
              <Button
                type="submit"
                variant="ghost"
                className="w-full justify-start text-destructive hover:bg-destructive/10"
                loading={pending === "delete"}
                disabled={pending !== null}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("common.delete")}
              </Button>
            </form>
          </div>

          {resetError && (
            <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {resetError}
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
