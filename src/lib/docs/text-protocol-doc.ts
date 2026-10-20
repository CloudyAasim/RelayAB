/**
 * src/lib/docs/text-protocol-doc.ts
 *
 * The text adapter protocol, read from the repository file.
 *
 * The third reader in the same shape as `./protocol-doc.ts` (media) and
 * `./search-protocol-doc.ts` (search), and for the same reason.
 *
 * This one was missing for the longest and it was missing in the place that
 * hurt most. The text protocol is what an operator configures an ordinary
 * chat provider with — the one every provider row has a slot for — and the
 * file has been in the repository all along, with a test that checks every
 * mechanism it names against the code. What it did not have was a way out of
 * the file: `read_docs` resolves i18n keys, so the admin page could announce
 * the protocol and the assistant could not read a word of it. The model was
 * left to write `textSpecs` from memory, which is how a spec ends up naming
 * a mode that does not exist.
 *
 * The file is present at runtime for the same reason as the other two:
 * `pnpm start` is `next start`, which runs from the project root, and the
 * whole repository is what gets deployed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const TEXT_PROTOCOL_DOC_PATH = path.join(
  process.cwd(),
  "docs",
  "文本适配协议",
  "README.md",
);

export interface TextProtocolDoc {
  /** The file's text, or `""` when it could not be read. */
  text: string;
  /** Why it is empty, phrased for whoever is about to be told so. */
  error?: string;
}

/**
 * Read the protocol, or say plainly that it is not there.
 *
 * A missing file is reported rather than thrown: the caller has something to
 * show when it happens, and an exception in a React server component would
 * take the admin documentation page down with it.
 */
export async function readTextProtocolDoc(): Promise<TextProtocolDoc> {
  try {
    return { text: await readFile(TEXT_PROTOCOL_DOC_PATH, "utf8") };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { text: "", error: `读不到文本适配协议原文（${TEXT_PROTOCOL_DOC_PATH}）：${why}` };
  }
}
