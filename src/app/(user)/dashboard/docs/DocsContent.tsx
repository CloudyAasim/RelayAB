"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import {
  Link2,
  Server,
  Code2,
  Terminal,
  Copy,
  Check,
  Sparkles,
} from "lucide-react";

interface Props {
  baseUrl: string;
  openaiBase: string;
  anthropicBase: string;
  responsesBase: string;
}

export function DocsContent({ baseUrl, openaiBase, anthropicBase, responsesBase }: Props) {
  const t = useT();

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header card */}
      <Card className="bg-gradient-to-br from-primary/5 via-background to-info/5 border-primary/20">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:h-10 sm:w-10">
            <Sparkles className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground sm:text-base">{t("docs.title")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">{t("docs.intro")}</p>
          </div>
        </div>
      </Card>

      {/* Basics */}
      <Card>
        <CardHeader
          title={t("docs.basics.title")}
          description={t("docs.basics.desc")}
        />
        <div className="space-y-2 text-xs text-foreground/90 sm:text-sm sm:space-y-3">
          <p>{t("docs.basics.line1")}</p>
          <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>{t("docs.basics.line2")}</li>
            <li>{t("docs.basics.line3")}</li>
            <li>{t("docs.basics.line4")}</li>
          </ol>
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground dark:text-warning">
            {t("docs.basics.warning")}
          </div>
        </div>
      </Card>

      {/* URLs */}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              {t("docs.url.title")}
            </span>
          }
          description={t("docs.url.desc")}
        />
        <div className="space-y-1 divide-y divide-border">
          <UrlRow label={t("docs.url.public")} value={baseUrl} />
          <UrlRow label={t("docs.url.openaiBase")} value={openaiBase} />
          <UrlRow label={t("docs.url.anthropicBase")} value={anthropicBase} />
        </div>
      </Card>

      {/* OpenAI API */}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              {t("docs.openai.title")}
            </span>
          }
          description={t("docs.openai.desc")}
        />
        <div className="space-y-3 text-xs text-foreground/90 sm:text-sm sm:space-y-4">
          <p>{t("docs.openai.line1")}</p>
          <CodeBlock label={t("docs.openai.baseUrl")} value={openaiBase} />
          <CodeBlock label={t("docs.openai.header")} value="Authorization: Bearer sk-relay-xxxx..." />
          <CodeBlock
            label={t("docs.openai.example")}
            value={`curl ${openaiBase}/chat/completions \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "YOUR_MODEL_ID","messages": [{"role": "user", "content": "Hello!"}]}'`}
          />
          <p className="text-xs text-muted-foreground">
            {t("docs.openai.modelListHint", { baseUrl: openaiBase })}
          </p>
        </div>
      </Card>

      {/* Anthropic API */}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-muted-foreground" />
              {t("docs.anthropic.title")}
            </span>
          }
          description={t("docs.anthropic.desc")}
        />
        <div className="space-y-3 text-xs text-foreground/90 sm:text-sm sm:space-y-4">
          <p>{t("docs.anthropic.line1")}</p>
          <p className="text-xs text-muted-foreground">{t("docs.anthropic.baseUrl.official")}</p>
          <p className="text-xs text-muted-foreground">{t("docs.anthropic.baseUrl.aiSdk")}</p>
          <CodeBlock label={t("docs.anthropic.baseUrl")} value={anthropicBase} />
          <CodeBlock label={t("docs.anthropic.header")} value="x-api-key: sk-relay-xxxx..." />
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("docs.anthropic.baseUrl.tip")}</p>
          <CodeBlock
            label={t("docs.anthropic.example")}
            value={`curl ${anthropicBase}/v1/messages \\
  -H "x-api-key: $RELAYAB_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "YOUR_MODEL_ID","max_tokens": 1024,"messages": [{"role": "user", "content": "Hello!"}]}'`}
          />
          <p className="text-xs text-muted-foreground">{t("docs.anthropic.sdkHint")}</p>
          <CodeBlock
            label={t("docs.anthropic.sdk")}
            value={`import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: process.env.RELAYAB_KEY, baseURL: "${anthropicBase}" });
const msg = await client.messages.create({ model: "YOUR_MODEL_ID", max_tokens: 1024, messages: [{ role: "user", content: "Hello!" }] });
console.log(msg.content);`}
          />
        </div>
      </Card>

      {/* Models */}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              {t("docs.models.title")}
            </span>
          }
          description={t("docs.models.desc")}
        />
        <div className="space-y-2 text-xs text-foreground/90 sm:text-sm sm:space-y-3">
          <p>{t("docs.models.line1")}</p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li>{t("docs.models.line2")}</li>
            <li>{t("docs.models.line3")}</li>
          </ul>
          <CodeBlock
            label={t("docs.cli.example")}
            value={`curl -H "Authorization: Bearer $RELAYAB_KEY" ${openaiBase}/models`}
          />
        </div>
      </Card>

      {/* Responses API */}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {t("docs.responses.title")}
            </span>
          }
          description={t("docs.responses.desc")}
        />
        <div className="space-y-3 text-xs text-foreground/90 sm:text-sm sm:space-y-4">
          <p>{t("docs.responses.line1")}</p>
          <CodeBlock label={t("docs.responses.baseUrl")} value={responsesBase} />
          <CodeBlock label={t("docs.responses.header")} value="Authorization: Bearer sk-relay-xxxx..." />
          <CodeBlock
            label={t("docs.responses.example")}
            value={`curl ${responsesBase}/responses \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "YOUR_MODEL_ID","input": "Hello!"}'`}
          />
        </div>
      </Card>

      {/* Code examples - responsive grid */}
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("docs.python.title")} description={t("docs.python.desc")} />
          <CodeBlock
            label={t("docs.python.openai")}
            value={`from openai import OpenAI
client = OpenAI(api_key="sk-relay-xxxx...", base_url="${openaiBase}")
resp = client.chat.completions.create(model="YOUR_MODEL_ID", messages=[{"role": "user", "content": "Hello!"}])
print(resp.choices[0].message.content)`}
          />
        </Card>
        <Card>
          <CardHeader title={t("docs.node.title")} description={t("docs.node.desc")} />
          <CodeBlock
            label={t("docs.node.openai")}
            value={`import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.RELAYAB_KEY, baseURL: "${openaiBase}" });
const resp = await client.chat.completions.create({ model: "YOUR_MODEL_ID", messages: [{ role: "user", content: "Hello!" }] });
console.log(resp.choices[0].message.content);`}
          />
        </Card>
      </div>

      <p className="py-4 text-center text-xs text-muted-foreground">
        {t("docs.help.contactAdmin")}
      </p>
    </div>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 px-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground sm:text-xs">{label}</div>
        <div className="mt-0.5 break-all font-mono text-xs text-foreground select-all sm:text-sm">{value}</div>
      </div>
      <CopyButton value={value} />
    </div>
  );
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <CopyButton value={value} small />
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-foreground/[0.03] px-2.5 py-2 text-[10px] font-mono leading-relaxed text-foreground sm:px-3 sm:py-2.5 sm:text-xs">
        {value}
      </pre>
    </div>
  );
}

function CopyButton({ value, small }: { value: string; small?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={small ? "sm" : "md"}
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
          <Check className="mr-1 h-3 w-3 sm:h-3.5 sm:w-3.5" />
          {t("docs.copy.copied")}
        </>
      ) : (
        <>
          <Copy className="mr-1 h-3 w-3 sm:h-3.5 sm:w-3.5" />
          {t("common.copy")}
        </>
      )}
    </Button>
  );
}
