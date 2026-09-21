"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";

export function CreateUserButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [password, setPassword] = useState("");
  const [autoPassword, setAutoPassword] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  function reset() {
    setUsername("");
    setDisplayName("");
    setRole("user");
    setPassword("");
    setAutoPassword(true);
    setError(null);
    setGenerated(null);
  }

  async function onSubmit() {
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, string> = { username, role, displayName: displayName || username };
      if (!autoPassword) body.password = password;
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? "Failed");
        return;
      }
      setGenerated(data.data?.generatedPassword ?? null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Create User</Button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={generated ? "User Created" : "Create New User"}
        description={
          generated
            ? "Save the password below — it will not be shown again."
            : "An initial password is auto-generated unless you provide one."
        }
        footer={
          generated ? (
            <Button onClick={() => { setOpen(false); reset(); }}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>Cancel</Button>
              <Button onClick={onSubmit} loading={loading} disabled={!username}>Create</Button>
            </>
          )
        }
      >
        {generated ? (
          <div>
            <p className="text-sm text-slate-600 mb-2">Generated password:</p>
            <pre className="rounded-md bg-slate-900 px-4 py-3 text-sm font-mono text-green-400 overflow-x-auto">
              {generated}
            </pre>
          </div>
        ) : (
          <div className="space-y-3">
            <Input label="Username" required value={username} onChange={(e) => setUsername(e.target.value)} />
            <Input label="Display Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "user" | "admin")}
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoPassword}
                onChange={(e) => setAutoPassword(e.target.checked)}
              />
              Auto-generate initial password
            </label>
            {!autoPassword && (
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </Modal>
    </>
  );
}
