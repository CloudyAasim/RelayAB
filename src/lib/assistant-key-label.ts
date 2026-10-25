/**
 * src/lib/assistant-key-label.ts
 *
 * The assistant's own credential, and the name it is shown under.
 *
 * It is a **row in the admin's key list**, and its label is stored — so it
 * arrives as a string, in one language, for an administrator who may read the
 * interface in another. The marker says one thing: "this one belongs to the
 * assistant", and it is the only thing it has ever said.
 *
 * So the marker is translated on the way to the screen and **the stored value
 * is left alone**: it is what an existing row carries, it is what the rename
 * form has to prefill, and it is what tells the row apart from a key somebody
 * happened to name the same way.
 *
 * ## Why this is its own file
 *
 * It is imported by a **client** component (the key row's action menu), and the
 * database layer it used to live in reaches for `node:crypto` and `node:fs` —
 * which a browser bundle cannot have. The rule and the marker are together
 * because they must not drift apart; the module they live in is separate
 * because one of them is read in the browser.
 */

/**
 * The label the assistant credential carries in the admin key list, where it
 * is visible and has to be self-explanatory. Hidden from the owning user, so
 * only an administrator ever reads it.
 */
export const ASSISTANT_KEY_LABEL = "AI 助手专用";

/** The translator, as the server helper and the client hook both provide it. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The name to show for a key row, in the reader's language.
 *
 * Only the assistant's own marker is translated. Everything else is a label a
 * person typed, and a person who typed it in Chinese means it in Chinese.
 */
export function assistantKeyLabel(label: string, t: Translate): string {
  return label === ASSISTANT_KEY_LABEL ? t("admin.keys.assistantLabel") : label;
}
