/**
 * src/lib/assistant/credentials.ts
 *
 * Decides what the assistant's tools are allowed to spend.
 *
 * There are two ways a tool can reach this deployment, and the user picks:
 *
 *   - **account** — the assistant calls in-process as the signed-in user, using
 *     the credential they created and turned on themselves (see
 *     db/assistant-keys). No secret is involved at any point.
 *   - **key** — the user pastes one of their own `sk-relay-` keys, which is
 *     used for this request only and never stored. Still fully supported, and
 *     still the right choice for someone who wants the assistant limited to a
 *     key they can revoke by deleting it.
 *
 * The order below is the whole precedence rule, and it is deliberately
 * fail-closed: an explicit request wins, then the user's own switch, then
 * nothing. What is NOT here is any inference — no quietly reusing the
 * assistant's upstream key as if it were a gateway key. That shortcut made
 * "generate a picture" work without asking, which was the point, but it also
 * meant a feature the user had explicitly switched off kept running. A switch
 * that can be overridden by inference is not a switch.
 */
import { getAssistantCredential } from "../db/assistant-keys";
import { getUserById } from "../db/users";
import type { ApiKey, User } from "../db/types";

/** Which credential the caller asked for. */
export type CredentialMode = "account" | "key";

export interface AccountCredential {
  /** The `api_keys` row usage and quota are charged to. */
  apiKey: ApiKey;
  /** The account that owns it, carrying the quota pool and model whitelist. */
  user: User;
}

export type ResolvedCredential =
  | { kind: "account"; account: AccountCredential }
  | { kind: "key"; relayKey: string }
  | { kind: "none"; reason: "no_credential" | "switch_off" };

/** What the assistant's tools report when they have nothing to spend. */
export const NO_CREDENTIAL_MESSAGE =
  "助手没有可用于本部署的凭据，无法发起真实调用。两种改法：在助手设置里开启「用我的账号身份调用」" +
  "（由系统签发一把只有助手能用、你看不到明文的凭据），或者自己填一把 sk-relay- 开头的网关密钥。";

async function loadAccountCredential(userId: string): Promise<AccountCredential | null> {
  const credential = await getAssistantCredential(userId);
  // A row that exists but is switched off is the same as no row as far as a
  // tool is concerned: the user said no.
  if (!credential?.enabled) return null;
  const user = await getUserById(userId);
  if (!user) return null;
  return { apiKey: credential.key, user };
}

/**
 * Resolve the credential for one turn.
 *
 * An explicit `relayKey` is a deliberate per-request choice and outranks
 * everything, so a user who pastes a key is never silently switched onto the
 * account credential.
 */
export async function resolveToolCredential(args: {
  userId: string;
  /** Absent means the caller expressed no preference. */
  mode?: CredentialMode;
  relayKey?: string;
}): Promise<ResolvedCredential> {
  const pasted = args.relayKey?.trim();
  if (pasted) return { kind: "key", relayKey: pasted };

  if (args.mode === "key") {
    // They asked for the key path and did not supply one. Falling back to the
    // account credential here would be exactly the inference this module exists
    // to stop.
    return { kind: "none", reason: "no_credential" };
  }

  const account = await loadAccountCredential(args.userId);
  if (account) return { kind: "account", account };

  const existing = await getAssistantCredential(args.userId);
  return { kind: "none", reason: existing ? "switch_off" : "no_credential" };
}
