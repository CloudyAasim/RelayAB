"use server";

/**
 * Server Actions for the admin users page.
 *
 * Why Server Actions instead of route-handler + fetch?
 *
 * 1. **Automatic revalidation**: after a server action mutates data,
 *    Next.js automatically re-renders the parent server component
 *    (when it sees `revalidatePath`). No window.location.reload(),
 *    no router.refresh(), no manual cache busting.
 *
 * 2. **Built-in form support**: a `<form action={toggleUserAction}>` is
 *    the most reliable browser-native way to invoke a mutation — no
 *    fetch/JSON dance, no client-side state machines.
 *
 * 3. **Auth is checked on the server** (where cookies are available).
 *    Same auth gate as the REST route handler.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById, updateUser } from "@/lib/db/users";

/**
 * Toggle a user's disabled flag.
 *
 * Form payload: FormData with two fields:
 *   - userId:    string  (ULID)
 *   - disabled:  "true" | "false"
 *
 * Redirects back to /admin/users after success so the page re-renders
 * with the freshest server data. A redirect is more reliable than
 * `revalidatePath` alone because it forces the browser to actually
 * make a new HTTP request — no reliance on RSC cache invalidation.
 */
export async function toggleUserAction(formData: FormData): Promise<void> {
  // 1. Auth gate.
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    // No admin session — bounce to login.
    redirect("/login");
  }

  // 2. Validate inputs.
  const Schema = z.object({
    userId: z.string().min(1),
    disabled: z.enum(["true", "false"]),
  });
  const parsed = Schema.safeParse({
    userId: formData.get("userId"),
    disabled: formData.get("disabled"),
  });
  if (!parsed.success) {
    throw new Error(`Invalid toggle payload: ${parsed.error.message}`);
  }

  const targetDisabled = parsed.data.disabled === "true";

  // 3. Sanity check: the user must exist.
  const existing = await getUserById(parsed.data.userId);
  if (!existing) {
    throw new Error("User not found");
  }

  // 4. Refuse self-disable.
  if (parsed.data.userId === me.id && targetDisabled) {
    throw new Error("Cannot disable your own account");
  }

  // 5. Apply.
  await updateUser(parsed.data.userId, { disabled: targetDisabled });

  // 6. Invalidate any cached RSC payload for the users page AND force a
  //    fresh navigation. The redirect is the bulletproof fallback — it
  //    produces a real HTTP request and a real server-rendered response,
  //    which by construction reads the latest Redis state.
  revalidatePath("/admin/users");
  redirect("/admin/users");
}

/**
 * Delete a user (cascade-deletes their keys).
 * Same shape as toggleUserAction — invoked from a form.
 */
export async function deleteUserAction(formData: FormData): Promise<void> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    redirect("/login");
  }
  const userId = String(formData.get("userId") ?? "");
  if (!userId) throw new Error("userId required");
  if (userId === me.id) {
    throw new Error("Cannot delete your own account");
  }

  const { deleteUser } = await import("@/lib/db/users");
  const { deleteApiKeysByUser } = await import("@/lib/db/keys");
  await deleteApiKeysByUser(userId);
  await deleteUser(userId);

  revalidatePath("/admin/users");
  redirect("/admin/users");
}

/**
 * Reset a user's password. Generates a new random password and returns it.
 * Form payload: { userId }
 *
 * Note: returning data from a server action is possible — the action
 * result is delivered to the client. We use the returned value to drive
 * the "show generated password" UI without a redirect.
 */
export async function resetPasswordAction(formData: FormData): Promise<{ generatedPassword: string }> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    redirect("/login");
  }
  const userId = String(formData.get("userId") ?? "");
  if (!userId) throw new Error("userId required");

  const { resetUserPassword } = await import("@/lib/db/users");
  const { generateInitialPassword } = await import("@/lib/crypto/password");
  const newPassword = generateInitialPassword();
  await resetUserPassword(userId, newPassword);

  revalidatePath("/admin/users");
  return { generatedPassword: newPassword };
}
