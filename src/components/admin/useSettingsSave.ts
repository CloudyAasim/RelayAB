"use client";

/**
 * src/components/admin/useSettingsSave.ts
 *
 * Saving one slice of the settings, from one form.
 *
 * These used to be one component with one button over three unrelated groups of
 * fields, which meant saving the site name also rewrote the custom pages and
 * the model notes from whatever the form happened to be holding. The endpoint
 * only writes the keys present in the body, so the fix is not in the API — it is
 * in each form sending only its own fields, which is what this makes obvious
 * and what the tests pin.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n/I18nProvider";

export interface SettingsSaveMessage {
  ok: boolean;
  text: string;
}

export function useSettingsSave() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SettingsSaveMessage | null>(null);

  /**
   * `payload` is the whole request body, and it must carry only this form's
   * fields. Anything omitted is left exactly as it is on the server.
   */
  async function save(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (json?.ok) {
        setMessage({ ok: true, text: t("common.success") });
        router.refresh();
        return true;
      }
      setMessage({ ok: false, text: json?.error?.message ?? `HTTP ${res.status}` });
      return false;
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { save, busy, message };
}
