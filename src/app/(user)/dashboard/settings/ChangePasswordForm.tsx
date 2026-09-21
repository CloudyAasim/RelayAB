"use client";

import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { Lock, CheckCircle2, AlertCircle } from "lucide-react";

export function ChangePasswordForm() {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const lenValid = newPassword.length === 0 || newPassword.length >= 8;
  const matchValid = confirmPassword.length === 0 || newPassword === confirmPassword;
  const differValid = newPassword.length === 0 || newPassword !== currentPassword;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!currentPassword) {
      setError(t("settings.password.errorMissingCurrent"));
      return;
    }
    if (newPassword.length < 8) {
      setError(t("settings.password.errorTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("settings.password.errorMismatch"));
      return;
    }
    if (newPassword === currentPassword) {
      setError(t("settings.password.errorUnchanged"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await res.json();
      if (!data.ok) {
        // Prefer a localized message keyed off `error.code`; fall back to the
        // server's English text only for codes we don't know about.
        setError(
          apiErrorMessage(t, data.error?.code, data.error?.message) ||
            t("settings.password.errorGeneric"),
        );
        return;
      }
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.password.errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Input
        label={t("settings.password.current")}
        type="password"
        name="currentPassword"
        autoComplete="current-password"
        required
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
      />
      <Input
        label={t("settings.password.new")}
        type="password"
        name="newPassword"
        autoComplete="new-password"
        required
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        hint={!lenValid ? t("settings.password.hintTooShort") : t("settings.password.hintLength")}
        error={!lenValid ? t("settings.password.errorTooShort") : undefined}
      />
      <Input
        label={t("settings.password.confirm")}
        type="password"
        name="confirmPassword"
        autoComplete="new-password"
        required
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        hint={
          !matchValid
            ? t("settings.password.errorMismatch")
            : !differValid
              ? t("settings.password.errorUnchanged")
              : t("settings.password.hintConfirm")
        }
        error={
          !matchValid
            ? t("settings.password.errorMismatch")
            : !differValid
              ? t("settings.password.errorUnchanged")
              : undefined
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.password.success")}</span>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button type="submit" loading={submitting}>
          <Lock className="mr-1.5 h-4 w-4" />
          {t("settings.password.submit")}
        </Button>
      </div>
    </form>
  );
}
