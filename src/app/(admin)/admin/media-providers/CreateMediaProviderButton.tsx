"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { Plus } from "lucide-react";
import { MediaProviderForm, type MediaTemplate } from "./MediaProviderForm";

/** "新增媒体供应商" — opens the same editor used by the row actions. */
export function CreateMediaProviderButton({ templates }: { templates: MediaTemplate[] }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t("admin.mediaProviders.new")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("admin.mediaProviders.new")}
        wide
      >
        <MediaProviderForm
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
