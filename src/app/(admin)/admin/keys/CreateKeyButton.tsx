"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { creditsToUnits } from "@/lib/quota/credits";

interface User {
  id: string;
  username: string;
  displayName: string;
}

export function CreateKeyButton({ users }: { users: User[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [label, setLabel] = useState("");
  const [quotaType, setQuotaType] = useState<"credits" | "tokens">("credits");
  // Entered as 积分; converted to the integer storage units on submit.
  const [quotaLimitCredits, setQuotaLimitCredits] = useState(500);
  const [quotaLimitTokens, setQuotaLimitTokens] = useState(100_000);
  const [expiresAt, setExpiresAt] = useState("");
  const [allowedModels, setAllowedModels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [plainKey, setPlainKey] = useState<string | null>(null);

  function reset() {
    setUserId("");
    setLabel("");
    setQuotaType("credits");
    setQuotaLimitCredits(500);
    setQuotaLimitTokens(100_000);
    setExpiresAt("");
    setAllowedModels("");
    setError(null);
    setPlainKey(null);
  }

  async function onSubmit() {
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        userId,
        label,
        quotaType,
        quotaLimit:
          quotaType === "credits" ? creditsToUnits(quotaLimitCredits) : quotaLimitTokens,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        allowedModels: allowedModels
          ? allowedModels.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      };
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? "Failed");
        return;
      }
      setPlainKey(data.data?.plainKey ?? null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Create Key</Button>
      <Modal
        open={open}
        onClose={() => { setOpen(false); reset(); }}
        title={plainKey ? "Key Created" : "Create API Key"}
        description={
          plainKey
            ? "Copy the key below — it will not be shown again."
            : "Issue a new key for one of your users."
        }
        footer={
          plainKey ? (
            <Button onClick={() => { setOpen(false); reset(); }}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>Cancel</Button>
              <Button onClick={onSubmit} loading={loading} disabled={!userId || !label}>Create</Button>
            </>
          )
        }
      >
        {plainKey ? (
          <pre className="rounded-md bg-slate-900 px-4 py-3 text-sm font-mono text-green-400 overflow-x-auto">
            {plainKey}
          </pre>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">User</label>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">Select user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username} ({u.displayName})
                  </option>
                ))}
              </select>
            </div>
            <Input label="Label" required value={label} onChange={(e) => setLabel(e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-slate-700">Quota Type</label>
                <select
                  value={quotaType}
                  onChange={(e) => setQuotaType(e.target.value as "credits" | "tokens")}
                  className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="credits">积分</option>
                  <option value="tokens">Tokens</option>
                </select>
              </div>
              {quotaType === "credits" ? (
                <Input
                  label="Limit (积分)"
                  type="number"
                  min="0"
                  step="1"
                  value={quotaLimitCredits}
                  onChange={(e) => setQuotaLimitCredits(Number(e.target.value))}
                  hint="Usage is tracked down to 0.001 积分."
                />
              ) : (
                <Input
                  label="Limit (tokens)"
                  type="number"
                  min="0"
                  value={quotaLimitTokens}
                  onChange={(e) => setQuotaLimitTokens(Number(e.target.value))}
                />
              )}
            </div>
            <Input
              label="Expires At"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              hint="Leave blank for no expiration."
            />
            <Input
              label="Allowed Models"
              value={allowedModels}
              onChange={(e) => setAllowedModels(e.target.value)}
              hint="Comma-separated. Empty = all models allowed."
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </Modal>
    </>
  );
}
