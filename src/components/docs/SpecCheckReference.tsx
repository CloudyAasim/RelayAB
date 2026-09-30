/**
 * src/components/docs/SpecCheckReference.tsx
 *
 * The judge exists in two places, on purpose:
 *
 *  1. **`public/spec-check.html`** — one self-contained file with an inlined port
 *     of the engine. No imports, no build, no network: it runs by double-clicking
 *     it, and it can be handed to an AI that has never seen this repository.
 *     This is the one an operator actually gives away.
 *  2. **`scripts/spec-check.ts`** — the same checks against the *real* engine
 *     (`src/lib/media/engine.ts`), so CI catches whatever the port would excuse.
 *     Rendered below so the page and the repository cannot drift.
 *
 * `tests/unit/spec-check-standalone.test.ts` pins them together: one corpus, run
 * through both, must produce identical results.
 *
 * `outputFileTracingIncludes` in next.config.ts keeps (2) in the deployment
 * bundle; if it is ever missing the page degrades to a note instead of crashing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getT } from "@/lib/i18n/server";
import { CopyButtons } from "./CopyButtons";

const SPEC_CHECK_PATH = path.join(process.cwd(), "scripts", "spec-check.ts");
/** Static asset path of the standalone judge (public/ needs no bundling). */
const STANDALONE_URL = "/spec-check.html";

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
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-2.5">
        <a
          href={STANDALONE_URL}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground underline-offset-2 hover:underline"
        >
          {t("admin.docs.specCheck.openStandalone")}
        </a>
        <a
          href={STANDALONE_URL}
          download="relayab-spec-check.html"
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium underline-offset-2 hover:underline"
        >
          {t("admin.docs.specCheck.downloadStandalone")}
        </a>
        <span className="text-xs text-muted-foreground">{t("admin.docs.specCheck.standaloneHint")}</span>
      </div>

      {source ? (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-2.5">
            <span className="text-xs text-muted-foreground">
              {t("admin.docs.specCheck.copyLabel")}
              <span className="ml-1 opacity-70">
                ({lineCount.toLocaleString()} 行 · {t("admin.docs.specCheck.repoVariant")})
              </span>
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
