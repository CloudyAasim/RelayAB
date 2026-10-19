/**
 * src/lib/docs/search-protocol-doc.ts
 *
 * The search adapter protocol, read from the repository file.
 *
 * The same arrangement as the media protocol's reader (`./protocol-doc.ts`), and
 * for the same reason: the protocol is a markdown file, not i18n text, so a
 * tool call cannot reach it through `read_docs`. A model asked to write a spec
 * against a protocol it cannot read writes one from memory, and a spec written
 * from memory is a spec that fails validation for reasons nobody can see.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SEARCH_PROTOCOL_DOC_PATH = path.join(
  process.cwd(),
  "docs",
  "搜索适配协议",
  "README.md",
);

export interface SearchProtocolDoc {
  /** The file's text, or `""` when it could not be read. */
  text: string;
  /** Why it is empty, phrased for whoever is about to be told so. */
  error?: string;
}

/**
 * Read the protocol, or say plainly that it is not there.
 *
 * A missing file is reported rather than thrown: the caller has something to
 * show when it happens.
 */
export async function readSearchProtocolDoc(): Promise<SearchProtocolDoc> {
  try {
    return { text: await readFile(SEARCH_PROTOCOL_DOC_PATH, "utf8") };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { text: "", error: `读不到搜索适配协议原文（${SEARCH_PROTOCOL_DOC_PATH}）：${why}` };
  }
}
