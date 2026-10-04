"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import type { ProseUserDocId } from "@/lib/docs/sections";
import {
  Link2,
  Server,
  Code2,
  Terminal,
  Copy,
  Check,
  Sparkles,
  Image as ImageIcon,
} from "lucide-react";

interface Props {
  /**
   * Narrower than `UserDocId` on purpose: this component's last `return` is the
   * media chapter, so a type that let `catalog` or `notes` through would render
   * media prose under the wrong heading rather than fail to compile.
   */
  section: ProseUserDocId;
  baseUrl: string;
  openaiBase: string;
  anthropicBase: string;
  /**
   * The Responses chapter used to carry its own base, and it was the same
   * string. Both OpenAI-shaped endpoints live under one `/v1`, so a second prop
   * was a second place to change an address and a second thing for a reader to
   * compare and find identical — which is true, and reads as a mistake. The
   * chapters now say outright that they share one base and one header.
   */
}

/** One page of the integration docs. The shell handles navigation. */
export function DocsContent({
  section,
  baseUrl,
  openaiBase,
  anthropicBase,
}: Props) {
  const t = useT();

  if (section === "start") {
    return (
      <div className="space-y-4 sm:space-y-6">
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-background to-info/5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:h-10 sm:w-10">
              <Sparkles className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground sm:text-base">
                {t("docs.title")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">
                {t("docs.intro")}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t("docs.basics.title")}
            description={t("docs.basics.desc")}
          />
          <div className="space-y-2 text-xs text-foreground/90 sm:space-y-3 sm:text-sm">
            <p>{t("docs.basics.line1")}</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>{t("docs.basics.line2")}</li>
              <li>{t("docs.basics.line3")}</li>
              <li>{t("docs.basics.line4")}</li>
            </ol>
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground dark:text-warning">
              {t("docs.basics.warning")}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (section === "endpoints") {
    return (
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
    );
  }

  if (section === "openai") {
    return (
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
        <div className="space-y-3 text-xs text-foreground/90 sm:space-y-4 sm:text-sm">
          <p>{t("docs.openai.line1")}</p>
          <p className="text-xs text-muted-foreground">{t("docs.openai.sharesBase")}</p>
          <CodeBlock label={t("docs.openai.baseUrl")} value={openaiBase} />
          <CodeBlock
            label={t("docs.openai.header")}
            value="Authorization: Bearer sk-relay-xxxx..."
          />
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
    );
  }

  if (section === "anthropic") {
    return (
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
        <div className="space-y-3 text-xs text-foreground/90 sm:space-y-4 sm:text-sm">
          <p>{t("docs.anthropic.line1")}</p>
          <p className="text-xs text-muted-foreground">
            {t("docs.anthropic.baseUrl.official")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("docs.anthropic.baseUrl.aiSdk")}
          </p>
          <CodeBlock label={t("docs.anthropic.baseUrl")} value={anthropicBase} />
          <CodeBlock
            label={t("docs.anthropic.header")}
            value="x-api-key: sk-relay-xxxx..."
          />
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("docs.anthropic.baseUrl.tip")}
          </p>
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
    );
  }

  if (section === "responses") {
    return (
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
        <div className="space-y-3 text-xs text-foreground/90 sm:space-y-4 sm:text-sm">
          <p>{t("docs.responses.line1")}</p>
          {/*
            The base and the header are not repeated here. They are the ones on
            the OpenAI chapter, verbatim, and the reason is worth stating rather
            than showing twice: both endpoints are served under one `/v1` and
            authenticated the same way. Two identical code blocks in two
            chapters reads as a copy-paste slip; one shared sentence reads as
            what it is.
          */}
          <p className="text-xs text-muted-foreground">{t("docs.responses.sameAsOpenai")}</p>
          <CodeBlock
            label={t("docs.responses.example")}
            value={`curl ${openaiBase}/responses \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "YOUR_MODEL_ID","input": "Hello!"}'`}
          />
        </div>
      </Card>
    );
  }

  if (section === "models") {
    return (
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
        <div className="space-y-2 text-xs text-foreground/90 sm:space-y-3 sm:text-sm">
          <p>{t("docs.models.line1")}</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t("docs.models.line2")}</li>
            <li>{t("docs.models.line3")}</li>
          </ul>
          <CodeBlock
            label={t("docs.cli.example")}
            value={`curl -H "Authorization: Bearer $RELAYAB_KEY" ${openaiBase}/models`}
          />
        </div>
      </Card>
    );
  }

  if (section === "sdks") {
    return (
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
    );
  }

  if (section === "media") {
    return (
      <div className="space-y-4 sm:space-y-6">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                {t("docs.media.title")}
              </span>
            }
            description={t("docs.media.desc")}
          />
        <div className="space-y-3 text-xs text-foreground/90 sm:space-y-4 sm:text-sm">
          <p>{t("docs.media.line1")}</p>
          <CodeBlock
            label={t("docs.media.image")}
            value={`curl ${openaiBase}/images/generations \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "image-01", "prompt": "a red apple", "n": 1, "size": "1024x1024"}'`}
          />
          <CodeBlock
            label={t("docs.media.edit")}
            value={`curl ${openaiBase}/images/edits \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -F model=image-01 \\
  -F prompt="same character, new scene" \\
  -F image=@reference.png`}
          />
          <CodeBlock
            label={t("docs.media.video")}
            value={`curl ${openaiBase}/videos/generations \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "video-01", "prompt": "a wave"}'`}
          />
          <CodeBlock
            label={t("docs.media.tts")}
            value={`curl ${openaiBase}/audio/speech \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "tts-1", "input": "Hello!", "voice": "alloy"}' \\
  --output speech.mp3`}
          />
          <CodeBlock
            label={t("docs.media.stt")}
            value={`curl ${openaiBase}/audio/transcriptions \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -F model=stt-1 \\
  -F file=@speech.mp3`}
          />
          <CodeBlock
            label={t("docs.media.music")}
            value={`curl ${openaiBase}/audio/music \\
  -H "Authorization: Bearer $RELAYAB_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "music-01", "prompt": "lo-fi beat"}'`}
          />
          <p className="rounded-md border border-border bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground">
            {t("docs.media.billing")}
          </p>
        </div>
      </Card>

      <p className="py-2 text-center text-xs text-muted-foreground">
        {t("docs.help.contactAdmin")}
      </p>
    </div>
    );
  }

  /*
   * Nothing renders the media page by accident any more.
   *
   * `media` used to be whatever fell past the last `if`, so *any* chapter id
   * this component did not recognise came out as the media page — under the
   * media page's own heading, with its own examples, looking entirely
   * plausible. Nothing hits that today because the two ids that are not prose
   * are routed away above it, but the type that would have caught it is
   * erased at runtime, and the next chapter added without a branch would land
   * here silently.
   *
   * So it says what happened instead. An unreachable branch is a bug; a page
   * that lies about which page it is is worse.
   */
  return (
    <Card>
      <CardHeader title={t("docs.unknown.title")} description={t("docs.unknown.desc")} />
      <p className="font-mono text-xs text-muted-foreground">{section}</p>
    </Card>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 px-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </div>
        <div className="mt-0.5 select-all break-all font-mono text-xs text-foreground sm:text-sm">
          {value}
        </div>
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
