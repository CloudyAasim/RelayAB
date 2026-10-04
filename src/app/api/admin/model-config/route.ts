/**
 * POST /api/admin/model-config
 *
 *   Body: { models?: [...], notes?: Record<clientId, ModelNote> }
 *
 * Writes the per-model configuration of the documentation page straight into
 * the provider records, plus the documentation note.
 *
 * **Merge, never replace.** A page that sent a whole `modelConfigs` record
 * would delete every model added on the providers page between the operator
 * loading this one and pressing save. So each entry is applied to the one model
 * it names, and a key nobody mentioned is left exactly as it was.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getProviderById, updateProvider } from "@/lib/db/providers";
import { getSettings, updateSettings } from "@/lib/db/settings";

export const dynamic = "force-dynamic";

const ModelEntrySchema = z.object({
  providerId: z.string().min(1),
  clientId: z.string().min(1).max(200),
  upstreamId: z.string().min(1).max(200),
  displayName: z.string().max(120).optional(),
  contextLength: z.number().int().positive().max(100_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(100_000_000).optional(),
  inputCost: z.number().nonnegative().max(1_000_000).optional(),
  outputCost: z.number().nonnegative().max(1_000_000).optional(),
  // `null` clears the price back to "charge the input price". Absent is
  // not the same thing here: this route merges, so absent means "leave it".
  cachedInputCost: z.number().nonnegative().max(1_000_000).nullable().optional(),
  cacheWriteCost: z.number().nonnegative().max(1_000_000).nullable().optional(),
  enabled: z.boolean().optional(),
});

const NoteSchema = z
  .object({
    displayName: z.string().max(120).optional(),
    note: z.string().max(2000).optional(),
    tags: z.array(z.string().max(40)).max(8).optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

const BodySchema = z
  .object({
    models: z.array(ModelEntrySchema).max(500).optional(),
    notes: z.record(z.string().min(1).max(200), NoteSchema).optional(),
  })
  .strict();

function denied(): Response {
  return NextResponse.json(
    { ok: false, error: { code: "forbidden", message: "Admin required" } },
    { status: 403 },
  );
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") return denied();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON" } },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const { models = [], notes } = parsed.data;

  // Grouped so a provider with nine models is one read and one write, and so a
  // model nobody here mentions keeps whatever it had.
  const byProvider = new Map<string, typeof models>();
  for (const entry of models) {
    const bucket = byProvider.get(entry.providerId);
    if (bucket) bucket.push(entry);
    else byProvider.set(entry.providerId, [entry]);
  }

  const problems: string[] = [];

  for (const [providerId, entries] of byProvider) {
    const provider = await getProviderById(providerId);
    if (!provider) {
      problems.push(`找不到服务商 ${providerId}`);
      continue;
    }
    const configs = { ...(provider.modelConfigs ?? {}) };
    for (const { providerId: _p, ...entry } of entries) {
      const existing = configs[entry.clientId];
      configs[entry.clientId] = {
        // A mapping-only provider has no config behind the id; a save creates
        // one rather than dropping the model on the floor.
        upstreamId: entry.upstreamId,
        clientId: entry.clientId,
        ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
        contextLength: entry.contextLength ?? existing?.contextLength ?? 128000,
        maxOutputTokens: entry.maxOutputTokens ?? existing?.maxOutputTokens ?? 8192,
        inputCost: entry.inputCost ?? existing?.inputCost ?? 0,
        outputCost: entry.outputCost ?? existing?.outputCost ?? 0,
        enabled: entry.enabled ?? existing?.enabled ?? true,
        // Deleted, not set to undefined: `ModelConfigSchema` treats an absent
        // cache price as "charge the input price", and a stored `undefined`
        // disappears in JSON anyway.
        ...(entry.cachedInputCost === null
          ? {}
          : entry.cachedInputCost !== undefined
            ? { cachedInputCost: entry.cachedInputCost }
            : existing?.cachedInputCost !== undefined
              ? { cachedInputCost: existing.cachedInputCost }
              : {}),
        ...(entry.cacheWriteCost === null
          ? {}
          : entry.cacheWriteCost !== undefined
            ? { cacheWriteCost: entry.cacheWriteCost }
            : existing?.cacheWriteCost !== undefined
              ? { cacheWriteCost: existing.cacheWriteCost }
              : {}),
      };
      // `null` asked for the key to go. JSON.stringify drops `undefined`, so
      // it has to be deleted explicitly or the old price survives the save.
      if (entry.cachedInputCost === null) delete configs[entry.clientId].cachedInputCost;
      if (entry.cacheWriteCost === null) delete configs[entry.clientId].cacheWriteCost;
    }
    await updateProvider(providerId, { modelConfigs: configs });
  }

  if (notes !== undefined) {
    const { modelNotes } = await getSettings();
    const merged = { ...(modelNotes ?? {}) };
    for (const [clientId, note] of Object.entries(notes)) {
      if (Object.keys(note).length === 0) delete merged[clientId];
      else merged[clientId] = note;
    }
    await updateSettings({ modelNotes: merged });
  }

  if (problems.length) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: problems.join("；") } },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, data: { models: models.length, notes: notes ? Object.keys(notes).length : 0 } });
}
