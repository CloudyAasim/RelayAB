"use client";

import { useState } from "react";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";

interface UserOpt { id: string; username: string; }

export function CreateKeyButton({ users }: { users: UserOpt[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [allowedModels, setAllowedModels] = useState("");
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setLabel(""); setExpiresAt(""); setAllowedModels("");
    setPlainKey(null); setError(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          label,
          expiresAt: expiresAt || null,
          allowedModels: allowedModels
            ? allowedModels.split(",").map(s => s.trim()).filter(Boolean)
            : undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
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
      <Button onClick={() => { reset(); setOpen(true); }}>{t("admin.keys.create")}</Button>
      <Modal open={open} onClose={() => { setOpen(false); reset(); }}
             title={plainKey ? t("admin.keys.created") : t("admin.keys.create")}>
        {plainKey ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">{t("admin.keys.createdNotice")}</p>
            <div className="rounded-md bg-slate-100 p-3 font-mono text-xs break-all">{plainKey}</div>
            <div className="flex justify-end">
              <Button onClick={() => { setOpen(false); reset(); window.location.reload(); }}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">
                {t("admin.keys.create.user")}
              </label>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                required
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
            </div>
            <Input
              label={t("admin.keys.create.label")}
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Input
              label={t("admin.keys.create.expiresAt")}
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <Input
              label={t("admin.keys.create.allowedModels")}
              value={allowedModels}
              onChange={(e) => setAllowedModels(e.target.value)}
              hint={t("admin.keys.create.allowedModelsHint")}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => { setOpen(false); reset(); }}>
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
