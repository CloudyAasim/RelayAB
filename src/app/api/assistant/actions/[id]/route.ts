/**
 * app/api/assistant/actions/[id]/route.ts
 *
 *   POST /api/assistant/actions/:id   Body: { decision: "approve" | "reject",
 *                                         apiKey?: string }
 *
 * **The only path in the codebase where an AI-proposed change reaches the
 * database.** The assistant itself can create a pending action but can never
 * resolve one; resolution is an explicit HTTP call made by a signed-in admin
 * after reading the diff.
 *
 * Four properties this endpoint is responsible for:
 *
 *  1. **Admin only.** A regular user's action, if any, cannot be approved by
 *     anyone but an admin.
 *  2. **Claim before apply.** `claimAssistantAction` flips `pending → applied`
 *     with the status in the WHERE clause, so a double-click or a second tab
 *     affects zero rows and is told the change was already handled rather than
 *     applying it twice.
 *  3. **A key is never carried through an action.** The stored `args` is
 *     replayed through the same schema the admin UI uses, and `apiKey` is not
 *     among the fields an action can carry. A provider cannot be created
 *     without one, so a create carries everything *except* the key and the
 *     approval supplies it — which means the model has no field to put a
 *     secret in, the transcript never holds one, and the only copy is the
 *     ciphertext inside the provider row.
 *  4. **A create asks for its key before it claims.** Claiming first and then
 *     failing on a missing field would spend the proposal, and the admin would
 *     have to make the model do the whole thing again.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, requireAdmin, AuthGuardError, type AuthedUser } from "@/lib/auth/session";
import {
  claimAssistantAction,
  getAssistantAction,
  setAssistantActionStatus,
} from "@/lib/db/assistant";
import { createProvider, updateProvider } from "@/lib/db/providers";
import { createMediaProvider, updateMediaProvider, MediaProviderValidationError } from "@/lib/db/media-providers";

export const dynamic = "force-dynamic";

const DecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  /**
   * The API key, for a create only.
   *
   * It arrives with the approval rather than with the proposal, so the key
   * never becomes part of what the assistant proposed — never sits in
   * `assistant_actions`, never passes through a tool result, and never enters
   * a conversation transcript. The model has no field to put it in, because
   * there is no field for it.
   *
   * Rejected outright on an update, where it would be a silent no-op that
   * reads as "the key was changed".
   */
  apiKey: z.string().max(400).optional(),
});


/** Mirrors PatchSchema in the provider editor, minus anything key-shaped. */
const ModelConfigSchema = z.object({
  upstreamId: z.string(),
  clientId: z.string(),
  displayName: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputCost: z.number().nonnegative().optional(),
  outputCost: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

const ProviderArgsSchema = z
  .object({
    baseUrl: z.string().nullable().optional(),
    anthropicBaseUrl: z.string().nullable().optional(),
    openaiEnabled: z.boolean().optional(),
    anthropicEnabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    modelMapping: z.record(z.string(), z.string()).optional(),
    modelConfigs: z.record(z.string(), ModelConfigSchema).optional(),
  })
  .strict();

const MediaArgsSchema = z
  .object({
    baseUrl: z.string().optional(),
    enabled: z.boolean().optional(),
    models: z.record(z.string(), z.unknown()).optional(),
    specs: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

/** A create's payload, which is a whole provider rather than a patch of one. */
const ProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(["openai", "anthropic"]).default("openai"),
    baseUrl: z.string().max(500).nullable().optional(),
    upstreamFormat: z.enum(["responses", "chat", "anthropic"]).optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
    openaiEnabled: z.boolean().optional(),
    anthropicEnabled: z.boolean().optional(),
    anthropicBaseUrl: z.string().max(500).nullable().optional(),
    modelMapping: z.record(z.string(), z.string()).optional(),
    modelConfigs: z.record(z.string(), ModelConfigSchema).optional(),
  })
  .strict();

const MediaProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    baseUrl: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    models: z.record(z.string(), z.unknown()),
    specs: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict();

const CREATE_KINDS = new Set(["provider.create", "media_provider.create"]);

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // `requireAdmin` throws rather than returning, so the guard has to be caught.
  // Without this a non-admin gets a 500 from the unhandled error instead of
  // the 403 they should see.
  let me: AuthedUser;
  try {
    me = await requireAdmin();
  } catch (err) {
    if (err instanceof AuthGuardError) return err.response;
    throw err;
  }

  const { id } = await context.params;

  const parsed = DecisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "decision 必须是 approve 或 reject" } },
      { status: 400 },
    );
  }

  const existing = await getAssistantAction(me.id, id);
  if (!existing) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "变更不存在" } },
      { status: 404 },
    );
  }
  if (existing.status !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "already_resolved", message: `这条变更已经被处理过了（${existing.status}）` },
      },
      { status: 409 },
    );
  }

  if (parsed.data.decision === "reject") {
    await setAssistantActionStatus(me.id, id, "rejected", "管理员拒绝");
    return NextResponse.json({ ok: true, data: { status: "rejected" } });
  }

  // A create needs a key, and it has to be asked for *before* the claim.
  // Claiming first and then failing would spend the proposal: the admin would
  // have to make the model do the whole thing again over a missing field.
  if (CREATE_KINDS.has(existing.kind)) {
    const key = parsed.data.apiKey?.trim();
    if (!key) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "api_key_required",
            message: "新建服务商需要在上方填入 API 密钥，助手不会替你保管它。",
          },
        },
        { status: 400 },
      );
    }
  } else if (parsed.data.apiKey) {
    return NextResponse.json(
      { ok: false, error: { code: "unexpected_api_key", message: "这条变更不涉及密钥" } },
      { status: 400 },
    );
  }

  // Claim first: this is what makes a double approval a no-op instead of a
  // second write, and it happens before any parse of the payload so two racing
  // requests cannot both reach the provider layer.
  const claimed = await claimAssistantAction(me.id, id);
  if (!claimed) {
    return NextResponse.json(
      { ok: false, error: { code: "already_resolved", message: "这条变更刚刚已经被处理了" } },
      { status: 409 },
    );
  }

  let args: unknown;
  try {
    args = JSON.parse(claimed.args);
  } catch {
    await setAssistantActionStatus(me.id, id, "failed", "变更内容不是合法 JSON");
    return NextResponse.json(
      { ok: false, error: { code: "bad_state", message: "变更内容损坏，无法执行" } },
      { status: 500 },
    );
  }

  try {
    if (claimed.kind === "provider.update") {
      if (!claimed.targetId) throw new Error("变更缺少目标服务商 id");
      const patch = ProviderArgsSchema.parse(args);
      const updated = await updateProvider(claimed.targetId, patch);
      if (!updated) throw new Error("找不到该服务商，可能已被删除");
      await setAssistantActionStatus(
        me.id,
        id,
        "applied",
        `已更新服务商 ${updated.name}（${Object.keys(patch).join(", ") || "无字段"}）`,
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: updated.id } });
    }

    if (claimed.kind === "provider.create") {
      const spec = ProviderCreateSchema.parse(args);
      // The key comes from this request, not from the proposal: it is
      // encrypted on the way into the provider row and exists nowhere else.
      const created = await createProvider({ ...spec, apiKey: parsed.data.apiKey!.trim() });
      await setAssistantActionStatus(
        me.id,
        id,
        "applied",
        `已新建服务商 ${created.name}（${Object.keys(spec).join(", ")}）`,
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: created.id } });
    }

    if (claimed.kind === "media_provider.update") {
      if (!claimed.targetId) throw new Error("变更缺少目标媒体服务商 id");
      const patch = MediaArgsSchema.parse(args);
      const updated = await updateMediaProvider(claimed.targetId, {
        ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.models !== undefined ? { models: patch.models as never } : {}),
        ...(patch.specs !== undefined ? { specs: patch.specs as never } : {}),
      });
      if (!updated) throw new Error("找不到该媒体服务商，可能已被删除");
      await setAssistantActionStatus(
        me.id,
        id,
        "applied",
        `已更新媒体服务商 ${updated.name}（${Object.keys(patch).join(", ") || "无字段"}）`,
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: updated.id } });
    }

    if (claimed.kind === "media_provider.create") {
      const spec = MediaProviderCreateSchema.parse(args);
      const created = await createMediaProvider({
        name: spec.name,
        baseUrl: spec.baseUrl ?? "",
        apiKey: parsed.data.apiKey!.trim(),
        enabled: spec.enabled ?? true,
        priority: spec.priority ?? 1,
        models: spec.models as never,
        specs: spec.specs as never,
      });
      await setAssistantActionStatus(
        me.id,
        id,
        "applied",
        `已新建媒体服务商 ${created.name}（${Object.keys(spec.models ?? {}).length} 个模型）`,
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: created.id } });
    }

    throw new Error(`未知的变更类型：${claimed.kind}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setAssistantActionStatus(me.id, id, "failed", message);
    const status = err instanceof MediaProviderValidationError ? 400 : 422;
    return NextResponse.json(
      { ok: false, error: { code: "apply_failed", message } },
      { status },
    );
  }
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Reading a diff is open to any signed-in user: a regular user's own pending
  // action is theirs to see. Only POST below is admin-gated.
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const { id } = await context.params;
  const action = await getAssistantAction(me.id, id);
  if (!action) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "变更不存在" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { action } });
}
