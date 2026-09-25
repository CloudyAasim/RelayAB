/**
 * app/api/admin/users/[id]/delete-form/route.ts
 *
 * Form-POST variant of the user delete endpoint. Returns 303 redirect
 * so a plain HTML <form> can drive it.
 */
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { deleteApiKeysByUser } from "@/lib/db/keys";
import { getUserById } from "@/lib/db/users";
import { flashRedirect } from "@/lib/http/flash";
import { formatUserIdentity } from "@/lib/user-identity";
import { apiErrorText, getT } from "@/lib/i18n/server";

const FormSchema = z.object({
  userId: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return flashRedirect("/admin/users", {
      kind: "error",
      message: await apiErrorText("forbidden", "Admin required"),
    });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  const id = pathParts[pathParts.length - 2] ?? "";

  let userId = id;
  if (isFormPost) {
    const form = await req.formData();
    const parsed = FormSchema.safeParse({ userId: form.get("userId") });
    if (!parsed.success || parsed.data.userId !== id) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("bad_request"),
      });
    }
    userId = parsed.data.userId;
  }

  if (userId === me.id) {
    return flashRedirect("/admin/users", {
      kind: "error",
      message: await apiErrorText("self_delete", "Cannot delete your own account"),
    });
  }

  const existing = await getUserById(userId);
  if (!existing) {
    return flashRedirect("/admin/users", {
      kind: "error",
      message: await apiErrorText("not_found", "User not found"),
    });
  }

  await deleteApiKeysByUser(userId);
  const { deleteUser } = await import("@/lib/db/users");
  await deleteUser(userId);

  revalidatePath("/admin/users");
  const { t } = await getT();
  return flashRedirect("/admin/users", {
    kind: "ok",
    message: t("admin.users.flash.deleted", { name: formatUserIdentity(existing.username, existing.displayName) }),
  });
}
