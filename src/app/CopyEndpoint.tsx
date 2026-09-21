"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { Check, Copy } from "lucide-react";

/**
 * The endpoint block on the welcome page.
 *
 * Someone arriving at this URL usually has one question — "what do I paste
 * into my client?" — so the answer sits on the landing page with a copy
 * button rather than being buried behind a login.
 */
export function CopyEndpoint({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              alert(t("docs.copy.failed"));
            }
          }}
        >
          {copied ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" />
              {t("docs.copy.copied")}
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3.5 w-3.5" />
              {t("common.copy")}
            </>
          )}
        </Button>
      </div>
      <code className="mt-2 block select-all break-all font-mono text-sm text-foreground">
        {value}
      </code>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
