"use client";

import { useState, useTransition } from "react";
import { Pencil, Power, Search, Trash2 } from "lucide-react";

import { useT } from "@/components/i18n/I18nProvider";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { SearchProviderForm, type SearchProviderRow, type SearchTemplateOption } from "./SearchProviderForm";
import { SearchProviderTestModal } from "./SearchProviderTestModal";

export function SearchProviderActions({
  provider,
  templates,
}: {
  provider: SearchProviderRow;
  templates?: SearchTemplateOption[];
}) {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [pending, startTransition] = useTransition();

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
        title={provider.enabled ? t("admin.searchProviders.disable") : t("admin.searchProviders.enable")}
        onClick={toggle}
        disabled={pending}
      >
        <Power className="h-4 w-4" />
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
