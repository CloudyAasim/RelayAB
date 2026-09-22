"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";

const MAX_DISPLAY_NAME = 64;

export function DisplayNameForm({
  initialDisplayName,
  username,
}: {
  initialDisplayName: string;
  username: string;
}) {
  const t = useT();
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const trimmed = displayName.trim();
  const isEmpty = trimmed.length === 0;
  const isTooLong = trimmed.length > MAX_DISPLAY_NAME;
  const isUnchanged = trimmed === initialDisplayName;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (isEmpty) {
      setError(t("settings.displayName.errorEmpty"));
      return;
    }
    if (isTooLong) {
      setError(t("settings.displayName.errorTooLong"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: trimmed }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(
          apiErrorMessage(t, data.error?.code, data.error?.message) ||
            t("settings.displayName.errorGeneric"),
        );
        return;
      }
      setSuccess(true);
      // Re-render the server shell so the header picks up the new name.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.displayName.errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Input
        label={t("settings.displayName.label")}
        name="displayName"
        value={displayName}
        maxLength={MAX_DISPLAY_NAME + 1}
        onChange={(e) => {
          setDisplayName(e.target.value);
          setSuccess(false);
        }}
        hint={t("settings.displayName.hint")}
        error={isTooLong ? t("settings.displayName.errorTooLong") : undefined}
      />
      <p className="text-xs text-muted-foreground">
        {t("settings.displayName.usernameHint", { username })}
      </p>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.displayName.success")}</span>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button type="submit" loading={submitting} disabled={isUnchanged || isEmpty || isTooLong}>
          <Save className="mr-1.5 h-4 w-4" />
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
