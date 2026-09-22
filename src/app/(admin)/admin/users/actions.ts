"use server";

/**
 * Server Actions for the admin users page.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";

/**
 * Delete a user (cascade-deletes their keys).
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
