"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { User } from "@/lib/db/types";
import { MoreHorizontal, Power, KeyRound, Trash2 } from "lucide-react";
import { resetPasswordAction } from "./actions";

/**
 * UserActions — per-row action menu for the admin users table.
 *
 * Toggle and delete use plain HTML forms POSTed to the corresponding
 * REST route. No JavaScript orchestrates the request — the browser
 * handles the submit, the server performs the mutation, then returns
 * a 303 redirect to /admin/users. The browser follows the redirect
 * and the page re-renders with fresh Redis state.
 *
 * Reset-password uses a Server Action because it needs to RETURN the
 * generated plaintext to the UI (a 303 redirect can't carry that).
 *
 * ⚠️ DO NOT unmount these forms from their `onSubmit` handler.
 *
 * Closing the modal (`setMenuOpen(false)`) inside `onSubmit` removes the
 * <form> from the DOM while the submit event is still being dispatched.
 * The browser then aborts the pending navigation with
 * "Form submission canceled because the form is not connected", so the
 * POST never leaves the browser — the row silently stays unchanged.
 * That is exactly why the earlier "plain form" attempt appeared to do
 * nothing in production. Mark the row as busy instead and let the browser
 * finish the submit; the 303 redirect renders the modal away for us.
 */
export function UserActions({ user: serverUser }: { user: User }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModal, setPasswordModal] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [isResetting, startResetTransition] = useTransition();
  /** Which form-POST is in flight, so we can lock the menu against double
   *  submits without tearing the <form> out of the document. */
  const [pending, setPending] = useState<"toggle" | "delete" | null>(null);

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
          {/*
            Toggle: plain HTML form. Browser POSTs to the route, server
            disables/enables the user, then returns 303 to /admin/users.
            The browser follows the redirect and the page re-renders.
          */}
          <form
            method="POST"
            action={`/api/admin/users/${serverUser.id}/toggle`}
            onSubmit={() => setPending("toggle")}
          >
            <input type="hidden" name="userId" value={serverUser.id} />
            <input
              type="hidden"
              name="disabled"
              value={serverUser.disabled ? "false" : "true"}
            />
            <Button
              type="submit"
              variant="outline"
              className="w-full justify-start"
              loading={pending === "toggle"}
              disabled={pending !== null}
            >
              <Power className="mr-2 h-4 w-4" />
              {serverUser.disabled ? t("admin.users.action.enable") : t("admin.users.action.disable")}
            </Button>
          </form>

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={runReset}
            disabled={isResetting || pending !== null}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            {t("admin.users.action.resetPassword")}
          </Button>

          {/*
            Delete: also a plain form. Same pattern as toggle.
          */}
          <div className="border-t border-border pt-2">
            <form
              method="POST"
              action={`/api/admin/users/${serverUser.id}/delete-form`}
              onSubmit={(e) => {
                if (!confirm(t("admin.users.action.confirmDelete"))) {
                  // User declined → stop the native POST.
                  e.preventDefault();
                  return;
                }
                // Let the browser submit. Unmounting the form here would
                // cancel this very submission (see the note at the top).
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
