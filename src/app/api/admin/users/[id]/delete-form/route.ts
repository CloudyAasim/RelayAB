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

const FormSchema = z.object({
  userId: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return new NextResponse("<h1>Forbidden</h1>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  const id = pathParts[pathParts.length - 2] ?? "";

  const contentType = req.headers.get("content-type") ?? "";
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  let userId = id;
  if (isFormPost) {
    const form = await req.formData();
    const parsed = FormSchema.safeParse({ userId: form.get("userId") });
    if (!parsed.success || parsed.data.userId !== id) {
      return new NextResponse("<h1>Bad request</h1>", {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }
    userId = parsed.data.userId;
  }

  if (userId === me.id) {
    return new NextResponse("<h1>Cannot delete your own account</h1>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  const existing = await getUserById(userId);
  if (!existing) {
    return new NextResponse("<h1>User not found</h1>", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  await deleteApiKeysByUser(userId);
  const { deleteUser } = await import("@/lib/db/users");
  await deleteUser(userId);

  revalidatePath("/admin/users");
  return NextResponse.redirect(new URL("/admin/users", req.url), 303);
}
