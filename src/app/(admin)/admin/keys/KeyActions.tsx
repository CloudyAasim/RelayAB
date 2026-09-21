"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function KeyActions({ keyId, enabled }: { keyId: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await fetch(`/api/admin/keys/${keyId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm("Delete this key? This cannot be undone.")) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/keys/${keyId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-1">
      <Button size="sm" variant="ghost" disabled={busy} onClick={toggle}>
        {enabled ? "Disable" : "Enable"}
      </Button>
      <Button size="sm" variant="danger" disabled={busy} onClick={del}>
        Delete
      </Button>
    </div>
  );
}
