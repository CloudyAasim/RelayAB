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
    <div className="space-y-6">
      <Card className="bg-gradient-to-br from-primary/5 via-background to-info/5 border-primary/20">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">{t("docs.title")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("docs.intro")}</p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("docs.basics.title")}
          description={t("docs.basics.desc")}
        />
        <div className="space-y-3 text-sm text-foreground/90">
          <p>{t("docs.basics.line1")}</p>
          <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>{t("docs.basics.line2")}</li>
            <li>{t("docs.basics.line3")}</li>
            <li>{t("docs.basics.line4")}</li>
          </ol>
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning-foreground dark:text-warning text-xs">
            {t("docs.basics.warning")}
          </div>
        </div>
      </Card>

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
        <div className="space-y-1 divide-y divide-border -mx-2">
          <UrlRow label={t("docs.url.public")} value={baseUrl} />
          <UrlRow label={t("docs.url.openaiBase")} value={openaiBase} />
          <UrlRow label={t("docs.url.anthropicBase")} value={anthropicBase} />
        </div>
      </Card>

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
        <div className="space-y-4 text-sm text-foreground/90">
          <p>{t("docs.openai.line1")}</p>
          <CodeBlock label={t("docs.openai.baseUrl")} value={openaiBase} />
          <CodeBlock
            label={t("docs.openai.header")}
            value={`Authorization: Bearer sk-relay-xxxx...`}
          />
          <CodeBlock
            label={t("docs.openai.example")}
            value={`curl ${openaiBase}/chat/completions \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
          />
          <p className="text-xs text-muted-foreground">{t("docs.openai.modelListHint")}</p>
        </div>
      </Card>

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
        <div className="space-y-4 text-sm text-foreground/90">
          <p>{t("docs.anthropic.line1")}</p>
          <CodeBlock label={t("docs.anthropic.baseUrl")} value={anthropicBase} />
          <CodeBlock label={t("docs.anthropic.header")} value={`x-api-key: sk-relay-xxxx...`} />
          <CodeBlock
            label={t("docs.anthropic.example")}
            value={`curl ${anthropicBase}/v1/messages \\
  -H "x-api-key: $RELAYAB_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
          />
        </div>
      </Card>

      
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
          <div className="space-y-4 text-sm text-foreground/90">
            <p>{t("docs.responses.line1")}</p>
            <CodeBlock label={t("docs.responses.baseUrl")} value={responsesBase} />
            <CodeBlock
              label={t("docs.responses.header")}
              value={`Authorization: Bearer sk-relay-xxxx...`}
            />
            <CodeBlock
              label={t("docs.responses.example")}
              value={`curl ${responsesBase}/responses \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{\n    "model": "gpt-4o-mini",\n    "input": "Hello!"\n  }'`}
            />
          </div>
        </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("docs.python.title")} description={t("docs.python.desc")} />
          <CodeBlock
            label={t("docs.python.openai")}
            value={`from openai import OpenAI

client = OpenAI(
    api_key="sk-relay-xxxx...",          # your RelayAB key
    base_url="${openaiBase}",             # point at THIS instance
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`}
          />
        </Card>
        <Card>
          <CardHeader title={t("docs.node.title")} description={t("docs.node.desc")} />
          <CodeBlock
            label={t("docs.node.openai")}
            value={`import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.RELAYAB_KEY,        // your RelayAB key
  baseURL: "${openaiBase}",               // point at THIS instance
});

const resp = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);`}
          />
        </Card>
      </div>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              {t("docs.cli.title")}
            </span>
          }
          description={t("docs.cli.desc")}
        />
        <CodeBlock
          label={t("docs.cli.example")}
          value={`# list available models
curl -H "Authorization: Bearer $RELAYAB_KEY" ${openaiBase}/models`}
        />
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        {t("docs.help.contactAdmin")}
      </p>
    </div>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-0.5 font-mono text-sm text-foreground break-all select-all">{value}</div>
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
      <pre className="overflow-x-auto rounded-md border border-border bg-foreground/[0.03] px-3 py-2.5 text-xs font-mono leading-relaxed text-foreground">
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
  );
}
