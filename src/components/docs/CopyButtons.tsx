"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Check, Copy } from "lucide-react";

/**
 * One-click copy, with the format as an explicit choice.
 *
 * Operators copy these blocks straight into an AI assistant to have it write or
 * fix a spec, so both the raw Markdown (to keep code blocks exact) and a plain
 * text rendering (for chats that mangle Markdown) have to be one click away.
 */
export function CopyButtons({
  options,
  copiedLabel,
  failLabel,
  size = "sm",
}: {
  options: Array<{ key: string; label: string; value: string }>;
  copiedLabel: string;
  failLabel: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function run(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // eslint-disable-next-line no-alert
      alert(failLabel);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <Button
          key={option.key}
          type="button"
          size={size}
          variant="secondary"
          onClick={() => run(option.key, option.value)}
        >
          {copied === option.key ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" />
              {copiedLabel}
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3.5 w-3.5" />
              {option.label}
            </>
          )}
        </Button>
      ))}
    </div>
  );
}
