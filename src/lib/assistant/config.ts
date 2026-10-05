/**
 * src/lib/assistant/config.ts
 *
 * One answer to "how is this person's assistant configured", in one place.
 *
 * This module exists because the same question was answered three times by three
 * pieces of code that each had their own idea, and they disagreed:
 *
 *  - the page decided `configured` from "is there a row",
 *  - the chat decided `canSend` from a different rule,
 *  - the request route decided the model from a third, and quietly picked the
 *    first available one when the browser sent none.
 *
 * The visible symptom was that a chosen model did not survive a refresh and an
 * unconfigured assistant still answered. Both are what disagreement looks like
 * from the outside: the model lived in component state on one path and in the
 * database on the other, and "pick something for me" was the fallback that
 * papered over the gap. A model nobody chose is a model nobody can reason about.
 *
 * **Pure, so it can be tested by calling it.** No database, no request, no
 * clock — the rules are the part worth pinning.
 */

/** Which credential the next turn spends. */
export type AssistantCredentialMode = "account" | "key";

/** Why a turn cannot be sent yet. `null` means it can. */
export type AssistantConfigMissing = "no-model" | "no-key" | "no-upstream";

/** The model's own parameters, as the request layer wants them. */
export interface AssistantModelParams {
  contextLength: number | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  /**
   * How hard the model thinks before answering, as the effort levels a vendor
   * publishes rather than a number. `null` is "do not send it", which is not the
   * same as the lowest level: one leaves the model to pick, the other picks for
   * it and changes both the latency and the bill.
   */
  reasoningEffort: AssistantReasoningEffort | null;
  /**
   * Whether the model thinks at all, in the vendor's own spelling. `null` is
   * "do not send it", which is the vendor's own choice and on some models the
   * most expensive one available.
   *
   * Separate from `reasoningEffort` because it is a different parameter: MiniMax
   * refuses a disabled request on the model that always thinks, and answers it
   * on the one that does not — so a single field could not be right for both.
   */
  thinkingType: AssistantThinkingType | null;
}

/**
 * How hard the model thinks, as whatever this model calls its levels.
 *
 * A string, not one of four names, and that is the whole point. The levels are
 * published per model and per vendor: some offer four, some three, some let you
 * switch thinking off entirely, and a model that does not think at all has no
 * levels to offer. A closed list here is a list that is wrong for most of the
 * models on the deployment, and the wrongness is silent — the request carries a
 * value the vendor either ignores or refuses.
 *
 * So it is free text, sent as typed, with a small set of suggestions when the
 * deployment knows them. Blank is "do not send it", which is a real answer and
 * not the same as any level.
 */
export type AssistantReasoningEffort = string;

/**
 * Whether the model thinks, in whatever the vendor calls its switch.
 *
 * Free text for the same reason the effort levels are: the spellings do not
 * agree between vendors, and a closed list here is a list that refuses the value
 * the model in front of it actually wants. Sent as the vendor wrote it, in the
 * vendor's own parameter.
 */
export type AssistantThinkingType = string;

/**
 * The spellings seen in the wild, offered as a starting point only.
 *
 * Suggestions, not a contract. Anything typed is sent as typed — see the type
 * above for why a closed set cannot be the answer.
 */
export const ASSISTANT_REASONING_SUGGESTIONS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export interface AssistantConfig {
  mode: AssistantCredentialMode;
  /**
   * The model that will answer, or `""` when none has been chosen.
   *
   * Never a fallback. There is deliberately no "whichever is first" here: the
   * caller must be able to state which model is writing the answers, and the
   * only way to guarantee that is to refuse the turn until they have.
   */
  model: string;
  /** Whether a turn can be sent right now. */
  ready: boolean;
  missing: AssistantConfigMissing | null;
  /** Whether an upstream key is stored. False on the account path by design. */
  hasApiKey: boolean;
  params: AssistantModelParams;
}

/** The subset of a stored row this needs. Passing the whole entity is fine. */
export interface AssistantConfigRow {
  credentialMode?: AssistantCredentialMode | null;
  /** The key path's model: a model id on the caller's own upstream. */
  model?: string | null;
  /** The account path's model: one of this deployment's own models. */
  accountModel?: string | null;
  encryptedApiKey?: string | null;
  baseUrl?: string | null;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  reasoningEffort?: AssistantReasoningEffort | null;
  thinkingType?: AssistantThinkingType | null;
}

/** No row at all is a real state: nothing has been configured yet. */
export type MaybeRow = AssistantConfigRow | null;

/**
 * Which mode a row is in.
 *
 * **A row written before this column existed is the key path.** It has a base
 * URL, a key and a model name in it — that is what the column means for every
 * row that has one. Reading NULL as "account" would silently move those people
 * to a different upstream the next time they opened the page.
 *
 * **No row at all is the account path.** Nothing has been configured, so there
 * is no key-path configuration to honour, and the account path is the one that
 * needs nothing but a model. It is *not* ready until that model is chosen.
 */
export function resolveMode(row: MaybeRow): AssistantCredentialMode {
  if (!row) return "account";
  return row.credentialMode === "account" ? "account" : "key";
}

/** The model the active mode will use, or `""`. */
export function resolveModel(row: MaybeRow): string {
  if (!row) return "";
  return (resolveMode(row) === "account" ? row.accountModel : row.model) ?? "";
}

export function resolveAssistantConfig(row: MaybeRow): AssistantConfig {
  const mode = resolveMode(row);
  const model = resolveModel(row).trim();
  const hasApiKey = Boolean(row?.encryptedApiKey);

  // Only the active mode's own requirement counts. Asking the key path for a
  // model it does not use is how a person ends up staring at two model fields
  // and a message about a field they cannot see.
  let missing: AssistantConfigMissing | null = null;
  if (!model) {
    missing = "no-model";
  } else if (mode === "key") {
    if (!row?.baseUrl?.trim()) missing = "no-upstream";
    else if (!hasApiKey) missing = "no-key";
  }

  return {
    mode,
    model,
    ready: missing === null,
    missing,
    hasApiKey,
    params: {
      contextLength: row?.contextLength ?? null,
      maxOutputTokens: row?.maxOutputTokens ?? null,
      temperature: row?.temperature ?? null,
      topP: row?.topP ?? null,
      reasoningEffort: row?.reasoningEffort ?? null,
    thinkingType: row?.thinkingType ?? null,
    },
  };
}

/**
 * The request body for `callAssistantModel`, and nothing else.
 *
 * Built here so that "the parameters are the caller's" is one implementation
 * rather than four call sites each deciding what `null` means. Absent means the
 * key is not on the body at all — which is not the same as being on it as
 * `null`, and is the whole reason the model picks its own default.
 */
export function modelParamsForRequest(params: AssistantModelParams): {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: AssistantReasoningEffort;
  thinkingType?: AssistantThinkingType;
} {
  return {
    // `!= null`, never a truthiness test: 0 is the most deterministic
    // temperature there is, and dropping it would answer with a random one.
    ...(params.maxOutputTokens != null ? { maxTokens: params.maxOutputTokens } : {}),
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.topP != null ? { topP: params.topP } : {}),
    ...(params.reasoningEffort != null ? { reasoningEffort: params.reasoningEffort } : {}),
    // Same rule, and the same reason it is a separate entry: this one being
    // absent has to mean "the vendor decides", not "thinking is on".
    ...(params.thinkingType != null ? { thinkingType: params.thinkingType } : {}),
  };
}
