"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";

export function CreateUserButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName, password, role }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
        return;
      }
      setOpen(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("admin.users.create")}</Button>
      <Modal open={open} onClose={() => setOpen(false)}
             title={t("admin.users.create")}
             description={t("admin.users.create.username")}>
        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            label={t("admin.users.create.username")}
            required value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Input
            label={t("admin.users.create.displayName")}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Input
            label={t("admin.users.create.password")}
            type="password" required value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div>
            <label className="block text-sm font-medium text-slate-700">
              {t("admin.users.create.role")}
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="user">{t("admin.users.role.user")}</option>
              <option value="admin">{t("admin.users.role.admin")}</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={loading}>
              {t("admin.users.create.submit")}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
