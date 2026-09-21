"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input, Textarea } from "@/components/ui/Input";

export function CreateProviderButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"openai" | "anthropic" | "custom-openai">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelMapping, setModelMapping] = useState("{\n  \"gpt-4o-mini\": \"gpt-4o-mini-2024-07-18\"\n}");
  const [priority, setPriority] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset() {
    setName("");
    setKind("openai");
    setBaseUrl("");
    setApiKey("");
    setModelMapping("{\n  \"gpt-4o-mini\": \"gpt-4o-mini-2024-07-18\"\n}");
    setPriority(1);
    setError(null);
  }

  async function onSubmit() {
    setError(null);
    let mapping: Record<string, string>;
    try {
      mapping = JSON.parse(modelMapping);
    } catch {
      setError("modelMapping must be valid JSON");
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        name,
        kind,
        baseUrl: baseUrl || null,
        apiKey,
        modelMapping: mapping,
        priority,
      };
      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? "Failed");
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Add Provider</Button>
      <Modal
        open={open}
        onClose={() => { setOpen(false); reset(); }}
        title="Add Upstream Provider"
        description="The API key is encrypted with AES-256-GCM before being stored."
        footer={
          <>
            <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>Cancel</Button>
            <Button onClick={onSubmit} loading={loading} disabled={!name || !apiKey}>Add</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">Kind</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="openai">openai (default endpoint)</option>
              <option value="anthropic">anthropic (default endpoint)</option>
              <option value="custom-openai">custom-openai (bring your own URL)</option>
            </select>
          </div>
          {(kind === "custom-openai" || kind === "anthropic") && (
            <Input
              label="Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          )}
          <Input
            label="API Key"
            type="password"
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Textarea
            label="Model Mapping (JSON)"
            value={modelMapping}
            onChange={(e) => setModelMapping(e.target.value)}
            hint="Map client-visible model names to upstream names."
          />
          <Input
            label="Priority"
            type="number"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            hint="Lower = tried first."
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
