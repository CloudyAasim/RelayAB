"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { Plus } from "lucide-react";
import { AnnouncementForm } from "./AnnouncementForm";

/** "发布公告" — opens the same editor the row actions use. */
export function CreateAnnouncementButton() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t("admin.announcements.new")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("admin.announcements.new")}
        wide
      >
        <AnnouncementForm
          onSaved={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}