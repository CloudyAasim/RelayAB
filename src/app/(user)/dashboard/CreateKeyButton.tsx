"use client";

import { useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { formatCredits, formatNumber } from "@/lib/utils";
import { KeyRound, Plus } from "lucide-react";

export interface UserAllocation {
  maxActiveKeys: number;
  activeKeyCount: number;
  allowedModels: string[];
}

interface Props {
  allocation: UserAllocation | null;
  primary?: boolean;
  /** Custom label (e.g. for use inside EmptyState). Defaults to localized default. */
  label?: ReactNode;
}

/**
 * Self-service "Create API Key" button for a regular user.
 *
 * The user picks:
 *   - label          (required)
 *   - expiresAt      (optional)
 *
 * Everything else (quota, allowed models) is fixed by the admin's allocation
 * for this user — surfaced as read-only "preview" so the user understands
 * what the new key will inherit.
 */
export function CreateKeyButton({ allocation, primary, label }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const atCap =
    allocation !== null &&
    allocation.maxActiveKeys > 0 &&
    allocation.activeKeyCount >= allocation.maxActiveKeys;

  function reset() {
    setKeyLabel("");
    setExpiresAt("");
    setPlainKey(null);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: keyLabel,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(apiErrorMessage(t, data.error?.code, data.error?.message));
        return;
      }
      setPlainKey(data.data?.plainKey ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        disabled={atCap}
        title={atCap ? t("dashboard.createKey.atCap") : undefined}
        variant={primary ? undefined : "primary"}
      >
        {label ?? (
          <>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("dashboard.createKey.button")}
          </>
        )}
      </Button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          if (plainKey) window.location.reload();
          reset();
        }}
        title={
          plainKey ? t("dashboard.createKey.created") : t("dashboard.createKey.button")
        }
      >
        {plainKey ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground">{t("dashboard.createKey.createdNotice")}</p>
            <div className="relative rounded-md border border-primary/30 bg-primary/5 p-3 font-mono text-xs break-all select-all">
              {plainKey}
            </div>
            <p className="text-xs text-muted-foreground">{t("dashboard.createKey.createdHint")}</p>
            <div className="flex justify-end pt-2">
              <Button
                onClick={() => {
                  setOpen(false);
                  reset();
                  window.location.reload();
                }}
              >
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              label={t("admin.keys.create.label")}
              required
              value={keyLabel}
              onChange={(e) => setKeyLabel(e.target.value)}
              placeholder={t("dashboard.createKey.labelPlaceholder")}
            />
            <Input
              label={t("dashboard.createKey.expiresAt")}
              hint={t("dashboard.createKey.expiresAtHint")}
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />

            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                {t("dashboard.createKey.inheritsTitle")}
              </div>
              {/* No per-key quota line: keys draw from the account's single
                  pool, and the dashboard already shows that balance. */}
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("dashboard.createKey.inheritsModels")}</span>
                <span className="font-medium text-foreground">
                  {allocation && allocation.allowedModels.length > 0
                    ? allocation.allowedModels.join(", ")
                    : t("dashboard.createKey.allModels")}
                </span>
              </div>
              {allocation && allocation.maxActiveKeys > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("dashboard.createKey.activeKeys")}</span>
                  <span className="font-medium text-foreground">
                    {allocation.activeKeyCount} / {allocation.maxActiveKeys}
                  </span>
                </div>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={loading}>
                {t("admin.keys.create.submit")}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
