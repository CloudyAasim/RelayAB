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
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser, requireAdmin, AuthGuardError, type AuthedUser } from "@/lib/auth/session";
import {
  claimAssistantAction,
  getAssistantAction,
  setAssistantActionStatus,
} from "@/lib/db/assistant";
import { createProvider, getProviderById, updateProvider } from "@/lib/db/providers";
import { withTransaction } from "@/lib/db/sqlite";
import { auditModelConfigs, renderFindingsRefusal } from "@/lib/providers/config-audit";
import { createMediaProvider, updateMediaProvider, MediaProviderValidationError } from "@/lib/db/media-providers";
import { updateSettings } from "@/lib/db/settings";
import {
  checkProposal,
  describeApplyFailure,
  isProposalKind,
  DocPagesArgsSchema,
  MediaArgsSchema,
  MediaProviderCreateSchema,
  ProviderArgsSchema,
  ProviderCreateSchema,
} from "@/lib/assistant/proposal-validation";

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


const CREATE_KINDS = new Set(["provider.create", "media_provider.create"]);

/**
 * Refresh the pages that render the model catalogue.
 *
 * The documentation pages are where an operator looks to see what a change
 * did, and they are server-rendered. This revalidation used to sit inside the
 * `doc_pages.update` branch alone, so a price change — which the catalogue
 * prints — left it showing the old numbers: approve a reprice, go and look,
 * and the page still says the model is free. The approval screen described the
 * change and the page that would confirm it did not, which is the same failure
 * twice.
 *
 * Called from every branch that writes something the catalogue reads.
 */
async function revalidateCatalog(): Promise<void> {
  await revalidatePath("/docs", "layout");
  await revalidatePath("/dashboard/docs", "layout");
}

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
    await setAssistantActionStatus(me.id, id, "failed", "变更内容不是合法 JSON", "applied");
    return NextResponse.json(
      { ok: false, error: { code: "bad_state", message: "变更内容损坏，无法执行" } },
      { status: 500 },
    );
  }

  /**
   * The same check the propose tool ran, run again.
   *
   * Twice is right here and it used to be never. The proposal and the approval
   * can be a day apart, and the spec rules worth checking — a routable page slug,
   * a `statusMap` catch-all — are worth checking again at the moment of the
   * write. It is also what makes the two paths provably the same: both call
   * `checkProposal`, so a rule added to it cannot land on one side only, which is
   * exactly how a `statusMap` came to be validated in the admin panel and in
   * neither of the assistant's two media tools.
   */
  if (!isProposalKind(claimed.kind)) {
    await setAssistantActionStatus(me.id, id, "failed", `未知的变更类型：${claimed.kind}`, "applied");
    return NextResponse.json(
      { ok: false, error: { code: "bad_state", message: `未知的变更类型：${claimed.kind}` } },
      { status: 400 },
    );
  }
  const checked = checkProposal(claimed.kind, args);
  if (!checked.ok) {
    await setAssistantActionStatus(me.id, id, "failed", checked.message!, "applied");
    return NextResponse.json(
      { ok: false, error: { code: "bad_state", message: checked.message } },
      { status: 422 },
    );
  }
  const payload = checked.data as Record<string, unknown>;

  try {
    if (claimed.kind === "provider.update") {
      if (!claimed.targetId) throw new Error("变更缺少目标服务商 id");
      const { textSpecs, modelConfigTarget, modelConfigTargets, modelConfigs, ...rest } =
        payload as z.infer<typeof ProviderArgsSchema>;

      // One list, two shapes: a single model and many models carry the same
      // thing and are applied the same way. `undefined` in an entry means the
      // field was never mentioned, so merging is what keeps the fields nobody
      // asked about intact.
      const targets = modelConfigTargets ?? (modelConfigTarget ? [modelConfigTarget] : undefined);
      let resolvedModelConfigs = modelConfigs;

      // Read, merge, check and write as one step.
      //
      // Reading the provider *now*, rather than as it looked when the proposal
      // was written, is what makes approvals compose instead of undoing each
      // other — eight price proposals made in one go all held the same
      // snapshot, so approving them in a row restored the old prices seven
      // times over. But reading *here* was not enough on its own: the read sat
      // outside the write's transaction, so two approvals in flight at once —
      // two tabs, or one administrator approving quickly — both read the same
      // state, and the second write discarded the first's change while both
      // rows were marked `applied`. The whole read-merge-write now happens
      // inside one IMMEDIATE transaction, which is the only thing that makes
      // "read the current state" and "write it back" a single decision.
      const updated = await withTransaction(async () => {
        if (targets) {
          const current = await getProviderById(claimed.targetId!);
          if (!current) throw new Error("找不到该服务商，可能已被删除");
          const live = { ...(current.modelConfigs ?? {}) };
          for (const { clientId, patch } of targets) {
            live[clientId] = { ...(live[clientId] ?? {}), ...patch };
          }
          resolvedModelConfigs = live;

          /**
           * The free-model audit, second time round.
           *
           * Every tool that writes modelConfigs now checks before it writes —
           * and this is the backstop for a proposal that predates that, or one
           * whose tool was bypassed. Scoped to `patches`, so it can only speak
           * about prices *this* proposal wrote: without the scope, every
           * approval touching one model of a provider that contains a free one
           * would fail on a price it never mentioned.
           */
          const findings = auditModelConfigs(live, {
            patches: Object.fromEntries(targets.map((t) => [t.clientId, t.patch])),
          });
          const blocking = findings.filter((f) => f.blocking);
          if (blocking.length > 0) {
            throw new Error(renderFindingsRefusal(blocking, findings));
          }
        }

        // `null` on the protocol list means "no protocols at all" — the same
        // thing the editor sends as `[]`. Normalised here so the database layer
        // keeps one shape.
        return updateProvider(claimed.targetId!, {
          ...rest,
          ...(resolvedModelConfigs !== undefined
            ? { modelConfigs: resolvedModelConfigs }
            : {}),
          ...(textSpecs !== undefined ? { textSpecs: textSpecs ?? [] } : {}),
        });
      });
      if (!updated) throw new Error("找不到该服务商，可能已被删除");
      // Prices, context and thinking levels are all printed by the catalogue,
      // so a change here has to be visible there.
      await revalidateCatalog();
      const appliedFields = Object.keys(rest).concat(
        resolvedModelConfigs !== undefined ? ["modelConfigs"] : [],
        textSpecs !== undefined ? ["textSpecs"] : [],
      );
      await setAssistantActionStatus(
        me.id,
        id,
        "applied",
        `已更新服务商 ${updated.name}（${appliedFields.join(", ") || "无字段"}）`,
        "applied",
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: updated.id } });
    }

    if (claimed.kind === "provider.create") {
      const spec = payload as z.infer<typeof ProviderCreateSchema>;
      // The key comes from this request, not from the proposal: it is
      // encrypted on the way into the provider row and exists nowhere else.
      const created = await createProvider({ ...spec, apiKey: parsed.data.apiKey!.trim() });
      await setAssistantActionStatus(
        me.id,
        id,
        "applied",
        `已新建服务商 ${created.name}（${Object.keys(spec).join(", ")}）`,
        "applied",
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: created.id } });
    }

    if (claimed.kind === "media_provider.update") {
      if (!claimed.targetId) throw new Error("变更缺少目标媒体服务商 id");
      const patch = payload as z.infer<typeof MediaArgsSchema>;
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
        "applied",
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: updated.id } });
    }

    if (claimed.kind === "doc_pages.update") {
      // The page rules — a routable slug a reader can bookmark, and no two
      // pages sharing one — are checked by `checkProposal` above, on both sides
      // of this click. They used to live only here, which meant the assistant
      // could propose a set that failed the instant it was approved.
      const parsedPages = (payload as z.infer<typeof DocPagesArgsSchema>).docPages;
      await updateSettings({ docPages: parsedPages });
      await revalidateCatalog();
      await setAssistantActionStatus(
        me.id,
        claimed.id,
        "applied",
        `已更新自定义文档，共 ${parsedPages.length} 页`,
        "applied",
      );
      return NextResponse.json({ ok: true, data: { status: "applied", pages: parsedPages.length } });
    }

    if (claimed.kind === "media_provider.create") {
      const spec = payload as z.infer<typeof MediaProviderCreateSchema>;
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
        "applied",
      );
      return NextResponse.json({ ok: true, data: { status: "applied", providerId: created.id } });
    }

    throw new Error(`未知的变更类型：${claimed.kind}`);
  } catch (err) {
    // `MediaProviderValidationError` computed a list of exactly what is wrong
    // with a configuration, and that list was being dropped on the floor: the
    // admin saw the class name, the model saw the class name, and the second
    // could only guess again. It is the part of the error anyone can act on.
    const message = describeApplyFailure(err);
    await setAssistantActionStatus(me.id, id, "failed", message, "applied");
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
