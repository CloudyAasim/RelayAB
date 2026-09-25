"use server";

import { revalidatePath } from "next/cache";
import { destroySession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export async function logoutAction() {
  await destroySession();
  // Clearing the cookie is not enough: Next.js keeps a client-side Router
  // Cache (see `staleTimes.dynamic` in next.config.ts), so the back/forward
  // stack can still render the previous user's RSC payloads. Purging the
  // whole layout tree evicts those entries on the way out.
  revalidatePath("/", "layout");
  redirect("/login");
}
