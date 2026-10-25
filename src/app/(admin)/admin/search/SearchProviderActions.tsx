"use client";

import { useState, useTransition } from "react";
import { Pencil, Power, PowerOff, Search, Star, Trash2 } from "lucide-react";

import { useT } from "@/components/i18n/I18nProvider";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { SearchProviderForm, type SearchProviderRow, type SearchTemplateOption } from "./SearchProviderForm";
import { SearchProviderTestModal } from "./SearchProviderTestModal";

export function SearchProviderActions({
  provider,
  templates,
  isDefault = false,
}: {
  provider: SearchProviderRow;
  templates?: SearchTemplateOption[];
  /** Whether this row is the one that answers when a caller names none. */
  isDefault?: boolean;
}) {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  /**
   * Mark this row as the default, or unmark it.
   *
   * The default is what answers when a client names no service — which is every
   * client that speaks the other search APIs, because none of them has a field
   * for it. So the mark is not a preference, it is the answer to "which one
   * runs when nobody says".
   */
  async function markDefault(): Promise<void> {
    const res = await fetch("/api/admin/search", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultServiceId: isDefault ? null : provider.serviceId }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: { message?: string } }
      | null;
    if (!data?.ok) {
      alert(data?.error?.message ?? t("common.failed"));
      return;
    }
    startTransition(() => window.location.reload());
  }

  async function toggle(): Promise<void> {
    const res = await fetch(`/api/admin/search-providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !provider.enabled }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: { message?: string } }
      | null;
    if (!data?.ok) {
      alert(data?.error?.message ?? t("common.failed"));
      return;
    }
    startTransition(() => window.location.reload());
  }

  async function remove(): Promise<void> {
    if (!confirm(t("admin.searchProviders.confirmDelete", { name: provider.name }))) return;
    const res = await fetch(`/api/admin/search-providers/${provider.id}`, { method: "DELETE" });
    const data = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: { message?: string } }
      | null;
    if (!data?.ok) {
      alert(data?.error?.message ?? t("common.failed"));
      return;
    }
    startTransition(() => window.location.reload());
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="icon"
        variant="ghost"
        title={t("admin.searchProviders.test")}
        onClick={() => setTestOpen(true)}
        disabled={pending}
      >
        <Search className="h-4 w-4" />
      </Button>
      {/*
        Two different icons for the same button, because one icon for two
        opposite actions is a button nobody can read: the icon shows the
        **action**, and the title spells it out. A row that is on offers "turn
        it off" (a plug being pulled); a row that is off offers "turn it on".
      */}
      <Button
        size="icon"
        variant="ghost"
        title={provider.enabled ? t("admin.searchProviders.disable") : t("admin.searchProviders.enable")}
        aria-label={provider.enabled ? t("admin.searchProviders.disable") : t("admin.searchProviders.enable")}
        onClick={toggle}
        disabled={pending}
        className={provider.enabled ? "text-muted-foreground hover:text-destructive" : "text-foreground"}
      >
        {provider.enabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        title={
          isDefault
            ? t("admin.searchProviders.unsetDefault")
            : t("admin.searchProviders.setDefault")
        }
        aria-label={
          isDefault
            ? t("admin.searchProviders.unsetDefault")
            : t("admin.searchProviders.setDefault")
        }
        onClick={markDefault}
        disabled={pending}
        className={isDefault ? "text-primary" : "text-muted-foreground"}
      >
        <Star className="h-4 w-4" fill={isDefault ? "currentColor" : "none"} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        title={t("common.edit")}
        onClick={() => setEditOpen(true)}
        disabled={pending}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        title={t("common.delete")}
        onClick={remove}
        disabled={pending}
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t("admin.searchProviders.editTitle", { name: provider.name })}
        wide
      >
        <SearchProviderForm
          provider={provider}
          templates={templates}
          onSaved={() => {
            setEditOpen(false);
          }}
        />
      </Modal>

      <SearchProviderTestModal
        providerId={provider.id}
        providerName={provider.name}
        open={testOpen}
        onClose={() => setTestOpen(false)}
      />
    </div>
  );
}
