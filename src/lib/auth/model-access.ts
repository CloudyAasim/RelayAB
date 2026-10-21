/**
 * src/lib/auth/model-access.ts
 *
 * One rule for "may this key call this model?", in one place.
 *
 * There are two places that have to answer that question and they must not
 * disagree:
 *
 *   - the proxy, which **enforces** it (see `checkKeyStatus`);
 *   - the model catalogue, which **advertises** it (`/v1/models`,
 *     `/anthropic/v1/models`, and the assistant's own pre-flight check).
 *
 * The permission is the intersection of two whitelists: the account owner's
 * and the key's own. The owner's is the outer bound — a key can narrow it but
 * never widen it — and an empty list at either level means "no additional
 * restriction here".
 *
 * They used to be two rules, and the catalogue had the looser one. A user
 * whose account was restricted to one model was still shown the whole
 * deployment's catalogue, because the catalogue only looked at the key's
 * whitelist, and an unrestricted key is the normal case. So a client picked a
 * model off the list, called it, and got `403 model_not_allowed` — the
 * deployment advertised something it then refused. The assistant's account
 * path had the same gap: its pre-flight check passed, and the turn died
 * upstream instead of being refused by name, with a message about the model
 * rather than about the account it belonged to.
 */
import type { ApiKey, User } from "../db/types";

/**
 * Whether this key, acting for this owner, may call this model.
 *
 * An absent owner means the account could not be resolved, and the caller's
 * own rule in that case is "the owner does not restrict anything" — the same
 * answer the proxy gives when it has no owner to consult.
 */
export function modelAllowedFor(
  model: string,
  key: ApiKey,
  owner?: User | null,
): boolean {
  const ownerAllows =
    !owner || owner.allowedModels.length === 0 || owner.allowedModels.includes(model);
  const keyAllows = key.allowedModels.length === 0 || key.allowedModels.includes(model);
  return ownerAllows && keyAllows;
}
