"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n/I18nProvider";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

interface Props {
  currentUrl: string;
  envConfigured: boolean;
  /**
   * How many providers one request may be tried against.
   *
   * Kept in step with the stored setting so the field shows what is in force
   * rather than what the code would default to.
   */
  maxProviderAttempts: number;
}

export function SettingsForm({ currentUrl, envConfigured, maxProviderAttempts }: Props) {
  const t = useT();
  const router = useRouter();
  const [url, setUrl] = useState(currentUrl);
  const [attempts, setAttempts] = useState(String(maxProviderAttempts));
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
        body: JSON.stringify({
          publicUrl: url || undefined,
          maxProviderAttempts: Math.max(1, Number(attempts) || 1),
        }),
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

      {/* How many providers a request may be tried against. The number is
          capped by how many providers serve the model, so a deployment with
          one provider per model is unaffected by it. */}
      <Input
        label={t("admin.settings.maxProviderAttempts")}
        type="number"
        min="1"
        max="10"
        value={attempts}
        onChange={(e) => setAttempts(e.target.value)}
        hint={t("admin.settings.maxProviderAttemptsHint")}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">{t("common.success")}</p>}
      
      <Button type="submit" loading={loading}>
        {t("common.save")}
      </Button>
    </form>
  );
}
