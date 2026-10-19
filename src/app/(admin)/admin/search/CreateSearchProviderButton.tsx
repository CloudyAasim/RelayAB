"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { useT } from "@/components/i18n/I18nProvider";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { SearchProviderForm, type SearchTemplateOption } from "./SearchProviderForm";

export function CreateSearchProviderButton({ templates }: { templates?: SearchTemplateOption[] }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {t("admin.searchProviders.new")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("admin.searchProviders.new")}
        description={t("admin.searchProviders.formDesc")}
        wide
      >
        <SearchProviderForm
          templates={templates}
          onSaved={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}
