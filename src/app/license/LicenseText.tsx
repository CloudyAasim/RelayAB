"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { Check, Copy } from "lucide-react";

/**
 * Copy-to-clipboard button for the MIT license text.
 *
 * Client-side because `navigator.clipboard` is browser-only; the license
 * body itself is rendered by the server component next to it.
 */
export function LicenseText({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
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
          {t("license.copied")}
        </>
      ) : (
        <>
          <Copy className="mr-1 h-3.5 w-3.5" />
          {t("license.copy")}
        </>
      )}
    </Button>
  );
}
