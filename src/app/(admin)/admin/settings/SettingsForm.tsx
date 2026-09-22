"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n/I18nProvider";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

interface Props {
  currentUrl: string;
  envConfigured: boolean;
}

export function SettingsForm({ currentUrl, envConfigured }: Props) {
  const t = useT();
  const router = useRouter();
  const [url, setUrl] = useState(currentUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicUrl: url || undefined }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setError(t("common.networkError") + " (invalid response)");
        setLoading(false);
        return;
      }

      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
        setLoading(false);
        return;
      }

      setSuccess(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {envConfigured && (
        <div className="bg-muted/50 rounded-md p-3 text-sm">
          <p className="text-muted-foreground">
            {t("admin.settings.envConfigured")}: <code className="bg-muted px-1 rounded">{currentUrl}</code>
          </p>
          <p className="text-muted-foreground mt-1">
            {t("admin.settings.envOverride")}
          </p>
        </div>
      )}
      
      <Input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://api.example.com"
      />
      
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">{t("common.success")}</p>}
      
      <Button type="submit" loading={loading}>
        {t("common.save")}
      </Button>
    </form>
  );
}
