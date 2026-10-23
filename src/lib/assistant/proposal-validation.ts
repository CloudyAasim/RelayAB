/**
 * src/lib/assistant/proposal-validation.ts
 *
 * What a proposal is allowed to contain — checked **before** it is offered.
 *
 * A proposal is the only path an AI-written change takes into the database, and
 * every one of these payloads used to be validated at exactly one moment: when
 * the administrator pressed 同意. The diff they read does not validate, so an
 * invalid payload looked exactly like a valid one right up to the click, and
 * then took the whole proposal down with it. The approval is the one moment in
 * this flow that cannot be undone.
 *
 * The admin's own media-provider API had been doing the right thing all along
 * — `validateMediaSpecs` as a dry run before the write, since a spec that does
 * not parse should be rejected in the panel rather than on a live request. So
 * the check was never missing from the system; it was missing from one of the
 * two doors into it.
 *
 * Hence one module. The apply route and the propose tools both call
 * `checkProposal`, so a rule added here cannot exist on one side only, and the
 * message an assistant gets when a proposal is refused is built from the same
 * formatter that produces the message an administrator sees when an apply
 * fails.
 */
import { z, ZodError } from "zod";

import { ModelConfigMergePatchSchema, ModelConfigPatchSchema } from "../db/types";
import { MediaProviderValidationError } from "../db/media-providers";
import { validateMediaSpecs } from "../media/spec";
import { validateSearchSpec } from "../search/spec";
import { validatePage } from "../docs/custom";

export type ProposalKind =
  | "provider.update"
  | "provider.create"
  | "media_provider.update"
  | "media_provider.create"
  | "search_provider.update"
  | "search_provider.create"
  | "doc_pages.update";

export interface ProposalCheck {
  ok: boolean;
  /** The parsed payload, for the apply path. The propose path only needs `ok`. */
  data?: unknown;
  /** Real but not fatal, exactly as the admin API reports them. */
  warnings: string[];
  /** Ready to hand straight back to the assistant when `ok` is false. */
  message?: string;
}

/**
 * The provider-editor shape, used directly rather than mirrored.
 *
 * "Minus anything key-shaped" was true the moment it was written and stopped
 * being the difference the moment a field was added: the local copy lost
 * `reasoningLevels` and both cache prices while the tool still offered them, so
 * a proposal came back reported as applied with the field stripped. The provider
 * key is not part of this shape at all — it is a separate field of the approval
 * body — so using the shared schema drops nothing and cannot drift again.
 */
export const ProviderArgsSchema = z
  .object({
    baseUrl: z.string().nullable().optional(),
    anthropicBaseUrl: z.string().nullable().optional(),
    /**
     * Fixed headers sent upstream, and which upstream protocol the OpenAI face
     * speaks.
     *
     * Both were missing here while `propose_provider_update` offered both, wrote
     * both into the proposal, and the approval diff rendered `upstreamFormat` as
     * a line the administrator was being asked to confirm. Because this object is
     * `.strict()`, the parse rejected the whole proposal at apply time — so the
     * sequence was: the assistant proposed it, the screen showed the diff, the
     * administrator approved it, and then the change failed and took every
     * other field in the same proposal with it.
     *
     * The lesson is the one that keeps repeating: a schema stricter than the
     * tool that writes it puts the failure *after* the approval, which is the
     * one place an administrator's click cannot be refunded.
     * `assistant-provider-field-parity` checks this list against the tool's
     * declared parameters, so a field cannot be offered without somewhere to
     * land.
     *
     * Mirrors `src/app/api/admin/providers/route.ts`, which is where an operator
     * edits these same two fields by hand.
     */
    headers: z.record(z.string(), z.string()).optional(),
    upstreamFormat: z.enum(["responses", "chat", "anthropic"]).optional(),
    /**
     * Which of the two rule sets the engine reads.
     *
     * Added because the tool could write `textSpecs` but had no way to say they
     * should apply — so a provider could end up holding rules that nothing
     * executed. `activeSpecFor` returns null unless this is `"advanced"`, which
     * makes the omission consequential rather than cosmetic: the administrator
     * sees rules saved in the panel and no behaviour change anywhere.
     *
     * Optional rather than required, because leaving it alone keeps a row's
     * current meaning — including `null`, which means "apply whatever rules it
     * has", the behaviour every provider had before this field existed.
     */
    activeMode: z.enum(["simple", "advanced"]).optional(),
    openaiEnabled: z.boolean().optional(),
    anthropicEnabled: z.boolean().optional(),
    /**
     * How the Anthropic face is served: the vendor's own `/v1/messages`, or
     * the gateway's translation of the request into the protocol the vendor
     * does speak.
     */
    anthropicMode: z.enum(["native", "translated"]).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    modelMapping: z.record(z.string(), z.string()).optional(),
    /**
     * What this proposal is for, rather than what it looked like when it was
     * written.
     *
     * A proposal used to carry the whole model table as it stood at creation
     * time, and approving it replaced the table with that copy. Two proposals
     * over one provider then overwrote each other in approval order, the last
     * silently reverting the first — with every status reading `applied` and no
     * error anywhere. Eight approved price changes, one of them in the
     * database. Storing the model and the fields means the apply reads the
     * provider as it stands and merges into it, so order stops mattering.
     */
    modelConfigTarget: z
      .object({
        clientId: z.string().min(1).max(200),
        patch: ModelConfigMergePatchSchema,
      })
      .optional(),
    /**
     * The same merge, for many models at once.
     *
     * A provider with nine models would otherwise need nine proposals and nine
     * approvals to describe one intention, and stopping halfway leaves half the
     * catalogue repriced. Each entry is still merged into the provider as it
     * stands at that moment, so a list of them composes with anything applied in
     * between rather than reverting it.
     */
    modelConfigTargets: z
      .array(
        z.object({
          clientId: z.string().min(1).max(200),
          patch: ModelConfigMergePatchSchema,
        }),
      )
      .min(1)
      .max(200)
      .optional(),
    /**
     * The whole table, for proposals written before the field above existed and
     * for anyone who means to replace it.
     *
     * Read only when `modelConfigTarget` is absent: two shapes cannot both be
     * honoured, and the one that loses is the one that would revert the other's
     * work. Kept because a proposal is already sitting in the queue in this
     * shape, and dropping it would spend an approval on nothing — the exact
     * failure the comment above this schema was written about.
     */
    modelConfigs: z.record(z.string(), ModelConfigPatchSchema).optional(),
    /**
     * The provider's protocol documents, one per compatibility interface.
     *
     * **A list, merged by `protocol`** — the tool sends the entries it wants to
     * change and the ones it omits are kept, so adding a rule for one interface
     * does not mean resending the other two in full.
     *
     * This was `textSpec`, a single string, and it did not work: the schema
     * accepted the key, `updateProvider` read `patch.textSpecs` (plural), so the
     * proposal was approved, the diff showed it, and nothing was written. A
     * proposal that is silently discarded is worse than a rejected one — it
     * spends the administrator's approval on nothing.
     */
    textSpecs: z.array(z.string().max(200_000)).nullable().optional(),
  })
  .strict();

/** The operator's documentation chapter, as one replacement list. */
export const DocPagesArgsSchema = z
  .object({
    docPages: z
      .array(
        z.object({
          id: z.string().min(1).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          title: z.string().min(1).max(120),
          body: z.string().max(60_000),
          hidden: z.boolean().optional(),
          order: z.number().int().min(0).max(10_000).optional(),
        }),
      )
      .max(30),
  })
  .strict();

export const MediaArgsSchema = z
  .object({
    baseUrl: z.string().optional(),
    enabled: z.boolean().optional(),
    models: z.record(z.string(), z.unknown()).optional(),
    specs: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

/** A create's payload, which is a whole provider rather than a patch of one. */
export const ProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(["openai", "anthropic"]).default("openai"),
    baseUrl: z.string().max(500).nullable().optional(),
    upstreamFormat: z.enum(["responses", "chat", "anthropic"]).optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
    openaiEnabled: z.boolean().optional(),
    anthropicEnabled: z.boolean().optional(),
    anthropicMode: z.enum(["native", "translated"]).optional(),
    anthropicBaseUrl: z.string().max(500).nullable().optional(),
    /**
     * The same two fields the update schema carries, for the same reason.
     *
     * A provider created by the assistant used to be creatable only in its
     * transport shape: a vendor that needs a fixed header, or whose parameters
     * differ from OpenAI's, had to be created twice — once by the assistant and
     * once by hand in the panel. That is not "configure the provider", it is
     * "create a placeholder".
     *
     * `activeMode` is accepted together with `textSpecs` so one proposal can do
     * the whole thing; a create that writes rules and leaves the mode inferred
     * would be the AgnesCN shape on day one.
     */
    headers: z.record(z.string(), z.string()).optional(),
    textSpecs: z.array(z.string().max(200_000)).nullable().optional(),
    activeMode: z.enum(["simple", "advanced"]).optional(),
    modelMapping: z.record(z.string(), z.string()).optional(),
    modelConfigs: z.record(z.string(), ModelConfigPatchSchema).optional(),
  })
  .strict();

export const MediaProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    baseUrl: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    models: z.record(z.string(), z.unknown()),
    specs: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict();

/**
 * A search provider's own fields.
 *
 * `kind` is a free tag rather than an enum of the three built-ins: a row that
 * carries a spec may name any vendor, and that is the whole point of the
 * protocol. `spec` is validated by the protocol's own parser — see
 * `searchSpecIssues` below — so the assistant cannot propose a spec the admin
 * panel would refuse.
 */
export const SearchProviderArgsSchema = z
  .object({
    kind: z.string().min(1).max(60).optional(),
    baseUrl: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    creditsPerCall: z.number().int().min(0).optional(),
    /**
     * The row's own spec. `null` returns the row to its template.
     *
     * Typed as `unknown` on purpose: the spec is checked by
     * `parseSearchSpec`, which knows what a spec is. A zod schema here would be
     * a second description of the protocol, and a second description is how a
     * rule ends up validated on one side of a door and not the other.
     */
    spec: z.unknown().optional(),
  })
  .strict();

/** A create's payload, which is a whole provider rather than a patch of one. */
export const SearchProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.string().min(1).max(60),
    baseUrl: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    creditsPerCall: z.number().int().min(0).optional(),
    spec: z.unknown().optional(),
  })
  .strict();

const SCHEMA_FOR: Record<ProposalKind, z.ZodType> = {
  "provider.update": ProviderArgsSchema,
  "provider.create": ProviderCreateSchema,
  "media_provider.update": MediaArgsSchema,
  "media_provider.create": MediaProviderCreateSchema,
  "search_provider.update": SearchProviderArgsSchema,
  "search_provider.create": SearchProviderCreateSchema,
  "doc_pages.update": DocPagesArgsSchema,
};

/**
 * A dotted path, so a field inside a nested mapping is locatable.
 *
 * `["modelConfigs", 0, "contextLength"]` → `modelConfigs[0].contextLength`.
 */
function describePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "顶层";
  return path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : `${acc}.${String(part)}`),
    "",
  );
}

/**
 * A Zod failure as a sentence.
 *
 * Its `message` is a JSON array of issues, and that array was reaching the
 * approval screen verbatim. It is technically the reason and practically
 * unreadable: it names a field without saying whose fault it is, and the one
 * thing whoever has to act on needs is that *this proposal* contains something
 * the server will not accept.
 */
export function describeZodIssues(err: ZodError): string {
  return (
    `变更内容有 ${err.issues.length} 处通不过校验` +
    `（这是提案本身的问题，不是配置写错了）：` +
    err.issues.map((i) => `${describePath(i.path)}${i.message}`).join("；")
  );
}

/** The spec-level rules that only make sense across the whole set. */
function mediaSpecIssues(specs: unknown[]): string[] {
  if (specs.length === 0) return [];
  return validateMediaSpecs(specs).errors;
}

/**
 * The search protocol's own rules, read from its own validator.
 *
 * Not a copy: `parseSearchSpec` is the single description of what a spec may
 * contain, and the admin panel's save calls it too. A second set of rules here
 * would be the same mistake the media side already made once — a rule that is
 * checked in the panel and in neither of the assistant's tools.
 */
function searchSpecIssues(spec: unknown): string[] {
  if (spec === undefined || spec === null) return [];
  return validateSearchSpec(spec).errors;
}

/** Page rules that are about the list rather than any one page. */
function docPageIssues(pages: Array<{ id: string }>): string[] {
  const issues: string[] = [];
  for (const page of pages) {
    const result = validatePage(page);
    if (result) issues.push(`页面 ${page.id} 不合法：${result}`);
  }
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.id)) issues.push(`页面标识「${page.id}」重复了`);
    seen.add(page.id);
  }
  return issues;
}

/**
 * Is this proposal allowed to exist?
 *
 * The same call the apply route makes, so the two cannot answer differently.
 * `args` is the merged payload the proposal would apply — for a `specEdits`
 * proposal that is the merged spec array, not the edits, because a per-edit
 * check would pass a set of fragments that cannot stand on its own.
 */
export function checkProposal(kind: ProposalKind, args: unknown): ProposalCheck {
  const parsed = SCHEMA_FOR[kind].safeParse(args);
  if (!parsed.success) {
    return { ok: false, warnings: [], message: describeZodIssues(parsed.error) };
  }
  const data = parsed.data as Record<string, unknown>;

  if (kind === "media_provider.update" || kind === "media_provider.create") {
    const specs = Array.isArray(data.specs) ? (data.specs as unknown[]) : [];
    const issues = mediaSpecIssues(specs);
    if (issues.length > 0) {
      return {
        ok: false,
        warnings: [],
        message:
          `这份 spec 通不过协议校验，我先没有生成提案 —— 管理台保存时用的是同一份校验，` +
          `在这里过得去，在那里也过得去。逐条改掉再重提：\n` +
          issues.map((i, n) => `${n + 1}. ${i}`).join("\n"),
      };
    }
    const warnings = specs.length > 0 ? validateMediaSpecs(specs).warnings : [];
    return { ok: true, data, warnings };
  }

  if (kind === "search_provider.update" || kind === "search_provider.create") {
    const issues = searchSpecIssues(data.spec);
    if (issues.length > 0) {
      return {
        ok: false,
        warnings: [],
        message:
          `这份搜索协议通不过协议校验，我先没有生成提案 —— 管理台保存时用的是同一份校验，` +
          `在这里过得去，在那里也过得去。逐条改掉再重提：\n` +
          issues.map((i, n) => `${n + 1}. ${i}`).join("\n"),
      };
    }
    const warnings = data.spec ? validateSearchSpec(data.spec).warnings : [];
    return { ok: true, data, warnings };
  }

  if (kind === "doc_pages.update") {
    const pages = (data.docPages ?? []) as Array<{ id: string }>;
    const issues = docPageIssues(pages);
    if (issues.length > 0) {
      return {
        ok: false,
        warnings: [],
        message: `这些文档页不合法，我先没有生成提案：\n${issues.map((i, n) => `${n + 1}. ${i}`).join("\n")}`,
      };
    }
    return { ok: true, data, warnings: [] };
  }

  return { ok: true, data, warnings: [] };
}

/**
 * What an administrator is told when an apply throws.
 *
 * Media-provider validation is a list of exactly what is wrong with a
 * configuration, and that list used to be dropped: the admin saw the class name,
 * the model saw the class name, and the second could only guess again. It is
 * the part of the error anyone can act on.
 */
export function describeApplyFailure(err: unknown): string {
  if (err instanceof MediaProviderValidationError) {
    return `配置不合法：${err.issues.join("；")}`;
  }
  if (err instanceof ZodError) return describeZodIssues(err);
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this a kind we know how to check?
 *
 * The row's `kind` is a plain string in SQLite, so a row written by an older
 * build — or edited by hand — can hold something this module has no rule for.
 * Guessing there would mean parsing with the wrong schema, so it is refused
 * before any of that.
 */
export function isProposalKind(value: unknown): value is ProposalKind {
  return typeof value === "string" && Object.hasOwn(SCHEMA_FOR, value);
}