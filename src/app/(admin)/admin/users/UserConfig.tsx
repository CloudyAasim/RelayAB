"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { AllowedModelsSummary, groupLabel } from "@/components/models/AllowedModelsSummary";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { formatCredits, formatCreditsFloor, formatCreditsCeil, formatNumber } from "@/lib/utils";
import { CREDIT_SCALE } from "@/lib/quota/credits";
import { formatUserIdentity } from "@/lib/user-identity";
import type { ModelGroup } from "@/lib/admin/model-groups";
import type { PublicUser } from "@/lib/db/types";
import { Settings2, ListChecks, Pencil, Wallet } from "lucide-react";

/**
 * Format an amount in the unit the account is denominated in.
 * Locale-neutral on purpose — the surrounding template supplies the wording.
 */
function amount(type: PublicUser["quotaType"], n: number): string {
  return type === "tokens" ? formatNumber(n) : formatCredits(n);
}

/**
 * Floor version for remaining/balance display.
 * Uses floor — shows conservative estimate to avoid decimal/comma confusion.
 */
function amountFloor(type: PublicUser["quotaType"], n: number): string {
  return type === "tokens" ? formatNumber(n) : formatCreditsFloor(n);
}

/**
 * Ceiling version for consumed/used display.
 * Uses ceiling — shows worst-case, not less than actual.
 */
function amountCeil(type: PublicUser["quotaType"], n: number): string {
  return type === "tokens" ? formatNumber(n) : formatCreditsCeil(n);
}


/**
 * The account's quota pool, on one line.
 *
 * Identity used to live in the users table and the quota in a card grid below
 * it, so one account's settings were two modals on two halves of a page. The
 * pool and its consumption are now columns of that same row.
 */
export function UserPoolSummary({ user }: { user: PublicUser }) {
  const t = useT();

  if (user.quotaLimit === 0) {
    return <span className="text-muted-foreground">{t("admin.users.allocation.noPool")}</span>;
  }

  return (
    <div className="space-y-1">
      <div className="whitespace-nowrap">
        {t("admin.users.allocation.poolValue", {
          amount: amount(user.quotaType, user.quotaLimit),
          unit: user.quotaType === "tokens" ? "tokens" : t("admin.keys.create.quotaType.credits"),
        })}
      </div>
      <div className="whitespace-nowrap text-xs text-muted-foreground">
        {t("admin.users.allocation.poolUsedValue", {
          used: amountCeil(user.quotaType, user.quotaUsed),
          total: amountFloor(user.quotaType, user.quotaLimit),
          remaining: amountFloor(user.quotaType, Math.max(0, user.quotaLimit - user.quotaUsed)),
        })}
      </div>
    </div>
  );
}

/** The row's 「配置」 button: identity, pool, models and key cap in one modal. */
export function UserConfigButton({ user, modelGroups }: { user: PublicUser; modelGroups: ModelGroup[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Settings2 className="mr-1 h-3.5 w-3.5" />
        {t("admin.users.config.open")}
      </Button>
      {open && (
        <UserConfigModal
          user={user}
          modelGroups={modelGroups}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            window.location.reload();
          }}
        />
      )}
    </>
  );
}

function UserConfigModal({
  user,
  modelGroups,
  onClose,
  onSaved,
}: {
  user: PublicUser;
  modelGroups: ModelGroup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [displayName, setDisplayName] = useState(user.displayName);
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

  /** Select or clear every model in one group. */
  function toggleGroup(models: string[], selected: boolean) {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const model of models) {
        if (selected) next.add(model);
        else next.delete(model);
      }
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError(t("settings.displayName.errorEmpty"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: trimmedName,
          quotaType,
          // The box holds the number in the unit currently selected above it,
          // so the conversion has to follow that unit — not the stored one.
          quotaLimit: quotaType === "credits"
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
      title={`${t("admin.users.config.title")} · ${formatUserIdentity(user.username, user.displayName)}`}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {/* ---- Identity ---- */}
        <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Pencil className="h-4 w-4 text-muted-foreground" />
            {t("admin.users.config.identity")}
          </div>
          <Input
            label={t("settings.displayName.label")}
            hint={t("settings.displayName.usernameHint", { username: user.username })}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setError(null);
            }}
            maxLength={64}
          />
        </section>

        {/* ---- Credit pool ---- */}
        <section className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            {t("admin.users.allocation.quota")}
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

          {allModels ? null : modelGroups.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("admin.users.allocation.noModelsConfigured")}
            </p>
          ) : (
            /*
             * One section per kind.
             *
             * The list used to be one flat alphabet, which made "give this
             * account the image models" a reading exercise. Each group now
             * carries its own heading and its own "select all" — the gesture
             * people actually want is "the text ones" or "the image ones", not
             * "these nine names".
             */
            <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
              {modelGroups.map((group) => {
                const selectedCount = group.models.filter((m) => selectedModels.has(m)).length;
                const allSelected = selectedCount === group.models.length;
                return (
                  <section key={group.kind} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {groupLabel(t, group.kind)}
                        <span className="ml-1.5 font-normal text-muted-foreground/70">
                          {selectedCount}/{group.models.length}
                        </span>
                      </h4>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() => toggleGroup(group.models, !allSelected)}
                          className="h-3.5 w-3.5 rounded border-input text-primary focus:ring-ring"
                        />
                        {t("admin.users.allocation.groupSelectAll")}
                      </label>
                    </div>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {group.models.map((m) => (
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
                  </section>
                );
              })}
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