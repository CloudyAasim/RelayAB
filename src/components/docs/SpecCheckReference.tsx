/**
 * src/components/docs/SpecCheckReference.tsx
 *
 * Renders the spec judge **from the repository file**
 * (`scripts/spec-check.ts`), the same way the protocol page renders its README:
 * what the operator reads here is what runs in CI and what an AI would get if
 * it cloned the repository.
 *
 * It gets its own admin docs page rather than living inside the protocol,
 * because the file is ~1,400 lines. The protocol is prose you read; this is a
 * reference you scroll or copy, and burying it would double that page.
 *
 * `outputFileTracingIncludes` in next.config.ts keeps the file in the deployment
 * bundle; if it is ever missing the page degrades to a note instead of crashing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getT } from "@/lib/i18n/server";
import { CopyButtons } from "./CopyButtons";

const SPEC_CHECK_PATH = path.join(process.cwd(), "scripts", "spec-check.ts");

export async function SpecCheckReference() {
  const { t } = await getT();

  let source = "";
  try {
    source = await readFile(SPEC_CHECK_PATH, "utf8");
  } catch {
    source = "";
  }

  const lineCount = source ? source.split("\n").length : 0;

  return (
    <div className="space-y-3">
      {source ? (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-2.5">
            <span className="text-xs text-muted-foreground">
              {t("admin.docs.specCheck.copyLabel")}
              <span className="ml-1 opacity-70">({lineCount.toLocaleString()} 行)</span>
            </span>
            <CopyButtons
              options={[{ key: "source", label: t("admin.docs.specCheck.copyLabel"), value: source }]}
              copiedLabel={t("docs.copy.copied")}
              failLabel={t("docs.copy.failed")}
            />
          </div>

          <pre className="max-h-[70vh] overflow-auto rounded-md border border-border bg-foreground/[0.03] px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
            <code>{source}</code>
          </pre>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("admin.docs.specCheck.unavailable")}</p>
      )}
    </div>
  );
}
