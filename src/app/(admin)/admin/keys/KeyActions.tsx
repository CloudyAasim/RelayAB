"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import type { ApiKey } from "@/lib/db/types";

export function KeyActions({ apiKey }: { apiKey: ApiKey }) {
  const t = useT();
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.id}/toggle`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) alert(data.error?.message ?? t("admin.keys.action.failed"));
      else window.location.reload();
    } catch {
      alert(t("admin.keys.action.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button size="sm" variant="ghost" onClick={toggle} disabled={loading}>
      {apiKey.enabled ? t("admin.keys.action.disable") : t("admin.keys.action.enable")}
    </Button>
  );
}
