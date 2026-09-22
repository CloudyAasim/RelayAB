"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { formatCredits, formatNumber } from "@/lib/utils";
import { CREDIT_SCALE } from "@/lib/quota/credits";
import type { PublicUser } from "@/lib/db/types";
import { Settings2, Coins, ListChecks, KeyRound, Wallet } from "lucide-react";

/**
 * Format an amount in the unit the account is denominated in.
 * Locale-neutral on purpose — the surrounding template supplies the wording.
 */
function amount(type: PublicUser["quotaType"], n: number): string {
  return type === "tokens" ? formatNumber(n) : formatCredits(n);
}

interface Props {
  /** Password-hash-free projection — see UsersPage. */
  users: PublicUser[];
  /** Client-visible model ids across all enabled providers. */
  availableModels: string[];
}

export function AllocationEditor({ users, availableModels }: Props) {
  const t = useT();
  const [editing, setEditing] = useState<PublicUser | null>(null);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {users.map((u) => (
          <Card key={u.id} className="p-4 hover:border-primary/40 hover:shadow-md transition-all">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-foreground">{u.username}</div>
                <div className="text-xs text-muted-foreground">{u.displayName}</div>
              </div>
              <Badge tone={u.role === "admin" ? "primary" : "neutral"}>
                {u.role === "admin" ? t("admin.users.role.admin") : t("admin.users.role.user")}
              </Badge>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              <Row
                icon={<Coins className="h-3 w-3" />}
                k={t("admin.users.allocation.pool")}
                v={
                  u.quotaLimit === 0
                    ? t("admin.users.allocation.noPool")
                    : t("admin.users.allocation.poolValue", {
                        amount: amount(u.quotaType, u.quotaLimit),
                        unit: u.quotaType === "tokens" ? "tokens" : t("admin.keys.create.quotaType.credits"),
                      })
                }
              />
              <Row
                icon={<Wallet className="h-3 w-3" />}
                k={t("admin.users.allocation.poolUsed")}
                v={
                  u.quotaLimit === 0
                    ? "—"
                    : t("admin.users.allocation.poolUsedValue", {
                        used: amount(u.quotaType, u.quotaUsed),
                        total: amount(u.quotaType, u.quotaLimit),
                        remaining: amount(
                          u.quotaType,
                          Math.max(0, u.quotaLimit - u.quotaUsed),
                        ),
                      })
                }
              />
              <Row
                icon={<ListChecks className="h-3 w-3" />}
                k={t("admin.users.allocation.models")}
                v={
                  u.allowedModels.length > 0
                    ? u.allowedModels.join(", ")
                    : t("admin.users.allocation.allModels")
                }
              />
              <Row
                icon={<KeyRound className="h-3 w-3" />}
                k={t("admin.users.allocation.maxActiveKeys")}
                v={u.maxActiveKeys > 0 ? String(u.maxActiveKeys) : t("admin.users.allocation.uncapped")}
              />
            </dl>
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => setEditing(u)}>
                <Settings2 className="mr-1 h-3.5 w-3.5" />
                {t("admin.users.allocation.edit")}
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {editing && (
        <AllocationModal
          user={editing}
          availableModels={availableModels}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            window.location.reload();
          }}
        />
      )}
    </>
  );
}

function Row({
  icon,
  k,
  v,
}: {
  icon?: React.ReactNode;
  k: string;
  v: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {k}
      </dt>
      <dd className="text-right font-medium text-foreground break-all max-w-[60%]">{v}</dd>
    </div>
  );
}

function AllocationModal({
  user,
  availableModels,
  onClose,
  onSaved,
}: {
  user: PublicUser;
  availableModels: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [quotaType, setQuotaType] = useState<"credits" | "tokens">(user.quotaType);
  // quotaLimit is stored in units; convert to credits for form display
  const [quotaLimit, setQuotaLimit] = useState(
    user.quotaType === "credits"
      ? String(user.quotaLimit / CREDIT_SCALE)
      : String(user.quotaLimit)
  );
  const [resetUsage, setResetUsage] = useState(false);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(
    new Set(user.allowedModels),
  );
  // "Every model" is stored as an empty array, which is distinct from an
  // empty selection (which would lock the account out of everything).
  const [allModels, setAllModels] = useState(user.allowedModels.length === 0);
  const [maxActiveKeys, setMaxActiveKeys] = useState(String(user.maxActiveKeys));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usedLabel =
    user.quotaType === "tokens" ? formatNumber(user.quotaUsed) : formatCredits(user.quotaUsed);
  const selectionEmpty = !allModels && selectedModels.size === 0;

  function toggleModel(model: string) {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quotaType,
          quotaLimit: user.quotaType === "credits"
            ? Math.round(Number(quotaLimit) * CREDIT_SCALE)
            : Number(quotaLimit),
          ...(resetUsage ? { quotaUsed: 0 } : {}),
          allowedModels: allModels ? [] : Array.from(selectedModels),
          maxActiveKeys: Number(maxActiveKeys),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(apiErrorMessage(t, data.error?.code, data.error?.message));
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`${t("admin.users.allocation.editTitle")} · ${user.username}`}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {/* ---- Credit pool ---- */}
        <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            {t("admin.users.allocation.pool")}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">
                {t("admin.users.allocation.quotaType")}
              </label>
              <select
                value={quotaType}
                onChange={(e) => setQuotaType(e.target.value as "credits" | "tokens")}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="credits">{t("admin.keys.create.quotaType.credits")}</option>
                <option value="tokens">{t("admin.keys.create.quotaType.tokens")}</option>
              </select>
            </div>

            <Input
              label={t("admin.users.allocation.quotaLimit")}
              type="number"
              min="0"
              required
              value={quotaLimit}
              onChange={(e) => setQuotaLimit(e.target.value)}
              hint={t("admin.users.allocation.poolHint")}
            />
          </div>

          {/* Quick top-up: "give them more" is the common action, and it
              shouldn't require recomputing and retyping the total. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("admin.users.allocation.quickTopUp")}
            </span>
            {[100, 500, 1000].map((n) => (
              <Button
                key={n}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setQuotaLimit(String((Number(quotaLimit) || 0) + n))}
              >
                +{n}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
            <span className="text-muted-foreground">
              {t("admin.users.allocation.consumedSoFar", { used: usedLabel })}
            </span>
            <label className="flex items-center gap-2 text-foreground">
              <input
                type="checkbox"
                checked={resetUsage}
                onChange={(e) => setResetUsage(e.target.checked)}
                className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
              />
              {t("admin.users.allocation.resetUsage")}
            </label>
          </div>
        </section>

        {/* ---- Model access ---- */}
        <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              {t("admin.users.allocation.modelsTitle")}
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={allModels}
                onChange={(e) => setAllModels(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-input text-primary focus:ring-ring"
              />
              {t("admin.users.allocation.allModelsToggle")}
            </label>
          </div>

          {allModels ? (
            <p className="text-xs text-muted-foreground">
              {t("admin.users.allocation.allModelsHint")}
            </p>
          ) : availableModels.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("admin.users.allocation.noModelsConfigured")}
            </p>
          ) : (
            <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {availableModels.map((m) => (
                <label
                  key={m}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={selectedModels.has(m)}
                    onChange={() => toggleModel(m)}
                    className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
                  />
                  <code className="truncate font-mono text-xs">{m}</code>
                </label>
              ))}
            </div>
          )}

          {selectionEmpty && (
            <p className="text-xs text-destructive">
              {t("admin.users.allocation.modelSelectionEmpty")}
            </p>
          )}
        </section>

        {/* ---- Key cap ---- */}
        <Input
          label={t("admin.users.allocation.maxActiveKeysLabel")}
          type="number"
          min="0"
          required
          value={maxActiveKeys}
          onChange={(e) => setMaxActiveKeys(e.target.value)}
          hint={t("admin.users.allocation.maxActiveKeysHint")}
        />

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={selectionEmpty}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
