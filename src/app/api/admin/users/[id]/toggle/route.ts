/**
 * app/api/admin/users/[id]/toggle/route.ts
 *
 * Toggle a user's disabled flag.
 *
 * Accepts BOTH:
 *   - JSON POST  (Content-Type: application/json)  → returns JSON
 *   - Form POST  (Content-Type: application/x-www-form-urlencoded)  → returns 303 redirect
 *
 * The form-POST path lets us drive the mutation from a plain HTML <form>,
 * which is the most browser-reliable way to trigger a server-side mutation.
 * No JavaScript required: the browser handles the submit, the server does
 * the work, and the browser follows the 303 back to /admin/users with
 * fresh state.
 */
import { NextResponse } from "next/server";
import { flashRedirect } from "@/lib/http/flash";
import { apiErrorText, getT } from "@/lib/i18n/server";
import { getRedis, k } from "@/lib/db/redis";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserById, updateUser } from "@/lib/db/users";
import { toPublicUser } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";

const JsonSchema = z.object({
  disabled: z.boolean(),
});

const FormSchema = z.object({
  userId: z.string().min(1),
  disabled: z.enum(["true", "false"]),
});

export async function POST(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    if (isFormPost) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("forbidden", "Admin required"),
      });
    }
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  // The route lives at /api/admin/users/[id]/toggle — so we can pull the
  // user id from the URL segment instead of relying on the form to send it.
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  // /api/admin/users/<id>/toggle  →  [<empty>, "api", "admin", "users", "<id>", "toggle"]
  const id = pathParts[pathParts.length - 2] ?? "";

  let targetDisabled: boolean;
  if (isFormPost) {
    const form = await req.formData();
    // Validate the userId matches the URL (defence-in-depth).
    const parsed = FormSchema.safeParse({
      userId: form.get("userId"),
      disabled: form.get("disabled"),
    });
    if (!parsed.success) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("bad_request", parsed.error.message),
      });
    }
    if (parsed.data.userId !== id) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("bad_request", "URL and form userId mismatch."),
      });
    }
    targetDisabled = parsed.data.disabled === "true";
  } else {
    // JSON POST.
    const body = await req.json().catch(() => null);
    const parsed = JsonSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: parsed.error.message } },
        { status: 400 },
      );
    }
    targetDisabled = parsed.data.disabled;
  }

  const existing = await getUserById(id);
  if (!existing) {
    if (isFormPost) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("not_found", "User not found"),
      });
    }
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "User not found" } },
      { status: 404 },
    );
  }

  // Refuse self-disable.
  if (id === me.id && targetDisabled) {
    if (isFormPost) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("self_disable", "Cannot disable your own account"),
      });
    }
    return NextResponse.json(
      { ok: false, error: { code: "self_disable", message: "Cannot disable your own account" } },
      { status: 400 },
    );
  }

  const updated = await updateUser(id, { disabled: targetDisabled });
  if (!updated) {
    if (isFormPost) {
      return flashRedirect("/admin/users", {
        kind: "error",
        message: await apiErrorText("update_failed", "Could not update user"),
      });
    }
    return NextResponse.json(
      { ok: false, error: { code: "update_failed", message: "Could not update user" } },
      { status: 500 },
    );
  }

  revalidatePath("/admin/users");

  if (isFormPost) {
    // Browser submitted a plain HTML form → return a 303 redirect back to
    // the users page. The browser follows the redirect natively and renders
    // a fresh server-rendered page that reads the latest Redis state.
    // Relative Location: stays on the origin the browser is already on, so
    // the session cookie still matches (see lib/http/see-other.ts).
    //
    // The banner reports what we read BACK from Redis, so "the row looks
    // unchanged" can be told apart from "the write never landed".
    const { t } = await getT();
    const stored = await getRedis().hget<string>(k.user(id), "disabled");
    return flashRedirect("/admin/users", {
      kind: "ok",
      message: [
        t(
          targetDisabled
            ? "admin.users.flash.disabled"
            : "admin.users.flash.enabled",
          { username: existing.username },
        ),
        t("admin.users.flash.dbValue", { raw: String(stored) }),
      ].join(" · "),
    });
  }

  return NextResponse.json(
    { ok: true, data: { user: toPublicUser(updated) } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
