"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import type { PublicUser } from "@/lib/db/types";
import { MoreHorizontal, KeyRound, Trash2, Pencil } from "lucide-react";
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
  // Edit display name state
  const [displayNameModal, setDisplayNameModal] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState(serverUser.displayName ?? "");
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [displayNameLoading, setDisplayNameLoading] = useState(false);

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

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setDisplayNameValue(serverUser.displayName ?? "");
              setDisplayNameError(null);
              setDisplayNameModal(true);
              setMenuOpen(false);
            }}
            disabled={displayNameLoading}
          >
            <Pencil className="mr-2 h-4 w-4" />
            {t("admin.users.action.editDisplayName")}
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

      <Modal
        open={displayNameModal}
        onClose={() => setDisplayNameModal(false)}
        title={t("admin.users.editDisplayName.title")}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{serverUser.username}</p>
          <Input
            label={t("settings.displayName.label")}
            hint={t("settings.displayName.usernameHint", { username: serverUser.username })}
            value={displayNameValue}
            onChange={(e) => {
              setDisplayNameValue(e.target.value);
              setDisplayNameError(null);
            }}
            error={displayNameError ?? undefined}
            maxLength={64}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDisplayNameModal(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={displayNameLoading}
              onClick={async () => {
                const trimmed = displayNameValue.trim();
                if (!trimmed) {
                  setDisplayNameError(t("settings.displayName.errorEmpty"));
                  return;
                }
                setDisplayNameLoading(true);
                setDisplayNameError(null);
                try {
                  const res = await fetch(`/api/admin/users/${serverUser.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ displayName: trimmed }),
                  });
                  const json = await res.json();
                  if (!res.ok || !json.ok) {
                    setDisplayNameError(
                      json?.error?.code === "bad_request"
                        ? t("settings.displayName.errorEmpty")
                        : apiErrorMessage(t, json?.error?.code, t("common.failed")),
                    );
                    return;
                  }
                  setDisplayNameModal(false);
                  window.location.reload();
                } catch {
                  setDisplayNameError(apiErrorMessage(t, undefined, t("common.failed")));
                } finally {
                  setDisplayNameLoading(false);
                }
              }}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
