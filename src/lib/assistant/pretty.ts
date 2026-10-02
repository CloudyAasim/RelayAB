"use client";

/**
 * src/lib/assistant/pretty.ts
 *
 * Whether the assistant's output is rendered rather than dumped.
 *
 * A display preference, so it follows the theme's lead and lives in
 * localStorage: it is per browser, not per account, and nobody needs it to
 * survive on another device. It is a rendering choice, not a setting the server
 * has to know about.
 *
 * Default on. The raw form was a deliberate choice for a while - a chat that
 * shows exactly what the model said - but the same complaint kept coming back
 * about unformatted walls of text and reasoning left in the middle of answers,
 * and the raw form is still one click away.
 */

const STORAGE_KEY = "relayab-assistant-pretty";

/**
 * Whether the stored value means "pretty". Anything unrecognised - a cleared
 * value, a value from an older version, a hand-edited one - reads as "yes",
 * so a corrupt preference cannot leave someone stuck in a mode they cannot
 * identify.
 */
export function parsePretty(stored: string | null | undefined): boolean {
  if (stored === null || stored === undefined || stored === "") return true;
  return stored !== "0" && stored !== "off" && stored !== "false";
}

export function readPretty(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return parsePretty(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage disabled. The default is the better failure
    // than pretending to remember a choice that is not stored anywhere.
    return true;
  }
}

export function writePretty(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Nothing to do: the choice simply will not outlive this session.
  }
}
