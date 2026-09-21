"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface UserActionsProps {
  userId: string;
  isSelf: boolean;
  disabled: boolean;
}

export function UserActions({ userId, isSelf, disabled }: UserActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [newPassword, setNewPassword] = useState<string | null>(null);

  async function resetPassword() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-password`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error?.message ?? "Failed");
        return;
      }
      setNewPassword(data.data?.generatedPassword ?? null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleDisabled() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !disabled }),
      });
      if (!(await res.json()).ok) {
        alert("Failed");
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser() {
    if (!confirm("Delete this user and all their keys? This cannot be undone.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error?.message ?? "Failed");
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
        Reset PW
      </Button>
      {!isSelf && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={toggleDisabled}>
          {disabled ? "Enable" : "Disable"}
        </Button>
      )}
      {!isSelf && (
        <Button size="sm" variant="danger" disabled={busy} onClick={deleteUser}>
          Delete
        </Button>
      )}
      <Modal
        open={confirmReset}
        onClose={() => {
          setConfirmReset(false);
          setNewPassword(null);
        }}
        title={newPassword ? "Password Reset" : "Reset Password"}
        description={
          newPassword ? "Save the new password — it won't be shown again." : "Generate a new random password for this user."
        }
        footer={
          newPassword ? (
            <Button onClick={() => { setConfirmReset(false); setNewPassword(null); }}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
              <Button onClick={resetPassword} loading={busy}>Generate</Button>
            </>
          )
        }
      >
        {newPassword ? (
          <pre className="rounded-md bg-slate-900 px-4 py-3 text-sm font-mono text-green-400 overflow-x-auto">
            {newPassword}
          </pre>
        ) : (
          <p className="text-sm text-slate-600">
            The user's existing password will be invalidated immediately.
          </p>
        )}
      </Modal>
    </div>
  );
}
