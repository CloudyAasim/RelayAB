/**
 * src/lib/http/flash.ts
 *
 * One-shot result messages for browser-driven (plain HTML <form>) mutations.
 *
 * Why this exists: a form POST that fails used to answer with a bare HTML
 * error page, and a POST that succeeded just redirected to a page whose only
 * feedback was a row badge. When something goes wrong in production the admin
 * sees "nothing happened" and has no way to tell *which* step failed.
 *
 * The route stores a short-lived cookie describing the outcome (plus, for
 * writes, the value it read back from Redis) and redirects to the page. The
 * page renders it as a banner. The cookie expires on its own after a few
 * seconds, so a later refresh shows a clean page again.
 */
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { isProduction } from "../config";
import { seeOther } from "./see-other";

export const FLASH_COOKIE = "relay_flash";

/** Long enough to survive the redirect, short enough not to nag. */
const FLASH_TTL_SECONDS = 15;

export interface Flash {
  kind: "ok" | "error";
  message: string;
}

function encode(flash: Flash): string {
  return Buffer.from(JSON.stringify(flash), "utf8").toString("base64url");
}

/**
 * 303 back to `path` carrying `flash` for the next page render.
 * Relative Location — see `seeOther()` for why that matters.
 */
export function flashRedirect(path: string, flash: Flash): NextResponse {
  const res = seeOther(path);
  res.cookies.set({
    name: FLASH_COOKIE,
    value: encode(flash),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAge: FLASH_TTL_SECONDS,
  });
  return res;
}

/** Read and decode the pending flash, if any. Safe to call on every render. */
export async function readFlash(): Promise<Flash | null> {
  const store = await cookies();
  const raw = store.get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Flash;
    if (parsed?.kind !== "ok" && parsed?.kind !== "error") return null;
    if (typeof parsed.message !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
