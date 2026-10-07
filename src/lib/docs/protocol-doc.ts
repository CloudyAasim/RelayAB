/**
 * src/lib/docs/protocol-doc.ts
 *
 * The media adapter protocol, read from the repository file.
 *
 * One path, one read, two callers. It used to be spelled out twice — the admin
 * page rendered it and nothing else could — and the second caller did not exist
 * until the assistant needed it and discovered it could not have it: `read_docs`
 * resolves i18n keys, so a page whose content is a markdown file came back as
 * the handful of lines describing the file and nothing of the file itself. The
 * model was told "the protocol full text is below" and then handed a sentence
 * saying it was below.
 *
 * The file is present at runtime. `pnpm start` is `next start`, which runs from
 * the project root, and the whole repository is what gets deployed — so this is
 * a plain `readFile`, not a bundle-tracing question. (There is no
 * `outputFileTracingIncludes` in `next.config.mjs`; a comment elsewhere in the
 * tree claimed there was.)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const PROTOCOL_DOC_PATH = path.join(process.cwd(), "docs", "模型适配协议", "README.md");

export interface ProtocolDoc {
  /** The file's text, or `""` when it could not be read. */
  text: string;
  /** Why it is empty, phrased for whoever is about to be told so. */
  error?: string;
}

/**
 * Read the protocol, or say plainly that it is not there.
 *
 * A missing file is reported rather than thrown: both callers have something to
 * show when it happens, and an exception in a React server component would take
 * the admin documentation page down with it.
 */
export async function readProtocolDoc(): Promise<ProtocolDoc> {
  try {
    return { text: await readFile(PROTOCOL_DOC_PATH, "utf8") };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { text: "", error: `读不到媒体适配协议原文（${PROTOCOL_DOC_PATH}）：${why}` };
  }
}