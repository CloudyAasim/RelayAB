/**
 * src/lib/assistant/tools.ts
 *
 * What the assistant can actually do.
 *
 * Two tiers, decided by the caller's role:
 *
 *  - **Everyone** can look at the model catalogue, test a model through the
 *    gateway with their own key, check their own quota, and read the
 *    deployment notes.
 *  - **Admins** additionally get read access to provider configuration, the
 *    ability to probe a candidate base URL with a *stored* key, and the
 *    ability to propose a change.
 *
 * The last one is the important boundary: `propose_*` never writes. It records
 * an intent in `assistant_actions` and hands back a rendered diff. Nothing in
 * this file mutates provider configuration on the assistant's say-so — the only
 * path that does is the confirm endpoint, which a human calls.
 */
import { z } from "zod";

import type { AssistantToolDef } from "./client";
import { probeUpstream } from "./client";
import {
  getMediaProviderById,
  listMediaProviders,
  resolveMediaProviderForModel,
} from "../db/media-providers";
import {
  getSearchProviderById,
  listSearchProviders,
} from "../db/search-providers";
import { effectiveEndpoint, effectiveSearchConfig } from "../search/effective";
import { SEARCH_TEMPLATES } from "../search/templates";
import { readSearchProtocolDoc } from "../docs/search-protocol-doc";
import { readTextProtocolDoc } from "../docs/text-protocol-doc";
import { getProviderById, listProviders } from "../db/providers";
import { MODEL_PURPOSES } from "../db/types";
import { collectVoiceCatalogue } from "../media/voices";
import { listUsers, getUserById } from "../db/users";
import { getAssistantCredential } from "../db/assistant-keys";
import { listApiKeysByUser, listApiKeyIdsForUsage } from "../db/keys";
import { aggregateByKeyMany, listRecentUsage } from "../db/usage";
import {
  createAssistantAction,
  getAssistantAction,
  listAssistantActions,
  withdrawAssistantAction,
} from "../db/assistant";
import {
  auditModelConfigs,
  describeFindings,
  findingKey,
  partitionFindings,
  renderFindingsRefusal,
  type Finding,
} from "../providers/config-audit";
import { checkProposal, type ProposalKind } from "./proposal-validation";
import { describeRoutes, routesOfProvider } from "./provider-routing";
import { providerDrift } from "../media/drift";
import { MEDIA_TEMPLATES } from "../media/seeds";
import type { MediaSpec } from "../media/spec";
import { readProtocolDoc } from "../docs/protocol-doc";
import { getPublicUrl } from "../config";
import { knownModelOrDefault } from "../providers/known-models";
import { decryptSecret } from "../crypto/secrets";
import { renderProviderDiff, renderMediaDiff, renderSearchProviderDiff, renderDocPagesDiff } from "./diff";
import { ASSISTANT_PAGE_READ_LIMIT } from "./docs-reader";
import { getSettings } from "../db/settings";
import { parseTextSpec, readTextSpec } from "../protocol/text-spec";
import { activeModeOf, validateTextSpecs, SURFACES, faceOf } from "../protocol/text-specs";
import {
  TEXT_PROTOCOL_PRESETS,
  TEXT_PROTOCOL_LABELS,
  CONFIGURABLE_PROTOCOLS,
} from "../protocol/text-protocols";
import { DEPLOYMENT_NOTES } from "./deployment-notes";
import { WebSearchError, MAX_SEARCH_RESULTS, type SearchBackend } from "./web-search";
import { DEFAULT_WEB_SEARCH_LIMIT } from "../search/usage";
import { resolveSearchBackendForAccount } from "../search/resolve";
import { attributionKeyFor, runSearch } from "../search/billing";
import { loadSearchConfig } from "../search/config";
import { fetchPage, WebFetchError } from "./web-fetch";
import { createDocReader } from "./docs-reader";
import { DEFAULT_LOCALE, type Locale } from "../i18n/dict";
import { toolDescription, toolRefusal } from "./tool-text";
import type { DocPage } from "../docs/custom";
import { NO_CREDENTIAL_MESSAGE, type AccountCredential } from "./credentials";
import { executeMediaRequest, resultItems } from "../media/handler";
import { buildModelCatalog } from "../docs/catalog";
import { proxyChatCompletion } from "../proxy/chat";
import { getAssistantArtifact } from "../db/assistant-artifacts";
import type { ArtifactKind } from "../db/assistant-artifacts";
import type { MessageAttachment } from "./schema";
import type { AuthedUser } from "../auth/session";

export interface ToolContext {
  user: AuthedUser;
  /** The caller's own `sk-relay-…` key, supplied per request and never stored. */
  relayKey?: string;
  /**
   * The account-authenticated path: a credential the user created and switched
   * on, plus the account it spends. Tools call the proxy in-process with it, so
   * no secret is ever involved. See ./credentials for why nothing here is
   * inferred.
   */
  account?: AccountCredential;
  /**
   * Where this gateway is reachable, resolved by the route before the tool loop
   * starts. See `gatewayBase()`.
   */
  gatewayBase?: string;
  /**
   * The files attached to the turn in flight.
   *
   * Here so that "use the picture the user just sent me" is something a tool
   * can be told, rather than something the model would have to paste a
   * megabyte of base64 to express. See `resolveReferenceImage`.
   */
  attachments?: MessageAttachment[];
  /**
   * The reader's language, resolved by the route before the stream opened.
   *
   * Passed in rather than read here because the tool loop runs inside a stream
   * callback, where `next/headers` no longer resolves — the same constraint the
   * route already works around for the public URL. A documentation tool that
   * answered in the wrong language would be worse than none.
   */
  locale?: Locale;
  /**
   * Whether the caller may read the admin documentation.
   *
   * The admin docs describe this deployment's internals — providers, quota,
   * routing. A regular user reading them through a model that summarises on
   * request is a different thing from an admin who can already open the page.
   */
  canReadAdminDocs?: boolean;
  /**
   * The operator's own documentation pages, resolved by the route.
   *
   * Same reason as the locale: they come from the settings table, and the tool
   * loop runs where `next/headers` no longer resolves. Passed in so one turn
   * reads them once rather than once per call.
   */
  docPages?: DocPage[];
  /**
   * Whether this turn may use `web_search`.
   *
   * The composer's per-conversation toggle travels here. Hiding the tool from
   * the definitions is the first half; a model can still emit a call by name,
   * so `executeTool` refuses when this is false. `undefined` means on, which is
   * what every non-assistant caller wants.
   */
  webSearchEnabled?: boolean;
  /**
   * Why this turn may not search.
   *
   * Three reasons and three different remedies, so the model has to be told
   * which one it is: the user switched it off for this conversation, the
   * administrator switched the feature off for the deployment, or the
   * deployment has no search backend at all. Without the reason the model
   * says "please turn on the switch next to the input box" — and there is no
   * such switch when the administrator is the one who turned it off.
   */
  webSearchDisabledReason?: "user" | "admin" | "no_backend";
  /**
   * How many results the caller asked for, before the per-provider cap.
   *
   * A user preference rather than an operator setting: six is the default, and
   * the operator's ceiling is `MAX_SEARCH_RESULTS`.
   */
  webSearchLimit?: number;
}

/** A media file the tool produced, for the caller to store and hand a URL back. */
export interface RawArtifact {
  kind: ArtifactKind;
  contentType: string;
  /** The upstream's own link, when it had one. Nothing is copied in that case. */
  url?: string;
  /** Base64, for results the vendor returned inline (images, audio). */
  base64?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /**
   * Media produced, on a side channel rather than inside `content`.
   *
   * That placement is the whole point. A base64 image is megabytes, and a CDN
   * link is a months-long capability handed to a model that will paste it into
   * prose; either one inside `content` would end up in the model's context and
   * in the stored transcript. The turn loop persists these and writes short
   * references into the content instead, so a bug that skipped that step would
   * lose the media rather than leak it.
   */
  artifacts?: RawArtifact[];
  /**
   * Set when this call was a question to the person, not an action on a system.
   *
   * The turn loop reads it and ends the turn there. That is the whole point:
   * a stream cannot carry an answer back in, so a turn that asked a question
   * and then kept working would be the model talking to itself — and the one
   * place that pattern has already bitten is the free-model gate, where the
   * only way out was for the user to retype `confirmFindings` into a fresh
   * message. Asking is how the answer comes back.
   */
  askedUser?: UserQuestion;
}

/** A question put to the person in front of the screen. */
export interface UserQuestion {
  question: string;
  /** Offered as buttons. Empty means the answer is entirely free-form. */
  options?: string[];
  /** Placeholder for the free-form box. */
  placeholder?: string;
  /** Shown under the question — what the answer will be used for. */
  hint?: string;
}

/**
 * Vendor-mandated values the caller must not be allowed to omit.
 *
 * Each was found by calling the endpoint rather than by reading the spec:
 * MiniMax `t2a_v2` rejects a request with no `voice_id`, both video specs
 * require a duration (V1 accepts only 6 and 10), and V2 also requires an
 * explicit, non-adaptive ratio. A model told the argument was optional will
 * leave it out, and the resulting error names a field it never touched.
 */
const DEFAULT_TTS_VOICE = "female-shaonv";
const DEFAULT_VIDEO_DURATION = 6;
const DEFAULT_VIDEO_RATIO = "16:9";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Where the gateway is reachable from the server.
 *
 * `config.getPublicUrl()` alone is not enough here. It reads
 * RELAY_PUBLIC_URL, then VERCEL_URL, then localhost — and a self-hosted
 * deployment behind nginx usually sets neither, so it answered
 * "http://localhost:3000" and every `test_gateway_model` call died with
 * "fetch failed" from inside the container.
 *
 * The route resolves the real base with `resolvePublicUrl()`, which can also
 * read the incoming Host header, and passes it in. The config fallback stays
 * for callers outside a request scope (the tests) and is the right answer
 * whenever RELAY_PUBLIC_URL is set, which is still the configuration worth
 * recommending: header-derived addressing is an implicit dependency on the
 * proxy forwarding X-Forwarded-*.
 */
function gatewayBase(ctx: ToolContext): string {
  return ctx.gatewayBase ?? getPublicUrl();
}
/** Parse tool arguments; a model that sends malformed JSON should not 500. */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A refusal, in the reader's language.
 *
 * The wording lives in `tool-text.ts` and is fetched by key, so a refusal the
 * user reads in a tool card follows the locale the route resolved. The context
 * is what carries that locale — there is no module-level "current language"
 * here, because two conversations can be in flight at once.
 *
 * A missing key returns the key itself: an empty refusal is invisible, and one
 * that reads as its own key is a bug somebody can see.
 */
function fail(ctx: ToolContext, key: string, vars?: Record<string, string | number>): ToolResult {
  return { ok: false, content: toolRefusal(ctx.locale, key, vars) };
}

function ok(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value, null, 2) };
}

/**
 * The same, without the indentation.
 *
 * For a payload whose size is a concern: a full media-spec listing is ~15 KB
 * pretty-printed and ~11 KB compact, and the turn loop truncates a tool result.
 * A truncation lands wherever it lands, and where it landed last time was
 * inside a video spec's `async.poll` — so the model copied a spec with no
 * `statusMap` and the approval rejected it.
 *
 * Indentation is for a person reading a terminal. A model reads JSON.
 */
function okCompact(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

/**
 * The tools everybody gets.
 *
 * A function rather than a constant, because the descriptions are words and
 * the words have to follow the reader's language. The translation function is
 * handed in rather than read from a module-level variable: two conversations
 * can be in flight at once, and a shared "current locale" would have one of
 * them describing the tools in the wrong language.
 */
function userTools(t: (key: string) => string): AssistantToolDef[] {
  return [
  {
    type: "function",
    function: {
      name: "ask_user",
      description: t("ask_user"),
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: t("ask_user.question"),
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: t("ask_user.options"),
          },
          placeholder: {
            type: "string",
            description: t("ask_user.placeholder"),
          },
          hint: {
            type: "string",
            description: t("ask_user.hint"),
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_gateway_models",
      description: t("list_gateway_models"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "test_gateway_model",
      description: t("test_gateway_model"),
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: t("test_gateway_model.model") },
          prompt: { type: "string", description: t("test_gateway_model.prompt") },
        },
        required: ["model"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_usage",
      description: t("get_my_usage"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deployment_notes",
      description: t("get_deployment_notes"),
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: t("get_deployment_notes.topic") },
        },
        additionalProperties: false,
      },
    },
  },

  // Media generation needs nothing an ordinary account does not have, so these
  // sit in the user tier: a gateway key and a model id. They were added to the
  // admin list first by mistake, which would have meant a regular user could not
  // generate an image with a key that already works.
  {
    type: "function",
    function: {
      name: "web_search",
      description: t("web_search"),
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: t("web_search.query"),
          },
          limit: {
            type: "integer",
            description: t("web_search.limit"),
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: t("fetch_page"),
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: t("fetch_page.url") },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_docs",
      description: t("read_docs"),
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: t("read_docs.topic"),
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: t("generate_image"),
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: t("generate_image.model") },
          prompt: { type: "string", description: t("generate_image.prompt") },
          size: { type: "string", description: t("generate_image.size") },
          ratio: {
            type: "string",
            description: t("generate_image.ratio"),
          },
          image: {
            type: "string",
            description: t("generate_image.image"),
          },
        },
        required: ["model", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_voices",
      description: t("list_voices"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_speech",
      description: t("generate_speech"),
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: t("generate_speech.model") },
          input: { type: "string", description: t("generate_speech.input") },
          voice: {
            type: "string",
            description: t("generate_speech.voice"),
          },
        },
        required: ["model", "input"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transcribe_audio",
      description: t("transcribe_audio"),
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: t("transcribe_audio.model") },
          audio: {
            type: "string",
            description: t("transcribe_audio.audio"),
          },
          language: {
            type: "string",
            description: t("transcribe_audio.language"),
          },
        },
        required: ["audio"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description: t("generate_video"),
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: t("generate_video.model") },
          prompt: { type: "string", description: t("generate_video.prompt") },
          duration: { type: "number", description: t("generate_video.duration") },
          ratio: { type: "string", description: t("generate_video.ratio") },
        },
        required: ["model", "prompt"],
        additionalProperties: false,
      },
    },
  },
  ];
}

/**
 * The tools only administrators get.
 *
 * Same shape and same reason as {@link userTools}: the wording follows the
 * reader, the structure does not change with it.
 */
function adminTools(t: (key: string) => string): AssistantToolDef[] {
  return [
  {
    type: "function",
    function: {
      name: "audit_provider_config",
      description: t("audit_provider_config"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: t("audit_provider_config.providerId") },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_model_configs_update",
      description: t("propose_model_configs_update"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: t("propose_model_configs_update.providerId") },
          summary: { type: "string", description: t("propose_model_configs_update.summary") },
          models: {
            type: "object",
            description: t("propose_model_configs_update.models"),
            additionalProperties: {
              type: "object",
              properties: {
                displayName: { type: "string" },
                upstreamId: { type: "string" },
                purpose: {
                  type: "string",
                  enum: ["chat", "embedding", "rerank", "moderation"],
                  description: t("propose_model_configs_update.models.purpose"),
                },
                contextLength: { type: "integer", description: t("propose_model_configs_update.models.contextLength") },
                maxOutputTokens: { type: "integer" },
                reasoningLevels: {
                  type: "array",
                  items: { type: "string" },
                  description: t("propose_model_configs_update.models.reasoningLevels"),
                },
                reasoningEffortSupported: {
                  type: "boolean",
                  description: t("propose_model_configs_update.models.reasoningEffortSupported"),
                },
                thinkingSwitchSupported: {
                  type: "boolean",
                  description: t("propose_model_configs_update.models.thinkingSwitchSupported"),
                },
                inputCost: { type: "number", description: t("propose_model_configs_update.models.inputCost") },
                outputCost: { type: "number", description: t("propose_model_configs_update.models.outputCost") },
                cachedInputCost: {
                  type: "number",
                  description: t("propose_model_configs_update.models.cachedInputCost"),
                },
                cacheWriteCost: {
                  type: "number",
                  description: t("propose_model_configs_update.models.cacheWriteCost"),
                },
                enabled: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
          confirmFindings: {
            type: "array",
            items: { type: "string" },
            description: t("propose_model_configs_update.confirmFindings"),
          },
        },
        required: ["providerId", "models"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "withdraw_proposal",
      description: t("withdraw_proposal"),
      parameters: {
        type: "object",
        properties: {
          actionId: { type: "string", description: t("withdraw_proposal.actionId") },
          reason: { type: "string", description: t("withdraw_proposal.reason") },
        },
        required: ["actionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_proposals",
      description: t("list_my_proposals"),
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: t("list_my_proposals.status"),
            enum: ["pending", "applied", "rejected", "failed"],
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_providers",
      description: t("list_providers"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "probe_provider_host",
      description: t("probe_provider_host"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: t("probe_provider_host.providerId") },
          baseUrl: { type: "string", description: t("probe_provider_host.baseUrl") },
          path: { type: "string", description: t("probe_provider_host.path") },
        },
        required: ["providerId", "baseUrl"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_media_providers",
      description: t("list_media_providers"),
      parameters: {
        type: "object",
        properties: {
          full: {
            type: "boolean",
            description: t("list_media_providers.full"),
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_media_spec_reference",
      description: t("get_media_spec_reference"),
      parameters: {
        type: "object",
        properties: {
          what: {
            type: "string",
            enum: ["protocol", "templates"],
            description: t("get_media_spec_reference.what"),
          },
          capability: {
            type: "string",
            description: t("get_media_spec_reference.capability"),
          },
          offset: {
            type: "integer",
            description: t("get_media_spec_reference.offset"),
          },
          limit: {
            type: "integer",
            description: t("get_media_spec_reference.limit"),
          },
        },
        required: ["what"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_provider_update",
      description: t("propose_provider_update"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: t("propose_provider_update.providerId") },
          summary: { type: "string", description: t("propose_provider_update.summary") },
          baseUrl: { type: "string" },
          anthropicBaseUrl: { type: "string" },
          anthropicMode: { type: "string", enum: ["native", "translated"] },
          openaiEnabled: { type: "boolean" },
          anthropicEnabled: { type: "boolean" },
          enabled: { type: "boolean" },
          priority: {
            type: "integer",
            description: t("propose_provider_update.priority"),
          },
          activeMode: {
            type: "string",
            enum: ["simple", "advanced"],
            description: t("propose_provider_update.activeMode"),
          },
          modelMapping: {
            type: "object",
            description: t("propose_provider_update.modelMapping"),
            additionalProperties: { type: "string" },
          },
          textSpecs: {
            type: "array",
            description: t("propose_provider_update.textSpecs"),
            items: {
              type: "object",
              properties: {
                specVersion: { type: "integer" },
                protocol: { type: "string" },
                parameters: { type: "object" },
                request: { type: "object" },
                response: { type: "object" },
                errors: { type: "array", items: { type: "object" } },
                limits: { type: "object" },
              },
              required: ["specVersion", "protocol"],
              additionalProperties: true,
            },
          },
          headers: {
            type: "object",
            description: t("propose_provider_update.headers"),
            additionalProperties: { type: "string" },
          },
          upstreamFormat: {
            type: "string",
            description: t("propose_provider_update.upstreamFormat"),
          },
          confirmFindings: {
            type: "array",
            description: t("propose_provider_update.confirmFindings"),
            items: { type: "string" },
          },
        },
        required: ["providerId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_text_protocols",
      description: t("list_text_protocols"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_text_spec_reference",
      description: t("get_text_spec_reference"),
      parameters: {
        type: "object",
        properties: {
          what: {
            type: "string",
            enum: ["protocol", "presets"],
            description: t("get_text_spec_reference.what"),
          },
          protocol: {
            type: "string",
            description: t("get_text_spec_reference.protocol"),
          },
          offset: {
            type: "integer",
            description: t("get_text_spec_reference.offset"),
          },
          limit: {
            type: "integer",
            description: t("get_text_spec_reference.limit"),
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_model_config_update",
      description: t("propose_model_config_update"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string", description: t("propose_model_config_update.providerId") },
          clientId: { type: "string", description: t("propose_model_config_update.clientId") },
          summary: { type: "string", description: t("propose_model_config_update.summary") },
          displayName: { type: "string" },
          upstreamId: { type: "string" },
          purpose: {
            type: "string",
            enum: ["chat", "embedding", "rerank", "moderation"],
            description: t("propose_model_config_update.purpose"),
          },
          contextLength: { type: "integer", description: t("propose_model_config_update.contextLength") },
          maxOutputTokens: { type: "integer" },
          reasoningLevels: {
            type: "array",
            items: { type: "string" },
            description: t("propose_model_config_update.reasoningLevels"),
          },
          reasoningEffortSupported: {
            type: "boolean",
            description: t("propose_model_config_update.reasoningEffortSupported"),
          },
          thinkingSwitchSupported: {
            type: "boolean",
            description: t("propose_model_config_update.thinkingSwitchSupported"),
          },
          inputCost: { type: "number", description: t("propose_model_config_update.inputCost") },
          outputCost: { type: "number", description: t("propose_model_config_update.outputCost") },
          cachedInputCost: {
            type: "number",
            description: t("propose_model_config_update.cachedInputCost"),
          },
          cacheWriteCost: {
            type: "number",
            description: t("propose_model_config_update.cacheWriteCost"),
          },
          enabled: { type: "boolean", description: t("propose_model_config_update.enabled") },
          confirmFindings: {
            type: "array",
            items: { type: "string" },
            description: t("propose_model_config_update.confirmFindings"),
          },
        },
        required: ["providerId", "clientId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_doc_pages",
      description: t("propose_doc_pages"),
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: t("propose_doc_pages.summary") },
          pages: {
            type: "array",
            description: t("propose_doc_pages.pages"),
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: t("propose_doc_pages.pages.id") },
                title: { type: "string" },
                body: { type: "string", description: t("propose_doc_pages.pages.body") },
                hidden: { type: "boolean", description: t("propose_doc_pages.pages.hidden") },
                order: { type: "integer" },
              },
              required: ["id", "title", "body"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "pages"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_doc_pages",
      description: t("list_doc_pages"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_media_provider_update",
      description: t("propose_media_provider_update"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string" },
          summary: { type: "string", description: t("propose_media_provider_update.summary") },
          baseUrl: { type: "string" },
          models: {
            type: "object",
            description: t("propose_media_provider_update.models"),
            additionalProperties: true,
          },
          specEdits: {
            type: "array",
            description: t("propose_media_provider_update.specEdits"),
            items: {
              type: "object",
              properties: {
                index: { type: "integer", description: t("propose_media_provider_update.specEdits.index") },
                displayName: { type: "string" },
                enabled: { type: "boolean" },
                models: { type: "array", items: { type: "string" } },
              },
              required: ["index"],
              additionalProperties: true,
            },
          },
          specs: {
            type: "array",
            description: t("propose_media_provider_update.specs"),
            items: { type: "object" },
          },
          enabled: { type: "boolean" },
        },
        required: ["providerId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_provider_create",
      description: t("propose_provider_create"),
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: t("propose_provider_create.name") },
          kind: { type: "string", enum: ["openai", "anthropic"], description: t("propose_provider_create.kind") },
          summary: { type: "string", description: t("propose_provider_create.summary") },
          baseUrl: { type: "string", description: t("propose_provider_create.baseUrl") },
          upstreamFormat: {
            type: "string",
            enum: ["responses", "chat", "anthropic", "gemini"],
            description: t("propose_provider_create.upstreamFormat"),
          },
          priority: { type: "integer", description: t("propose_provider_create.priority") },
          modelMapping: {
            type: "object",
            description: t("propose_provider_create.modelMapping"),
            additionalProperties: { type: "string" },
          },
          openaiEnabled: {
            type: "boolean",
            description: t("propose_provider_create.openaiEnabled"),
          },
          anthropicEnabled: { type: "boolean", description: t("propose_provider_create.anthropicEnabled") },
          anthropicMode: {
            type: "string",
            enum: ["native", "translated"],
            description: t("propose_provider_create.anthropicMode"),
          },
          anthropicBaseUrl: {
            type: "string",
            description: t("propose_provider_create.anthropicBaseUrl"),
          },
          headers: {
            type: "object",
            description: t("propose_provider_create.headers"),
            additionalProperties: { type: "string" },
          },
          textSpecs: {
            type: "array",
            description: t("propose_provider_create.textSpecs"),
            items: {
              type: "object",
              properties: {
                specVersion: { type: "integer" },
                protocol: { type: "string" },
                parameters: { type: "object" },
                request: { type: "object" },
                response: { type: "object" },
                errors: { type: "array", items: { type: "object" } },
                limits: { type: "object" },
              },
              required: ["specVersion", "protocol"],
              additionalProperties: true,
            },
          },
          activeMode: {
            type: "string",
            enum: ["simple", "advanced"],
            description: t("propose_provider_create.activeMode"),
          },
          confirmFindings: {
            type: "array",
            description: t("propose_provider_create.confirmFindings"),
            items: { type: "string" },
          },
        },
        required: ["name", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_media_provider_create",
      description: t("propose_media_provider_create"),
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string", description: t("propose_media_provider_create.summary") },
          baseUrl: { type: "string" },
          priority: { type: "integer" },
          models: {
            type: "object",
            description: t("propose_media_provider_create.models"),
            additionalProperties: { type: "object" },
          },
          specs: {
            type: "array",
            description: t("propose_media_provider_create.specs"),
            items: { type: "object" },
          },
        },
        required: ["name", "summary", "models"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_search_providers",
      description: t("list_search_providers"),
      parameters: {
        type: "object",
        properties: {
          full: {
            type: "boolean",
            description: t("list_search_providers.full"),
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_search_spec_reference",
      description: t("get_search_spec_reference"),
      parameters: {
        type: "object",
        properties: {
          what: {
            type: "string",
            enum: ["protocol", "templates"],
            description: t("get_search_spec_reference.what"),
          },
          offset: {
            type: "integer",
            description: t("get_search_spec_reference.offset"),
          },
          limit: {
            type: "integer",
            description: t("get_search_spec_reference.limit"),
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_search_provider_create",
      description: t("propose_search_provider_create"),
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: t("propose_search_provider_create.name") },
          kind: {
            type: "string",
            description: t("propose_search_provider_create.kind"),
          },
          summary: { type: "string", description: t("propose_search_provider_create.summary") },
          baseUrl: {
            type: "string",
            description: t("propose_search_provider_create.baseUrl"),
          },
          apiKeyHint: {
            type: "string",
            description: t("propose_search_provider_create.apiKeyHint"),
          },
          priority: { type: "integer", description: t("propose_search_provider_create.priority") },
          creditsPerCall: {
            type: "integer",
            description: t("propose_search_provider_create.creditsPerCall"),
          },
          enabled: { type: "boolean" },
          spec: {
            type: "object",
            description: t("propose_search_provider_create.spec"),
            additionalProperties: true,
          },
        },
        required: ["name", "kind", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_search_provider_update",
      description: t("propose_search_provider_update"),
      parameters: {
        type: "object",
        properties: {
          providerId: { type: "string" },
          summary: { type: "string", description: t("propose_search_provider_update.summary") },
          kind: { type: "string" },
          baseUrl: { type: "string", description: t("propose_search_provider_update.baseUrl") },
          enabled: { type: "boolean" },
          priority: { type: "integer" },
          creditsPerCall: { type: "integer" },
          spec: {
            type: "object",
            description: t("propose_search_provider_update.spec"),
            additionalProperties: true,
          },
        },
        required: ["providerId", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_users",
      description: t("list_users"),
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  ];
}

/**
 * The tool catalogue the model is offered, in the reader's language.
 *
 * The locale is the last argument and defaults to the deployment's own
 * language, so every caller that predates the switch keeps exactly the
 * catalogue it had before. The descriptions come out of one table in
 * `tool-text.ts` — the shape stays here, the wording lives there.
 */
export function toolDefinitions(
  isAdmin: boolean,
  opts: { webSearch?: boolean } = {},
  locale: Locale = DEFAULT_LOCALE,
): AssistantToolDef[] {
  const t = (key: string): string => toolDescription(locale, key);
  const list = isAdmin ? [...userTools(t), ...adminTools(t)] : [...userTools(t)];
  // `undefined` means on: every caller that has no opinion keeps today's
  // catalogue, and only an explicit "this turn has search off" removes it.
  return opts.webSearch === false
    ? list.filter((tool) => tool.function.name !== "web_search")
    : list;
}

/**
 * Separates the machine-readable question from the prose meant for the model.
 *
 * The tool result is stored as a `tool` row, and that row is the only place a
 * question survives a reload — so it carries both, with this between them. The
 * model reads it as an HTML comment it will not restate; the client reads
 * after it as JSON.
 */
export const ASK_USER_MARKER = "<!-- ask_user -->";

/**
 * Put a question to the person, and stop there.
 *
 * `askedUser` is what the turn loop watches for. It does not block and it does
 * not wait — a stream cannot carry an answer back in, so the turn ends and the
 * reply arrives as the next message. What the model is told is deliberately
 * blunt, because the failure this exists to prevent is a model that asked a
 * question and then answered it itself.
 *
 * The question is also written into the transcript, so the next turn can see
 * what it asked rather than only that it asked.
 */
function askUser(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const parsed = z
    .object({
      question: z.string().trim().min(1).max(500),
      options: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
      placeholder: z.string().trim().max(200).optional(),
      hint: z.string().trim().max(300).optional(),
    })
    .safeParse(args);
  if (!parsed.success) {
    return fail(ctx, "askUserNeedsQuestion");
  }
  const { question, options, placeholder, hint } = parsed.data;

  return {
    ok: true,
    askedUser: {
      question,
      ...(options?.length ? { options } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(hint ? { hint } : {}),
    },
    // Written so that continuing to act on a guess is the harder reading.
    content: [
      "已经向用户提问，本轮到此结束。",
      "",
      `你问的是：${question}`,
      "",
      "不要调用任何其他工具，不要接着往下做，也不要假设一个答案继续。" +
        "用户的回答会在下一轮到达，届时再继续。",
      "",
      // Carried so the question survives a reload. This tool call is persisted
      // as a `tool` row, and without this the client would rebuild the thread
      // from the database and find nothing to answer — a question that
      // vanishes on refresh is worse than one that is never asked.
      ASK_USER_MARKER + JSON.stringify({ question, options, placeholder, hint }),
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const args = parseArgs(rawArgs);
  const isAdmin = ctx.user.role === "admin";

  switch (name) {
    // ---- shared --------------------------------------------------------
    case "ask_user":
      return askUser(args, ctx);
    case "list_gateway_models":
      return listGatewayModels(ctx);
    case "test_gateway_model":
      return testGatewayModel(args, ctx);
    case "get_my_usage":
      return getMyUsage(ctx);
    case "get_deployment_notes":
      return ok(DEPLOYMENT_NOTES(args.topic));
    case "read_docs":
      return readDocsTool(args, ctx);
    case "fetch_page":
      return fetchPageTool(args, ctx);
    case "web_search":
      // Hiding the definition is not enough: a model that has seen the tool in
      // an earlier turn can emit the name anyway, and this turn said no.
      //
      // The reason matters, because the three ways of being off call for three
      // different things from the user: their own switch, the administrator's
      // switch, and a deployment with no backend at all. Telling somebody to
      // "turn on the switch next to the input box" when the administrator
      // turned the feature off is asking them for something that is not there.
      if (ctx.webSearchEnabled === false) {
        return fail(ctx, webSearchOffKey(ctx.webSearchDisabledReason));
      }
      return webSearchTool(args, ctx);
    case "generate_image":
      return mediaGenerate(args, ctx, "image");
    case "generate_speech":
      return mediaGenerate(args, ctx, "speech");
    case "transcribe_audio":
      return transcribeAudio(args, ctx);
    case "generate_video":
      return mediaGenerate(args, ctx, "video");

    // ---- admin only ----------------------------------------------------
    case "audit_provider_config":
      return auditProviderConfig(args, ctx);
    case "propose_model_configs_update":
      return proposeModelConfigsUpdate(args, ctx);
    case "withdraw_proposal":
      return withdrawProposal(args, ctx);
    case "list_my_proposals":
      return listMyProposals(args, ctx);
    case "list_providers":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return listProvidersTool();
    case "list_text_protocols":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return listTextProtocolsTool();
    case "get_text_spec_reference":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return textSpecReferenceTool(args, ctx);
    case "probe_provider_host":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return probeProviderHost(args, ctx);
    case "list_media_providers":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return listMediaProvidersTool(args.full === true);
    case "get_media_spec_reference":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return mediaSpecReferenceTool(args, ctx);
    case "list_search_providers":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return listSearchProvidersTool(args.full === true);
    case "get_search_spec_reference":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return searchSpecReferenceTool(args, ctx);
    case "list_voices":
      // Not admin-only: the voice list is a read about what this account can
      // speak with, exactly like `/v1/audio/voices`, and gating it would make
      // the assistant unable to answer the question the user asked it.
      return listVoicesTool();
    case "propose_provider_update":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeProviderUpdate(args, ctx);
    case "propose_model_config_update":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeModelConfigUpdate(args, ctx);
    case "list_doc_pages":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return listDocPagesTool();
    case "propose_doc_pages":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeDocPages(args, ctx);
    case "propose_media_provider_update":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeMediaProviderUpdate(args, ctx);
    case "propose_provider_create":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeProviderCreate(args, ctx);
    case "propose_media_provider_create":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeMediaProviderCreate(args, ctx);
    case "propose_search_provider_create":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeSearchProviderCreate(args, ctx);
    case "propose_search_provider_update":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return proposeSearchProviderUpdate(args, ctx);
    case "list_users":
      if (!isAdmin) return fail(ctx, "adminOnly");
      return listUsersTool();

    default:
      return fail(ctx, "unknownTool", { tool: name });
  }
}

/**
 * What this gateway serves, and what each model can actually take.
 *
 * The numbers used to be missing, and the gap was reported as a permissions
 * problem: a user asked for the context windows, got a list of names, read the
 * prose page that describes *how* models are configured, and concluded the
 * figures were admin-only. They were not — they are on the catalogue the model
 * page renders from, already filtered by the same rule that page uses.
 *
 * So the tool answers the question it is asked most often in one call, rather
 * than leaving the assistant to go looking and then say it cannot find it.
 *
 * `chat` is filtered to what the caller may actually use. `chatModels` and
 * `providers` stay unfiltered and match `GET /v1/models`, because listing a
 * model and being allowed to call it are different questions and the gateway
 * answers them differently too.
 */
async function listGatewayModels(ctx: ToolContext): Promise<ToolResult> {
  const chat = await listProviders();
  const chatModels = new Set<string>();
  const byProvider: Array<{ name: string; baseUrl: string | null; models: string[] }> = [];

  for (const p of chat) {
    if (!p.enabled) continue;
    const ids = Object.keys(p.modelMapping ?? {});
    ids.forEach((m) => chatModels.add(m));
    byProvider.push({ name: p.name, baseUrl: p.baseUrl ?? null, models: ids });
  }

  const media = (await listMediaProviders()).filter((m) => m.enabled);
  const mediaModels = media.flatMap((m) => Object.keys(m.models ?? {}));

  // Same rule as `dashboard/models/page.tsx`: an empty list means no
  // restriction, and a caller who may not use a model is not told its numbers.
  // The session does not carry the whitelist, so it is read here rather than
  // widened into `AuthedUser` for one call site.
  const full = await getUserById(ctx.user.id);
  const allowed = full?.allowedModels ?? [];
  const visible = (id: string): boolean => allowed.length === 0 || allowed.includes(id);
  const catalog = await buildModelCatalog();
  const details = catalog.models
    .filter((m) => m.kind === "chat" && visible(m.id))
    .map((m) => ({
      id: m.id,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      /**
       * The three thinking facts, as one value and never separated.
       *
       * `reasoningLevels` alone cannot be read: `[]` means the vendor published no
       * levels, which is true of a model that also cannot be switched off — and a
       * reader given only that answers "no levels" and stops, which is the same
       * three-way collapse the model page used to have. Carrying all three here
       * means the answer is one object rather than two facts the caller has to
       * remember to join.
       */
      reasoning: {
        levels: m.reasoningLevels,
        /** null = nobody has declared it. Not the same as "no". */
        effortSupported: m.reasoningEffortSupported,
        /** null = nobody has declared it. Not the same as "no". */
        switchSupported: m.thinkingSwitchSupported,
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return ok({
    chatModels: [...chatModels].sort(),
    mediaModels: mediaModels.sort(),
    total: chatModels.size + mediaModels.length,
    providers: byProvider,
    // Per-model limits, for "how big is the context window" and "what thinking
    // levels does it take" — the questions a name-only list cannot answer.
    chat: details,
  });
}

async function testGatewayModel(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const model = z.string().min(1).safeParse(args.model);
  if (!model.success) return fail(ctx, "missingModel");
  if (!ctx.relayKey && !ctx.account) return fail(ctx, "noCredential");

  const prompt =
    typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : "用一句话介绍你自己。";
  const body = {
    model: model.data,
    messages: [{ role: "user" as const, content: prompt }],
    max_tokens: 200,
    stream: false,
  };

  const started = Date.now();

  // Account path: straight into the proxy, with the user's own credential. The
  // same function the public route calls, minus the bearer lookup — there is no
  // token to look up.
  if (ctx.account) {
    try {
      const result = await proxyChatCompletion({
        req: body,
        apiKey: ctx.account.apiKey,
        user: ctx.account.user,
        signal: AbortSignal.timeout(90_000),
      });
      const latencyMs = Date.now() - started;
      if (!result.ok) {
        return ok({
          model: model.data,
          ok: false,
          httpStatus: result.status,
          latencyMs,
          response: JSON.stringify(result.error ?? {}).slice(0, 600),
        });
      }
      const parsed = result.data as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { total_tokens?: number };
      };
      return ok({
        model: model.data,
        ok: true,
        via: "account",
        httpStatus: result.status,
        latencyMs,
        finishReason: parsed.choices?.[0]?.finish_reason ?? null,
        totalTokens: parsed.usage?.total_tokens ?? null,
        answer: (parsed.choices?.[0]?.message?.content ?? "").slice(0, 1200),
      });
    } catch (err) {
      return fail(ctx, "callFailed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  const base = gatewayBase(ctx);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.relayKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      return ok({ model: model.data, ok: false, httpStatus: res.status, latencyMs, response: text.slice(0, 600) });
    }

    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    };
    const answer = parsed.choices?.[0]?.message?.content ?? "";
    return ok({
      model: model.data,
      ok: true,
      via: "key",
      httpStatus: res.status,
      latencyMs,
      finishReason: parsed.choices?.[0]?.finish_reason ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null,
      answer: answer.slice(0, 1200),
    });
  } catch (err) {
    return fail(ctx, "callFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * What to tell the model when a media call fails, keyed by status.
 *
 * Shared by both credential paths so the account path cannot quietly lose the
 * advice that the key path gives — the 400 case in particular exists because a
 * model was observed inventing a cause ("the response format does not match")
 * for an upstream error whose actual text was sitting in the same result.
 */
function mediaFailureHint(status: number): string | undefined {
  if (status === 401 || status === 403) return "密钥无效，或该账号没有这个媒体能力的权限。";
  if (status === 402) return "上游额度用尽（不是权限问题）。原话在 response 里，照它解释。";
  if (status === 404) return "模型名不对，或该媒体服务商没有为这个模型配置 spec。";
  if (status === 400) {
    return (
      "上游的参数校验没过。原话在 response 字段里 —— 照它转述给用户，" +
      "不要猜测原因（例如不要说「返回格式不匹配」，你看不到上游返回了什么）。"
    );
  }
  return undefined;
}

/**
 * Turn engine items into storable artifacts.
 *
 * A `url` item keeps its link and costs nothing to store. A `base64` item is
 * kept inline because that is the only copy that will ever exist — and its
 * content type is a guess, because the item shape does not carry one. That is
 * acceptable only because the inline path is images in practice: audio always
 * arrives as `binary`, which does carry its type, and browsers sniff an image
 * regardless of what the header says.
 */
function artifactsFromItems(
  items: Array<{ kind: string; value: string }>,
  kind: ArtifactKind,
): RawArtifact[] {
  return items.map((item) =>
    item.kind === "url"
      ? { kind, contentType: "application/octet-stream", url: item.value }
      : { kind, contentType: kind === "audio" ? "audio/mpeg" : "image/png", base64: item.value },
  );
}

/**
 * Generate a media artefact with the caller's own credential.
 *
 * Goes out over the same public routes a client would use rather than calling
 * the media engine directly, so a tool result is evidence that the route
 * works — not just that the spec maps. It also means the user's own quota and
 * model permissions apply, which is the point of routing through the gateway
 * at all.
 */
/**
 * The documentation the reader can see, in their own language.
 *
 * A refusal comes back as a result, not an exception: "that page is admin-only"
 * is something the model can report, where an exception ends the turn and
 * loses whatever it had already established.
 */
function readDocsTool(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const locale = ctx.locale ?? DEFAULT_LOCALE;
  const isAdmin = ctx.user.role === "admin";
  const canReadAdmin = ctx.canReadAdminDocs ?? isAdmin;
  const reader = createDocReader(ctx.docPages);

  const topic = typeof args.topic === "string" ? args.topic.trim() : "";
  if (!topic) {
    return ok({
      note: "不带 topic 时这是目录。要读哪一页，把它的 topic 再传进来。",
      userDocs: reader.index.filter((e) => e.surface === "user"),
      adminDocs: canReadAdmin
        ? reader.index.filter((e) => e.surface === "admin")
        : "（管理员文档只有管理员能读）",
    });
  }

  const wantsAdmin = topic.toLowerCase().startsWith("admin");
  if (wantsAdmin && !canReadAdmin) {
    return fail(ctx, "adminDocsOnly");
  }

  const result = reader.read(topic, locale, wantsAdmin ? "admin" : "user");
  if (!result.ok) {
    return fail(
      ctx,
      result.available ? "docTopicUnavailable" : "docReadFailed",
      {
        reason: result.reason,
        available: result.available ? result.available.map((a) => a.topic).join(", ") : "",
      },
    );
  }
  return ok({ topic: result.topic, title: result.title, truncated: result.truncated, text: result.text });
}

/**
 * The reference image, in whatever form the caller gave it.
 *
 * A vendor's spec asks for a data URL (or a URL it can fetch), so the tool has
 * to end up with one. Three ways in:
 *
 *   - the literal `attachment`, meaning the picture the user attached to this
 *     message. This is the case that matters: a model that can see an image in
 *     its context but cannot name it in a tool call can do text-to-image and
 *     not image-to-image, and then falls back to telling the user to use curl.
 *   - an http(s) URL, passed through. Also how most vendors want a reference.
 *   - a data URL, passed through.
 *
 * The bytes come from `assistant_artifacts`, which is the same store the
 * conversation renders from and which is owner-scoped — so a tool cannot reach
 * a picture the user did not attach to this turn.
 */

/** Above this, the base64 body is a liability rather than a payload. */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

const ATTACHMENT_ALIASES = new Set(["attachment", "@attachment", "上传的图片", "附件"]);

/**
 * A refusal, as the key of the row that carries it.
 *
 * The image and the audio resolvers both answer with prose the person reads,
 * so the prose has to follow their language. Returning the key rather than
 * the sentence keeps the wording in one table and lets the caller decide how
 * to present it.
 */
interface Refusal {
  key: string;
  vars?: Record<string, string | number>;
}

/**
 * The reference image, as a refusal key when it cannot be resolved.
 *
 * The internal twin of {@link resolveReferenceImage}: same walk over the same
 * attachments, but the refusal comes back as a key so the caller can hand it
 * to `fail` and get the reader's language.
 */
async function resolveReferenceImageRefusal(
  value: string,
  ctx: ToolContext,
): Promise<{ ok: true; dataUrl: string } | { ok: false; refusal: Refusal }> {
  const raw = value.trim();
  if (!raw) return { ok: false, refusal: { key: "referenceImageEmpty" } };

  if (raw.startsWith("data:")) return { ok: true, dataUrl: raw };

  if (/^https?:\/\//i.test(raw)) {
    return { ok: true, dataUrl: raw };
  }

  if (!ATTACHMENT_ALIASES.has(raw)) {
    return { ok: false, refusal: { key: "referenceImageForms" } };
  }

  const pictures = (ctx.attachments ?? []).filter((a) => a.kind === "image");
  if (pictures.length === 0) {
    return { ok: false, refusal: { key: "noAttachedImage" } };
  }
  // Newest wins: the user may have sent a correction.
  const attachment = pictures[pictures.length - 1];

  const stored = await getAssistantArtifact(attachment.id, ctx.user.id);
  if (!stored?.bytes) {
    return { ok: false, refusal: { key: "attachmentUnreadable", vars: { name: attachment.name } } };
  }
  if (stored.bytes.byteLength > MAX_REFERENCE_BYTES) {
    return {
      ok: false,
      refusal: {
        key: "attachmentTooLarge",
        vars: {
          name: attachment.name,
          size: (stored.bytes.byteLength / 1024 / 1024).toFixed(1),
          limit: MAX_REFERENCE_BYTES / 1024 / 1024,
        },
      },
    };
  }
  return {
    ok: true,
    dataUrl: `data:${attachment.contentType};base64,${Buffer.from(stored.bytes).toString("base64")}`,
  };
}

export async function resolveReferenceImage(
  value: string,
  ctx: ToolContext,
): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
  const resolved = await resolveReferenceImageRefusal(value, ctx);
  if (resolved.ok) return resolved;
  return { ok: false, reason: toolRefusal(ctx.locale, resolved.refusal.key, resolved.refusal.vars) };
}

/**
 * Told at the moment it matters.
 *
 * The rule is in the system prompt, and it was in the system prompt and the
 * model pasted the addresses anyway — twice glued into one that does not
 * resolve, while the panel above already showed both pictures. This lands
 * immediately after the call, which is the moment the decision is made.
 */
const ARTIFACT_NOTE =
  "图片/音频已经渲染在工具结果里了。不要把 artifacts 里的地址写进回答，多个地址更不要连在一起写。" +
  "像素尺寸这里没有给，界面上会显示，不要猜，也不要把 spec 里的请求尺寸当成出图结果。";

/**
 * The audio a caller means, as a data URL.
 *
 * The same three shapes `resolveReferenceImage` takes, for the same reason: a
 * model should be able to say "the audio the user just sent" rather than paste
 * a megabyte of base64 into a tool call.
 */
async function resolveReferenceAudio(
  value: string,
  ctx: ToolContext,
): Promise<{ ok: true; dataUrl: string; name: string } | { ok: false; reason: string }> {
  const resolved = await resolveReferenceAudioRefusal(value, ctx);
  if (resolved.ok) return resolved;
  return { ok: false, reason: toolRefusal(ctx.locale, resolved.refusal.key, resolved.refusal.vars) };
}

/**
 * The audio a caller means, as a refusal key when it cannot be resolved.
 *
 * The internal twin of {@link resolveReferenceAudio}: same three shapes, same
 * attachment rules, but the refusal comes back as a key so the caller can
 * hand it to `fail` and get the reader's language.
 */
async function resolveReferenceAudioRefusal(
  value: string,
  ctx: ToolContext,
): Promise<{ ok: true; dataUrl: string; name: string } | { ok: false; refusal: Refusal }> {
  const raw = value.trim();
  if (!raw) return { ok: false, refusal: { key: "referenceAudioEmpty" } };
  if (raw.startsWith("data:") || /^https?:\/\//i.test(raw)) {
    return { ok: true, dataUrl: raw, name: "音频" };
  }
  if (!ATTACHMENT_ALIASES.has(raw)) {
    return { ok: false, refusal: { key: "referenceAudioForms" } };
  }

  const clips = (ctx.attachments ?? []).filter((a) => a.kind === "audio");
  if (clips.length === 0) {
    // This message is written to the user through the model, so naming a
    // control that is not on screen is worse than naming none: the composer
    // used to have a record button next to the paperclip, it was removed, and
    // for a while this still sent people looking for it. Whatever it names has
    // to be something AssistantChat.tsx actually renders. The paperclip is a
    // file input accepting audio/*, and it is the only way in now.
    return { ok: false, refusal: { key: "noAttachedAudio" } };
  }
  // Newest wins, same as the picture case: the user may have sent a correction.
  const attachment = clips[clips.length - 1];
  const stored = await getAssistantArtifact(attachment.id, ctx.user.id);
  if (!stored?.bytes) {
    return { ok: false, refusal: { key: "attachmentUnreadable", vars: { name: attachment.name } } };
  }
  return {
    ok: true,
    name: attachment.name,
    dataUrl: `data:${stored.contentType || attachment.contentType || "audio/mpeg"};base64,${Buffer.from(stored.bytes).toString("base64")}`,
  };
}

/**
 * Speech to text.
 *
 * The assistant could already generate images, speech and video, and was asked
 * to read an audio file it had been handed. It had no tool for it, so it
 * explained the endpoint to the user and told them to post it themselves — while
 * the gateway already had an `audio.stt` spec configured and the file was
 * sitting in the message it was reading.
 */
async function transcribeAudio(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.relayKey && !ctx.account) return fail(ctx, "noCredential");
  const model = z.string().min(1).safeParse(args.model);
  if (!model.success) {
    // A missing model is a question with an answer in this deployment, not
    // something to send upstream and read a 400 about.
    const stt = await listSttModels();
    if (stt.length === 0) {
      return fail(ctx, "noSttModel");
    }
    return fail(ctx, "sttModelRequired", { models: stt.join("、") });
  }

  const resolved = await resolveReferenceAudioRefusal(
    typeof args.audio === "string" ? args.audio : "attachment",
    ctx,
  );
  if (!resolved.ok) return fail(ctx, resolved.refusal.key, resolved.refusal.vars);

  if (!ctx.account) {
    // The account path is the only one that can read a stored attachment
    // without a bearer token, and every other media tool resolves the same way.
    return fail(ctx, "noCredential");
  }

  const language = typeof args.language === "string" ? args.language.trim() : "";
  const started = Date.now();
  const outcome = await executeMediaRequest({
    capability: "audio.stt",
    input: {
      model: model.data,
      // The same slot and the same data URL the public
      // `/v1/audio/transcriptions` route uses, so a spec resolves this the same
      // way whichever door the request came through.
      image: resolved.dataUrl,
      extra: { audio: resolved.dataUrl, filename: resolved.name, ...(language ? { language } : {}) },
    },
    apiKey: ctx.account.apiKey,
    user: ctx.account.user,
    signal: AbortSignal.timeout(240_000),
  });
  const latencyMs = Date.now() - started;

  if (!outcome.ok) {
    return ok({
      ok: false,
      via: "account",
      httpStatus: outcome.error.status,
      latencyMs,
      response: JSON.stringify(outcome.error).slice(0, 1000),
      hint: mediaFailureHint(outcome.error.status),
    });
  }

  const text = (outcome.value.result.text ?? "").trim();
  return ok({
    ok: true,
    via: "account",
    httpStatus: 200,
    latencyMs,
    model: model.data,
    source: resolved.name,
    text,
    // So the caller can put it in a message rather than describe it.
    message: text || "没有识别到内容。",
  });
}

/** The speech-to-text models this deployment can actually reach. */
async function listSttModels(): Promise<string[]> {
  const rows = await listMediaProviders();
  const ids = new Set<string>();
  for (const p of rows) {
    for (const spec of p.specs ?? []) {
      if (spec.capability === "audio.stt") {
        for (const m of spec.models ?? []) ids.add(m);
      }
    }
  }
  return [...ids];
}

async function mediaGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  kind: "image" | "speech" | "video",
): Promise<ToolResult> {
  const model = z.string().min(1).safeParse(args.model);
  if (!model.success) return fail(ctx, "missingModel");
  if (!ctx.relayKey && !ctx.account) return fail(ctx, "noCredential");

  const prompt = typeof args.prompt === "string" ? args.prompt : typeof args.input === "string" ? args.input : "";
  if (!prompt.trim()) return fail(ctx, "missingPrompt");

  // MiniMax's t2a_v2 rejects a request with no `voice_setting.voice_id`, so a
  // model that omits the optional-looking `voice` argument gets a bare
  // "missing required parameter" it cannot make sense of. Default it here
  // rather than letting the failure reach the conversation.
  const voice = typeof args.voice === "string" && args.voice.trim() ? args.voice.trim() : DEFAULT_TTS_VOICE;
  // Same trap one level up: both video specs require a duration, and H3 also
  // requires an explicit, non-adaptive ratio.
  const duration = typeof args.duration === "number" && args.duration > 0 ? args.duration : DEFAULT_VIDEO_DURATION;
  const ratio = typeof args.ratio === "string" && args.ratio.trim() ? args.ratio.trim() : DEFAULT_VIDEO_RATIO;

  const path =
    kind === "image" ? "/v1/images/generations" : kind === "speech" ? "/v1/audio/speech" : "/v1/videos/generations";

  // Image-to-image, when the caller asked for it. A spec decides what a
  // reference turns into — MiniMax wraps it in `subject_reference`, others
  // take it raw — so the only thing this has to get right is handing it over.
  let reference: string | undefined;
  if (kind === "image" && typeof args.image === "string" && args.image.trim()) {
    const resolved = await resolveReferenceImageRefusal(args.image, ctx);
    if (!resolved.ok) return fail(ctx, resolved.refusal.key, resolved.refusal.vars);
    reference = resolved.dataUrl;
  }

  const payload: Record<string, unknown> =
    kind === "speech"
      ? { model: model.data, input: prompt, response_format: "mp3", voice }
      : kind === "image"
        ? {
            model: model.data,
            prompt,
            n: 1,
            ...(typeof args.size === "string" && args.size.trim() ? { size: args.size.trim() } : {}),
            // A spec's size table maps dimensions onto a ratio, so a ratio the
            // caller asked for is something the spec can resolve. Sent beside
            // `size` because a spec honours one or the other, not both.
            ...(typeof args.ratio === "string" && args.ratio.trim() ? { ratio: args.ratio.trim() } : {}),
            ...(reference ? { image: reference } : {}),
          }
        : { model: model.data, prompt, n: 1, duration, ratio };

  const started = Date.now();

  // Account path: the same handler the public route calls, invoked in-process
  // with the user's own credential. The quota, whitelist and spec checks all
  // still apply because they are the handler's own; the only thing skipped is
  // the bearer lookup, which has no bearer token to do. A tool result therefore
  // proves the handler works but not the route, which is why the route keeps
  // its own tests rather than relying on this.
  if (ctx.account) {
    try {
      const outcome = await executeMediaRequest({
        capability:
          kind === "image" ? "image.generate" : kind === "speech" ? "audio.tts" : "video.generate",
        input: {
          model: model.data,
          prompt,
          ...(typeof args.size === "string" && args.size.trim() ? { size: args.size.trim() } : {}),
          extra: payload,
        },
        apiKey: ctx.account.apiKey,
        user: ctx.account.user,
        signal: AbortSignal.timeout(240_000),
      });
      const latencyMs = Date.now() - started;
      if (!outcome.ok) {
        return ok({
          ok: false,
          via: "account",
          httpStatus: outcome.error.status,
          latencyMs,
          response: JSON.stringify(outcome.error).slice(0, 1000),
          hint: mediaFailureHint(outcome.error.status),
        });
      }
      const items = await resultItems(outcome.value.result);
      // The kind comes from the tool, never from a fallback expression.
      // `resultItems` normalises both shapes an upstream can return — a url item
      // and a `binary` result, which it converts to a base64 item — so there is
      // one mapping to do, and deriving it from anything but the requested
      // capability is how a synthesised voice ends up labelled as a video.
      const artifactKind: ArtifactKind = kind === "image" ? "image" : kind === "speech" ? "audio" : "video";
      return {
        ...ok({
          ok: true,
          via: "account",
          httpStatus: 200,
          latencyMs,
          itemCount: items.length || outcome.value.result.successCount,
          note: ARTIFACT_NOTE,
        }),
        artifacts: artifactsFromItems(items, artifactKind),
      };
    } catch (err) {
      return fail(ctx, "callFailed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    const res = await fetch(`${gatewayBase(ctx)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.relayKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(240_000),
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return ok({
        ok: false,
        via: "key",
        httpStatus: res.status,
        latencyMs,
        response: text.slice(0, 1000),
        hint: mediaFailureHint(res.status),
      });
    }

    if (kind === "speech") {
      // The endpoint answers with bytes. Measuring them and then throwing them
      // away is what left the user with a byte count and no way to hear it, so
      // they go on the side channel where the conversation can keep them.
      const buffer = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "audio/mpeg";
      return {
        ...ok({
          ok: true,
          via: "key",
          httpStatus: res.status,
          latencyMs,
          audioBytes: buffer.byteLength,
          contentType,
        }),
        artifacts: [
          { kind: "audio", contentType, base64: Buffer.from(new Uint8Array(buffer)).toString("base64") },
        ],
      };
    }

    const json: unknown = await res.json().catch(() => null);
    if (kind === "image") {
      const data = (json as { data?: Array<Record<string, unknown>> })?.data ?? [];
      const items = data.map((d) =>
        typeof d?.url === "string"
          ? { kind: "url", value: d.url }
          : { kind: "base64", value: typeof d?.b64_json === "string" ? d.b64_json : "" },
      );
      return {
        ...ok({
          ok: items.length > 0,
          via: "key",
          httpStatus: res.status,
          latencyMs,
          itemCount: items.length,
          note: ARTIFACT_NOTE,
        }),
        artifacts: artifactsFromItems(items, "image"),
      };
    }
    const itemCount = ((json as { data?: unknown[] })?.data ?? []).length;
    return {
      ...ok({ ok: true, via: "key", httpStatus: res.status, latencyMs, itemCount }),
      artifacts: artifactsFromItems(
        ((json as { data?: Array<Record<string, unknown>> })?.data ?? []).map((d) => ({
          kind: "url",
          value: typeof d?.url === "string" ? d.url : "",
        })),
        "video",
      ),
    };
  } catch (err) {
    return fail(ctx, "callFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

async function getMyUsage(ctx: ToolContext): Promise<ToolResult> {
  // The session user is deliberately a *small* shape (id, username, role) so it
  // stays cheap on every authenticated request. Quota and allocation live on
  // the full row, so this has to go back for it.
  const full = await getUserById(ctx.user.id);
  const { keys } = await listApiKeysByUser(ctx.user.id, { limit: 100 });
  const enabled = keys.filter((k) => k.enabled);
  /**
   * Two different sets, on purpose.
   *
   * The counts below — `activeKeys`, `totalKeys` — come from the management
   * list, because the assistant credential is not one of this user's keys and
   * must not read as one: it is not usable by them and does not consume their
   * `maxActiveKeys` budget.
   *
   * The spending comes from every key the balance can be charged through, which
   * is a wider set. Answering "what have I used" from the key list left out
   * every call the assistant made on this user's behalf — while `quotaUsed` on
   * the same payload, read from the user row, had already counted them. The tool
   * was contradicting itself: a total that included the assistant's spend above
   * a breakdown that did not.
   */
  const chargeableIds = await listApiKeyIdsForUsage(ctx.user.id);
  const agg = await aggregateByKeyMany(chargeableIds);
  const recent = await listRecentUsage(chargeableIds, { limit: 15 });

  return ok({
    quotaType: full?.quotaType ?? null,
    quotaLimit: full?.quotaLimit ?? 0,
    quotaUsed: full?.quotaUsed ?? 0,
    remaining: full ? Math.max(0, full.quotaLimit - full.quotaUsed) : 0,
    allowedModels: full?.allowedModels ?? [],
    maxActiveKeys: full?.maxActiveKeys ?? 0,
    activeKeys: enabled.length,
    totalKeys: keys.length,
    usageByKey: agg,
    recentRequests: recent.map((r) => ({
      model: r.model,
      status: r.status,
      totalTokens: r.totalTokens,
      creditsUsed: r.creditsUsed,
      createdAt: r.createdAt,
      errorMessage: r.errorMessage,
    })),
  });
}

/**
 * The proposals this user has submitted and where each of them stands.
 *
 * Added because the model could propose a change and then had no way to find out
 * whether it had happened. It answered "still pending" on the strength of a
 * config read that simply did not include the changed fields — a guess, dressed
 * as a finding, and wrong in the direction that matters. A tool that reports the
 * queue is the difference between "I don't know" and "not yet".
 */
/**
 * Take a pending proposal back, and say plainly when it could not be taken.
 *
 * The model raised this itself: it had proposed a correction, the correction
 * was superseded, and its only tools could create. So it reported a stale
 * proposal as still queued and left it there.
 *
 * The refusal branch matters as much as the success one. A tool that answered
 * "done" either way would leave the model believing a queue was clean.
 */
async function withdrawProposal(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const actionId = typeof args.actionId === "string" ? args.actionId.trim() : "";
  if (!actionId) return fail(ctx, "actionIdRequired");

  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : "助手撤回";

  const before = await getAssistantAction(ctx.user.id, actionId);
  if (!before) {
    return fail(ctx, "proposalNotFound", { actionId });
  }
  if (before.status !== "pending") {
    const applied = before.status === "applied";
    return fail(
      ctx,
      applied ? "actionNotWithdrawableApplied" : "actionNotWithdrawableHandled",
      {
        actionId,
        status: before.status,
        how: toolRefusal(ctx.locale, applied ? "withdrawStatusApplied" : "withdrawStatusHandled"),
      },
    );
  }

  const withdrawn = await withdrawAssistantAction(ctx.user.id, actionId, `助手撤回：${reason}`);
  if (!withdrawn) {
    return fail(ctx, "actionWithdrawRace", { actionId });
  }
  return ok({ actionId, status: "rejected", reason, summary: before.summary });
}

async function listMyProposals(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const status = args.status;
  if (status !== undefined && typeof status !== "string") {
    return fail(ctx, "statusNotString");
  }
  const parsed = status as
    | "pending"
    | "applied"
    | "rejected"
    | "failed"
    | undefined;
  if (parsed !== undefined && !["pending", "applied", "rejected", "failed"].includes(parsed)) {
    return fail(ctx, "statusInvalid");
  }

  const actions = await listAssistantActions(ctx.user.id, parsed, 50);
  const pending = actions.filter((a) => a.status === "pending").length;
  return ok({
    // Stated in the same shape every time, because the question being answered is
    // "is it done yet" and that is a count before it is a list.
    statusSummary: {
      pending,
      applied: actions.filter((a) => a.status === "applied").length,
      rejected: actions.filter((a) => a.status === "rejected").length,
      failed: actions.filter((a) => a.status === "failed").length,
    },
    proposals: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      targetId: a.targetId,
      summary: a.summary,
      status: a.status,
      // What the server wrote when it resolved the action: for a failure, the
      // validator's own wording, which for a media provider is the complete list
      // of what it objected to.
      //
      // This was dropped from the projection, which left `status: "failed"` as
      // the only thing anyone could learn — including the assistant. It then had
      // three ranked guesses at the cause and asked the user to paste a message
      // the interface had already thrown away. The reason was in this row the
      // whole time.
      result: a.result ?? null,
      createdAt: a.createdAt,
      // Named `resolvedAt` on the row because it covers rejection as well as
      // application. Reported as itself rather than renamed to `appliedAt`,
      // which would claim a rejected proposal was applied.
      resolvedAt: a.resolvedAt ?? null,
    })),
  });
}

async function listProvidersTool(): Promise<ToolResult> {
  const providers = await listProviders();
  return ok(
    providers.map((p) => {
      const configs = Object.entries(p.modelConfigs ?? {});
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl ?? null,
        enabled: p.enabled,
        priority: p.priority,
        /**
         * The route table — how each client interface reaches this provider.
         *
         * This is the answer, and it is reported as the table it is: one entry
         * per interface, each saying whether the provider does not answer it,
         * answers it as it arrived, or has it rewritten into another dialect.
         * The columns that came before the table are its summary and are
         * reported below under their own names.
         */
        routes: describeRoutes(routesOfProvider(p)),
        upstreamFormat: p.upstreamFormat,
        openaiEnabled: p.openaiEnabled,
        anthropicEnabled: p.anthropicEnabled,
        anthropicBaseUrl: p.anthropicBaseUrl ?? null,
        anthropicMode: p.anthropicMode,
        models: Object.keys(p.modelMapping ?? {}),
        modelDetails: configs.map(([id, c]) => ({
          id,
          contextLength: c.contextLength ?? null,
          maxOutputTokens: c.maxOutputTokens ?? null,
          // Declared here, not discovered there. An empty list means this relay
          // has not been told what the model takes — a fact about the
          // configuration, not about the vendor.
          reasoningLevels: c.reasoningLevels ?? [],
          /**
           * The prices and the effort declaration, because a tool that cannot
           * read them cannot be used to check a change made with the tools next
           * door to it.
           *
           * This list used to stop at the fields above, and the cost was a
           * specific wrong conclusion twice in one session: the assistant saw
           * no prices in the output, said the prices had never been configured,
           * and the proposal's own before-snapshot went on to show four models
           * priced at zero and two priced in yuan rather than credits. A missing
           * key in a read is not a missing value in the row, and the two are
           * indistinguishable from here unless the key is returned.
           *
           * `null` rather than a zero default, for the same reason the
           * declaration is not a boolean: unset is a real answer and so is
           * zero, and the difference between "free" and "never priced" is the
           * difference between a bill and a leak.
           */
          inputCost: c.inputCost ?? null,
          outputCost: c.outputCost ?? null,
          cachedInputCost: c.cachedInputCost ?? null,
          cacheWriteCost: c.cacheWriteCost ?? null,
          /**
           * `null` = never declared, `false` = the vendor ignores the parameter.
           * The two are reported separately rather than as one boolean because
           * collapsing them would either grey out every model on the deployment
           * or none of them.
           */
          reasoningEffortSupported: c.reasoningEffortSupported ?? null,
          // The same three states for the thinking switch, and reported
          // separately for the same reason: reading back "not false" where a
          // model was told "yes" hides the very answer the reader asked for.
          thinkingSwitchSupported: c.thinkingSwitchSupported ?? null,
          enabled: c.enabled,
        })),
        // Never the key itself: the model has no need for it and the transcript
        // is persisted and re-sent on every subsequent turn.
        headers: p.headers,
        // The protocol documents, one per interface. The model has to see what
        // is there before it can change it, and "it did not tell me" is the
        // shape of every conversation where an assistant quietly re-derives a
        // provider's configuration and gets it wrong. Shown as the list it is:
        // a singular `textSpec` hid two of the three possible entries.
        textSpecs: p.textSpecs ?? [],
        /**
         * The stored mode, and separately the mode the engine resolves it to.
         *
         * The second value is the one that answers "are my rules running?",
         * and it cannot be derived by the model without knowing that `null`
         * means "advanced when rules exist" — so it is computed here rather
         * than left as an inference the reader has to make.
         */
        activeMode: p.activeMode ?? null,
        effectiveMode: activeModeOf(p),
        rulesCount: (p.textSpecs ?? []).length,
      };
    }),
  );
}

/**
 * The configurable protocols and the six parameter modes, with the advice that
 * decides between them.
 *
 * Returned rather than described in a tool description because the model has to
 * choose, and a choice made from a tool description is a choice made from
 * whichever example happened to be nearest. The presets are the whole answer to
 * "how do I configure a vendor" for the ninety percent of vendors that need
 * nothing.
 *
 * **`CONFIGURABLE_PROTOCOLS`, not every preset.** This used to walk
 * `TEXT_PROTOCOL_LABELS`, which still carries `gemini-generate` — the gateway
 * has no `v1beta/models/*:generateContent` route, so a rule for it would be
 * saved and never selected. Offering it here is the same lie the editor stopped
 * telling, told to the one caller with no UI to notice.
 */
function listTextProtocolsTool(): ToolResult {
  return ok({
    defaultIfUnset: "不配协议时，客户端的请求体原样送到上游。这是中转站该有的默认。",
    protocols: CONFIGURABLE_PROTOCOLS.map((protocol) => {
      const surface = SURFACES.find((s) => s.id === protocol);
      return {
        protocol,
        name: TEXT_PROTOCOL_LABELS[protocol].zh,
        // Which client endpoint this rule governs, and which toggle has to be on
        // for it to ever run. Without both, the model writes a rule for an
        // interface nothing calls.
        clientPath: surface?.clientPath ?? null,
        requiresFace: surface?.face ?? null,
        whenToUse: TEXT_PROTOCOL_LABELS[protocol].hint,
        preset: TEXT_PROTOCOL_PRESETS[protocol],
      };
    }),
    faces: {
      openai: "openaiEnabled：这家的 Chat / Responses / Gemini 三个接口里，哪些是被服务的",
      anthropic: "anthropicEnabled：这条服务商是否响应 /v1/messages 与 /anthropic/v1/messages",
      note:
        "给某个接口写规则之前，这个接口必须是被服务的，否则规则会保存但不会有请求走到它。" +
        "（编辑器里没被服务的接口不会出现在添加按钮中。）",
    },
    parameterModes: {
      passthrough: "默认。没列出的参数一律走这个 —— 转发客户端传的值。",
      drop: "客户端传了也不送。用于上游会 400 的参数。",
      default: "客户端没传时才用 value。传了就用它的，对客户端完全透明。",
      force: "不管客户端传没传都用 value。这是唯一能让客户端拿到它没要求的行为的模式，慎用。",
      clamp: "保留客户端的值，但限制在 min/max 之间。",
      rename: "换个名字或位置送，to 可以是点号路径（如 extra_body.thinking）。",
    },
    order: "裁决顺序固定：drop 最先且不可被后面的规则捡回，然后 default、clamp、force、rename。",
  });
}

/**
 * The text protocol, and the presets that come with it.
 *
 * The third of the three, and the one that was missing longest. The media
 * protocol and the search protocol each had a reader and a chapter; the text
 * protocol — the one every ordinary provider row is configured with — lived
 * in a file that nothing could read from outside the repository. So the model
 * wrote `textSpecs` from memory, and a spec written from memory is a spec
 * that fails validation for reasons nobody can see.
 *
 * **The split with `list_text_protocols` is deliberate.** That tool answers
 * "which protocol should this vendor be, and which mode should this parameter
 * get" — advice. This one answers "what does the protocol say, and what does
 * a finished entry look like" — the source and the artifact. Two tools with
 * one job each, rather than one tool with two jobs and no way to say which
 * half you want.
 */
async function textSpecReferenceTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const what = args.what === "presets" ? "presets" : "protocol";

  if (what === "presets") {
    const asked = typeof args.protocol === "string" ? args.protocol.trim() : "";
    const ids = asked ? [asked] : [...CONFIGURABLE_PROTOCOLS];

    // **Configurable only.** `TEXT_PROTOCOL_PRESETS` also carries
    // `gemini-generate`, and it is the right answer the day this gateway
    // serves `v1beta/models/*:generateContent` — but it serves no such route
    // today, so a rule for it would be saved and never selected. Handing it out
    // here is the same lie the editor stopped telling, told by the one caller
    // with no UI to notice.
    const unusable = ids.filter((id) => !(CONFIGURABLE_PROTOCOLS as readonly string[]).includes(id));
    if (unusable.length > 0) {
      return fail(ctx, "protocolNoPreset", {
        protocols: unusable.join("、"),
        available: CONFIGURABLE_PROTOCOLS.join("、"),
      });
    }

    return ok({
      presets: ids.map((id) => {
        const surface = SURFACES.find((s) => s.id === id);
        return {
          protocol: id,
          name: TEXT_PROTOCOL_LABELS[id as keyof typeof TEXT_PROTOCOL_LABELS].zh,
          // Which client endpoint this rule governs, and which toggle has to be
          // on for it to ever run. Without both, the model writes a rule for an
          // interface nothing calls.
          clientPath: surface?.clientPath ?? null,
          requiresFace: surface?.face ?? null,
          /** The object to paste into `propose_provider_update`'s `textSpecs`. */
          preset: TEXT_PROTOCOL_PRESETS[id as keyof typeof TEXT_PROTOCOL_PRESETS],
        };
      }),
      note:
        "preset 就是可以直接放进 propose_provider_update 的 textSpecs 数组里的那个对象（一份一个 protocol）。" +
        "预设只是「起点」，不是「正确答案」：已存的规则可能带着预设里没有的、故意的修正，整份套用会把它们冲掉。" +
        "该选哪个协议见 list_text_protocols。",
    });
  }

  const { text, error } = await readTextProtocolDoc();
  if (!text) return fail(ctx, "textProtocolUnreadable", {
      reason: error ?? toolRefusal(ctx.locale, "textProtocolUnreadable"),
    });

  const total = text.length;
  const offset = Math.max(0, typeof args.offset === "number" ? Math.trunc(args.offset) : 0);
  const asked = typeof args.limit === "number" ? Math.trunc(args.limit) : PROTOCOL_CHUNK_CHARS;
  const limit = Math.min(Math.max(asked, 1), MAX_PROTOCOL_CHUNK_CHARS);
  const slice = text.slice(offset, offset + limit);
  const end = offset + slice.length;

  return ok({
    total,
    offset,
    returned: slice.length,
    // Absent rather than `null` on the last window: "there is no next one" and
    // "the next one is at position zero" should not look alike.
    ...(end < total ? { nextOffset: end } : {}),
    text: slice,
  });
}

/**
 * The numbers a proposal may set, with the label used to reject a bad one.
 *
 * The thinking levels are deliberately absent. They are words, and a list of
 * them cannot go through a `Number(...)` coercion — see
 * {@link buildModelConfigPatch}.
 *
 * The label is a key rather than a word, because the refusal that names it is
 * read in the reader's language.
 */
const NUMERIC_PATCH_FIELDS = [
  ["contextLength", "modelConfigFieldContextLength", true],
  ["maxOutputTokens", "modelConfigFieldMaxOutputTokens", true],
  ["inputCost", "modelConfigFieldInputPrice", false],
  ["outputCost", "modelConfigFieldOutputPrice", false],
  ["cachedInputCost", "modelConfigFieldCacheReadPrice", false],
  ["cacheWriteCost", "modelConfigFieldCacheWritePrice", false],
] as const;

/**
 * Turn the tool's arguments into the patch to merge into a stored model config.
 *
 * Pure, so it can be tested without a provider, a database or a user — which is
 * the only reason the levels bug below was findable at all. It lived in the
 * middle of a function that needed all three, so nothing could ask the executor
 * a question; the only checks anyone had were on the schema the tool *advertises*,
 * and that schema was correct the whole time.
 *
 * Returns `{ error }` for a message to show the model verbatim. The locale
 * decides the language of that message; it defaults to the deployment's own,
 * so a caller that predates the switch keeps the wording it had.
 */
export function buildModelConfigPatch(
  args: Record<string, unknown>,
  locale: Locale = DEFAULT_LOCALE,
):
  | { patch: Record<string, unknown> }
  | { error: string } {
  const patch: Record<string, unknown> = {};
  if (typeof args.displayName === "string" && args.displayName.trim()) {
    patch.displayName = args.displayName.trim();
  }
  if (typeof args.upstreamId === "string" && args.upstreamId.trim()) {
    patch.upstreamId = args.upstreamId.trim();
  }

  /**
   * The purpose, as one of the four words the model row understands.
   *
   * Not a free-text field: a purpose nobody recognises is a model filed
   * nowhere, and the field exists to answer "which group does this belong
   * to" — which has exactly four answers.
   */
  if (args.purpose !== undefined) {
    const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
    if (!(MODEL_PURPOSES as readonly string[]).includes(purpose)) {
      return {
        error: toolRefusal(locale, "modelConfigPurposeInvalid", {
          purposes: MODEL_PURPOSES.join(" / "),
        }),
      };
    }
    patch.purpose = purpose;
  }

  // The levels are words, not a number. This used to sit in the numeric loop,
  // which coerced every value with `Number(...)` — and `Number(["low","high"])`
  // is NaN, so the tool rejected the field it had just advertised with "thinking
  // levels must be a non-negative number". Offered, documented and carried all
  // the way to the database, and unwritable by the only thing that offers it.
  //
  // Validated as a list of non-empty strings here; the envelope names are
  // filtered on the write path, once, for every writer.
  if (args.reasoningLevels !== undefined) {
    const levels = args.reasoningLevels;
    if (!Array.isArray(levels)) {
      return { error: toolRefusal(locale, "modelConfigLevelsNotArray") };
    }
    if (!levels.every((l) => typeof l === "string" && l.trim().length > 0)) {
      return { error: toolRefusal(locale, "modelConfigLevelsNotStrings") };
    }
    if (levels.length > 24) {
      return { error: toolRefusal(locale, "modelConfigLevelsTooMany") };
    }
    // Written even when empty: that is how a model stops offering levels a
    // vendor has withdrawn.
    patch.reasoningLevels = levels.map((l) => l.trim());
  }

  for (const [key, labelKey, mustBeInteger] of NUMERIC_PATCH_FIELDS) {
    const value = args[key];
    if (value === undefined) continue;
    const n = typeof value === "number" ? value : Number(value);
    const label = toolRefusal(locale, labelKey);
    if (!Number.isFinite(n) || n < 0) {
      return { error: toolRefusal(locale, "modelConfigNotANumber", { field: label }) };
    }
    if (mustBeInteger && !Number.isInteger(n)) {
      return { error: toolRefusal(locale, "modelConfigNotAnInteger", { field: label }) };
    }
    patch[key] = n;
  }
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  // Out of the loop above and read as itself. A boolean pushed through
  // `Number(false)` is 0 — a price of nothing rather than a statement about
  // whether a parameter exists — and the difference between a working
  // dropdown and a disabled one in the assistant's settings is exactly this
  // field. Left out entirely when absent, so "not declared" stays distinct from
  // "declared unsupported".
  if (typeof args.reasoningEffortSupported === "boolean") {
    patch.reasoningEffortSupported = args.reasoningEffortSupported;
  }
  // The thinking switch, which fails differently from the levels: a model can
  // take no levels and still obey a disable, or take both and refuse either.
  // Left out entirely when absent, same as above.
  if (typeof args.thinkingSwitchSupported === "boolean") {
    patch.thinkingSwitchSupported = args.thinkingSwitchSupported;
  }

  if (Object.keys(patch).length === 0) {
    return { error: toolRefusal(locale, "noFieldsToChange") };
  }
  return { patch };
}

/**
 * One model's gateway configuration.
 *
 * Merges into the stored config rather than replacing it: a model row carries
 * a context window and prices that an operator may have corrected by hand, and a
 * proposal that silently resets them is worse than no proposal.
 */
/**
 * Configure many models of one provider in a single proposal.
 *
 * This exists because the alternative does not scale. The single-model tool
 * exists and works, but a provider with nine models needs nine calls, and nine
 * calls are nine approvals — the administrator approving the same intention
 * nine times, and nine chances to stop halfway and leave half the catalogue
 * repriced. The user's own words: the assistant should be able to configure a
 * provider in one go.
 *
 * The stored form is a **list of per-model merges**, not a copy of the table.
 * That distinction is the whole reason it can be used for nine models: a copy
 * is only correct until something else writes, and with one proposal per
 * approval this is exactly the moment things do. Each entry is merged into the
 * provider as it stands when it is applied, so a second such proposal, or a
 * `propose_model_config_update` in between, composes with it instead of
 * reverting it.
 */
/**
 * Report what is wrong with a provider's models, by name.
 *
 * The question this answers is "is anything wrong with this", and a model
 * cannot answer it by being asked — it has to be told what to look at. A
 * configuration with five models billing nothing and one priced a hundredth
 * of the going rate is not visibly wrong from the outside; the numbers are
 * plausible, the schema accepts them, and the catalogue prints them. So the
 * known failure modes are checked and named, and the operator is handed a list
 * they can act on in one proposal.
 */
async function auditProviderConfig(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const wanted =
    typeof args.providerId === "string" && args.providerId.trim()
      ? args.providerId.trim()
      : null;
  const providers = await listProviders();
  const subjects = wanted ? providers.filter((p) => p.id === wanted) : providers;
  if (subjects.length === 0) {
    return fail(ctx, wanted ? "providerNotFound" : "noProviders", wanted ? { providerId: wanted } : undefined);
  }

  const report = subjects.map((p) => {
    const configs = (p.modelConfigs ?? {}) as Record<string, Record<string, unknown>>;
    const findings = auditModelConfigs(configs);

    // Beyond the arithmetic: a model that declares the effort parameter
    // unsupported while offering a list of levels is offering a choice that does
    // nothing, and the two fields contradict each other.
    for (const [clientId, cfg] of Object.entries(configs)) {
      const levels = Array.isArray(cfg.reasoningLevels) ? cfg.reasoningLevels : [];
      if (cfg.reasoningEffortSupported === false && levels.length > 0) {
        findings.push({
          code: "unit_mismatch" as const,
          clientId,
          message:
            `声明了「不支持思考等级」，但 reasoningLevels 里又有 ${levels.length} 档` +
            `（${levels.join("/")}）。两个字段互相矛盾：档位下拉会显示一个选了没反应的控件。`,
          blocking: false,
          fields: ["reasoningEffortSupported", "reasoningLevels"],
        });
      }
      // Half-declared, and the two halves fail independently. Without this the
      // gap is invisible until somebody reads the model page, where an
      // undeclared switch is shown as "always on" — a claim about the vendor
      // that nobody in this deployment ever made.
      if (cfg.reasoningEffortSupported === false && cfg.thinkingSwitchSupported == null) {
        findings.push({
          code: "unit_mismatch" as const,
          clientId,
          message:
            "已经声明「不支持思考等级」，但 thinkingSwitchSupported 从来没有声明过。" +
            "这两个是会各自失败的独立字段：只声明一个，模型说明页只能显示「思考开关尚未声明」，" +
            "不会替你断言这个模型能不能关掉思考。要补的话照厂商文档填 true 或 false。",
          blocking: false,
          fields: ["reasoningEffortSupported", "thinkingSwitchSupported"],
        });
      }
      if (cfg.contextLength === undefined || cfg.maxOutputTokens === undefined) {
        findings.push({
          code: "cache_write_unset" as const,
          clientId,
          message: "缺少上下文长度或最大输出，模型目录里会显示为未知。",
          blocking: false,
          fields: ["contextLength", "maxOutputTokens"],
        });
      }
    }

    return {
      provider: p.name,
      providerId: p.id,
      models: Object.keys(configs).length,
      findings: describeFindings(findings),
      healthy: findings.length === 0,
    };
  });

  const total = report.reduce((n, r) => n + r.findings.length, 0);
  return ok({
    summary:
      total === 0
        ? "没有发现问题。"
        : `发现 ${total} 个问题，分列在下面。用 propose_model_configs_update 一次改完。`,
    providers: report,
  });
}

/**
 * The summary an administrator will actually read, with the acknowledgements on it.
 *
 * `confirmFindings` changes nothing about the configuration, so there is no
 * field for it to become. What it does record is a decision, and the decision
 * belongs next to the thing it is about rather than only in the assistant's
 * side of the conversation.
 */
function acknowledgedSummary(summary: string, acknowledged: Finding[]): string {
  if (acknowledged.length === 0) return summary;
  return (
    `${summary}\n已用 confirmFindings 确认无误：` +
    acknowledged.map((f) => `${f.code}:${f.clientId}`).join("、")
  );
}

async function proposeModelConfigsUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  if (!providerId.success) return fail(ctx, "providerIdRequired");

  const raw = args.models;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(ctx, "modelsNotObject");
  }
  const names = Object.keys(raw as Record<string, unknown>);
  if (names.length === 0) return fail(ctx, "modelsEmpty");
  if (names.length > 200) return fail(ctx, "tooManyModels");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(ctx, "providerNotFound", { providerId: providerId.data });

  const live = provider.modelConfigs ?? {};
  const targets: Array<{ clientId: string; patch: Record<string, unknown> }> = [];
  const preview: Record<string, unknown> = { ...live };

  for (const name of names) {
    if (!(name in (provider.modelMapping ?? {})) && !(name in live)) {
      return fail(ctx, "modelNotInProvider", {
        providerName: provider.name,
        model: name,
        existing: Object.keys(provider.modelMapping ?? {}).join(", ") || "（无）",
      });
    }
    const built = buildModelConfigPatch(
      (raw as Record<string, unknown>)[name] as Record<string, unknown>,
      ctx.locale,
    );
    if ("error" in built) return fail(ctx, "modelConfigInvalid", { model: name, error: built.error });
    targets.push({ clientId: name, patch: built.patch });
    preview[name] = { ...(live[name] ?? {}), ...built.patch };
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim()
      ? args.summary.trim()
      : `配置 ${targets.length} 个模型`;

  /**
   * Look at the outcome before offering to write it.
   *
   * Every one of these passes the schema, stores cleanly and bills — which is
   * why five models sat at zero for a day and one at a hundredth of the right
   * rate, with nothing anywhere reporting a problem. The check is deliberately
   * before the proposal: a question asked now is cheap, and the same question
   * asked of the administrator after they approve is not.
   *
   * Two things it is *not*. It does not block on a problem this proposal did not
   * create — a model that is already free stays free whatever else you write,
   * and refusing the write leaves the state exactly as it was while making the
   * model un-editable. And it does not ask a question it gives no way to answer:
   * this used to end with "确认无误就再说一次", which returns the identical
   * refusal. The way out is `confirmFindings`.
   */
  const patches = Object.fromEntries(targets.map((t) => [t.clientId, t.patch]));
  const findings = auditModelConfigs(preview as Record<string, Record<string, unknown>>, { patches });
  const { blocking, acknowledged } = partitionFindings(findings, args.confirmFindings);
  if (blocking.length > 0) {
    return fail(ctx, "findingsBlocked", { details: renderFindingsRefusal(blocking, findings) });
  }

  /**
   * The acknowledgement travels with the proposal.
   *
   * It is not part of the patch — nothing about a model config changes because
   * someone looked at it — so the only place it can go is the proposal's own
   * text, which is what the administrator reads before approving. A free model
   * with nothing on screen saying anyone confirmed it is indistinguishable from
   * one that got free by accident.
   */
  const finalSummary = acknowledgedSummary(summary, acknowledged);

  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("provider.update" as ProposalKind, { modelConfigTargets: targets });
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.update",
    targetId: provider.id,
    summary: finalSummary,
    args: { modelConfigTargets: targets },
    diff: renderProviderDiff(provider, { modelConfigs: preview }, summary),
  });

  return ok({
    actionId: action.id,
    summary,
    provider: provider.name,
    models: targets.map((t) => t.clientId),
    // Not failures, and saying so matters: a price that is merely unusual is
    // not the same as one that is wrong, and the difference is the operator's
    // call rather than this system's.
    warnings: [
      // Whatever the shared proposal check had to say about this payload, which
      // is the same check the apply runs and the one the admin panel's own save
      // runs. A tool that refuses on errors but drops the warnings is showing
      // half of the gate.
      ...gate.warnings,
      ...findings.map((f) => `${f.clientId}：${f.message}`),
      // The ones the operator declared correct travel with the proposal. It is
      // the record of *who* decided a zero price was right — without it the
      // approval screen shows a free model and no indication that anyone ever
      // looked at it.
      ...acknowledged.map(
        (f) => `${f.clientId}：${f.message}（你已用 confirmFindings 确认这是有意的）`,
      ),
    ],
    note: "一次提案，管理员点一次确认；还没生效。",
  });
}

async function proposeModelConfigUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  const clientId = z.string().min(1).safeParse(args.clientId);
  if (!providerId.success || !clientId.success) return fail(ctx, "providerAndClientIdRequired");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(ctx, "providerNotFound", { providerId: providerId.data });

  const existing = (provider.modelConfigs ?? {})[clientId.data];
  if (!existing) {
    return fail(ctx, "modelConfigMissing", {
      providerName: provider.name,
      clientId: clientId.data,
      existing: Object.keys(provider.modelConfigs ?? {}).join(", ") || "（无）",
    });
  }

  const built = buildModelConfigPatch(args, ctx.locale);
  if ("error" in built) {
    return fail(ctx, "modelConfigInvalid", { model: clientId.data, error: built.error });
  }
  const patch = built.patch;

  /**
   * The preview, and only the preview.
   *
   * This used to be what the proposal carried, and the whole record it was
   * built from went with it. Two proposals made minutes apart therefore each
   * held a copy of the provider as it stood when *they* were written, and
   * approving them in a row wrote the second copy over the first one's work:
   * eight approved model-price changes, every status green, one of them in the
   * database. The survivor was whichever was approved last, which is not a
   * coincidence anyone would have predicted.
   *
   * The stored intent is now the model and the fields. The apply reads the
   * provider as it stands at that moment and merges, so the order proposals are
   * approved in stops mattering.
   */
  const preview = { ...(provider.modelConfigs ?? {}) };
  preview[clientId.data] = { ...existing, ...patch };

  /**
   * The same gate the batch tool runs.
   *
   * It used to run here at all, which is the other half of why the batch gate
   * could not be reasoned about: splitting one model off the batch call was a
   * documented way to skip the check, so a fix to the batch tool that did not
   * also land here would have taught the model to route around it.
   */
  const findings = auditModelConfigs(
    preview as Record<string, Record<string, unknown>>,
    { patches: { [clientId.data]: patch } },
  );
  const { blocking, acknowledged } = partitionFindings(findings, args.confirmFindings);
  if (blocking.length > 0) {
    return fail(ctx, "findingsBlocked", { details: renderFindingsRefusal(blocking, findings) });
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";

  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("provider.update" as ProposalKind, { modelConfigTarget: { clientId: clientId.data, patch } });
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.update",
    targetId: provider.id,
    summary: acknowledgedSummary(summary, acknowledged),
    args: { modelConfigTarget: { clientId: clientId.data, patch } },
    diff: renderProviderDiff(provider, { modelConfigs: preview }, summary),
  });

  return ok({
    actionId: action.id,
    summary,
    provider: provider.name,
    model: clientId.data,
    before: {
      displayName: existing.displayName,
      upstreamId: existing.upstreamId,
      contextLength: existing.contextLength,
      maxOutputTokens: existing.maxOutputTokens,
      reasoningLevels: existing.reasoningLevels ?? [],
      inputCost: existing.inputCost,
      outputCost: existing.outputCost,
      ...(existing.cachedInputCost !== undefined
        ? { cachedInputCost: existing.cachedInputCost }
        : {}),
      ...(existing.cacheWriteCost !== undefined
        ? { cacheWriteCost: existing.cacheWriteCost }
        : {}),
      enabled: existing.enabled,
    },
    after: { ...existing, ...patch },
    // Same shape as the batch tool's, including the confirmed ones: an
    // approval that shows a free model with no record of anyone having checked
    // is indistinguishable from one where nobody looked.
    warnings: [
      ...gate.warnings,
      ...findings.map((f) => `${clientId.data}：${f.message}`),
      ...acknowledged.map(
        (f) => `${clientId.data}：${f.message}（你已用 confirmFindings 确认这是有意的）`,
      ),
    ],
  });
}

/** The operator's own chapter, as it stands. */
async function listDocPagesTool(): Promise<ToolResult> {
  const { docPages } = await getSettings();
  return ok({
    pages: docPages ?? [],
    note: "propose_doc_pages 是整份替换。改之前一定要先读这里，否则会把现有页面全删掉。",
  });
}

/**
 * The operator's documentation pages.
 *
 * Whole-list replacement, like `modelMapping`, and for the same reason: a
 * partial write is indistinguishable from "the operator wanted only this one
 * page" until somebody notices the others are gone. The tool says so in its
 * description and in the list tool's own output, because the failure happens
 * silently otherwise.
 */
/**
 * What the model needs to hear about the pages it just proposed.
 *
 * Said here as well as in the approval diff, because the person who can fix it
 * is the model: a page longer than the reader's limit is fine on screen and cut
 * in half on the way back into a conversation. Storage allows 60,000 and the
 * reader stops at 20,000, so the band between them is silent — the page saves,
 * renders, and quietly becomes a page the assistant cannot finish.
 *
 * Pure, so it can be checked without a database or a pending action.
 */
export function docPageAdvice(
  pages: readonly DocPage[],
): { tooLongForAssistant: { id: string; chars: number; limit: number }[]; advice: string } | undefined {
  const overLong = pages.filter((p) => p.body.length > ASSISTANT_PAGE_READ_LIMIT);
  if (overLong.length === 0) return undefined;
  return {
    tooLongForAssistant: overLong.map((p) => ({
      id: p.id,
      chars: p.body.length,
      limit: ASSISTANT_PAGE_READ_LIMIT,
    })),
    advice:
      "这些页面对读者是完整的，但助手读它们时会在 " +
      `${ASSISTANT_PAGE_READ_LIMIT} 字符处被截断——你之后从这一页拿到的会是半张表。` +
      "按语言或能力拆成多页，一页一类再提交。",
  };
}

async function proposeDocPages(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!Array.isArray(args.pages)) return fail(ctx, "pagesNotArray");

  const pages: DocPage[] = [];
  const problems: string[] = [];
  for (const [i, raw] of args.pages.entries()) {
    if (!raw || typeof raw !== "object") {
      problems.push(`pages[${i}] 不是对象`);
      continue;
    }
    const page = raw as Record<string, unknown>;
    const id = typeof page.id === "string" ? page.id.trim() : "";
    const title = typeof page.title === "string" ? page.title.trim() : "";
    const body = typeof page.body === "string" ? page.body : "";
    if (!id) {
      problems.push(`pages[${i}] 缺少 id`);
      continue;
    }
    // Same rule the endpoint enforces, checked here so the administrator reads
    // it before approving rather than after.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      problems.push(`pages[${i}].id「${id}」只能用小写字母、数字和中划线`);
      continue;
    }
    if (!title) {
      problems.push(`pages[${i}] 缺少标题`);
      continue;
    }
    if (body.length > 60_000) {
      problems.push(`pages[${i}] 正文超过 60000 字符`);
      continue;
    }
    pages.push({
      id,
      title,
      body,
      ...(page.hidden === true ? { hidden: true } : {}),
      order: typeof page.order === "number" ? page.order : i,
    });
  }
  const dupes = pages.map((p) => p.id).filter((id, i, all) => all.indexOf(id) !== i);
  for (const dupe of new Set(dupes)) problems.push(`id「${dupe}」重复了`);
  if (problems.length) return fail(ctx, "pagesInvalid", { problems: problems.join("\n- ") });

  const advice = docPageAdvice(pages);

  const { docPages } = await getSettings();
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const before = docPages ?? [];

  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("doc_pages.update" as ProposalKind, { docPages: pages });
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "doc_pages.update",
    targetId: "docPages",
    summary,
    args: { docPages: pages },
    diff: renderDocPagesDiff(before, pages, summary),
  });

  return ok({
    // What the shared check had to say about this payload. The admin panel's
    // own save returns the same list; refusing on errors and dropping the
    // warnings would be half a gate.
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),

    actionId: action.id,
    summary,
    removed: before.filter((b) => !pages.some((p) => p.id === b.id)).map((b) => b.id),
    kept: before.filter((b) => pages.some((p) => p.id === b.id)).map((b) => b.id),
    added: pages.filter((p) => !before.some((b) => b.id === p.id)).map((p) => p.id),
    ...(advice ? { advice } : {}),
  });
}

async function probeProviderHost(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  const baseUrl = z.string().min(1).safeParse(args.baseUrl);
  if (!providerId.success || !baseUrl.success) return fail(ctx, "providerIdAndBaseUrlRequired");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(ctx, "providerNotFound", { providerId: providerId.data });

  const res = await probeUpstream({
    baseUrl: baseUrl.data,
    apiKey: decryptSecret(provider.encryptedApiKey),
    timeoutMs: 20_000,
  });

  return ok({
    provider: provider.name,
    baseUrl: baseUrl.data,
    authenticated: res.ok,
    httpStatus: res.status,
    latencyMs: res.latencyMs,
    upstreamModels: res.models,
    error: res.error ?? null,
  });
}

/**
 * The specs exactly as they are stored.
 *
 * This used to hand over a summary — `capability`, `displayName`, and
 * `method`/`path` hoisted out of the `transport` object they actually live in,
 * with `request`, `response` and `auth` omitted. The model then proposed specs
 * in that shape, because it had only ever seen that shape, and the approval
 * failed with a refusal that said nothing about why. Three times.
 *
 * A spec is a document the model has to reproduce, not a row to be skimmed, so
 * what it is shown is what it must send back. If this ever needs to be
 * shortened, the cut has to be something the write tool also accepts.
 */
function specForTheModel(spec: unknown): unknown {
  return spec;
}

/**
 * Every media provider, its models, and its specs verbatim.
 *
 * Compact, not pretty: this payload is the biggest one any tool returns and it has
 * to survive the turn loop's truncation whole, because half a spec is worse than a
 * summary — it is a spec that looks complete and calls nothing.
 *
 * Alongside the specs, a spec that has fallen behind the template it came from is
 * reported, with the paths. A spec is stored as JSON in the provider row while the
 * template lives in this build, so the two drift apart silently, and the cost of
 * that is not abstract: a change to `MINIMAX_STT_SPEC` was deployed, did not reach
 * production, and the only symptom was a call failing identically while the
 * repository was correct. Reporting it here is what stops that costing anybody a
 * round trip through "paste me the configuration".
 */
/**
 * Every voice this deployment can be spoken with.
 *
 * The same read as `GET /v1/audio/voices`, so the assistant and a client's
 * curl cannot disagree about what exists.
 *
 * Two things are reported rather than smoothed over, because both are the shape
 * of a wrong answer rather than a missing one:
 *
 *  - `models: null` means **not narrowed** — the voice applies to every model
 *    that provider serves — which is not the same claim as "unknown", and
 *    `narrowedBy` says who said what.
 *  - `unavailable` names the providers whose listing could not be read. A short
 *    list next to a silent failure would be read as "that is all there is", and
 *    the model would tell the user the account has no cloned voices when it
 *    simply could not ask.
 */
async function listVoicesTool(): Promise<ToolResult> {
  const { voices, unavailable } = await collectVoiceCatalogue();
  return ok({
    voices: voices.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      models: v.models,
      narrowedBy: v.narrowedBy,
      source: v.source,
      provider: v.provider,
    })),
    unavailable,
  });
}

async function listMediaProvidersTool(full = false): Promise<ToolResult> {
  const media = await listMediaProviders();
  return okCompact(
    media.map((m) => {
      const drift = providerDrift(m.specs as MediaSpec[] | undefined);
      const behind = drift.filter((d) => d.drift.kind === "differs");
      return {
        id: m.id,
        name: m.name,
        baseUrl: m.baseUrl,
        enabled: m.enabled,
        priority: m.priority,
        models: Object.entries(m.models ?? {}).map(([id, cfg]) => ({
          id,
          upstreamId: (cfg as { upstreamId?: string })?.upstreamId ?? id,
          enabled: (cfg as { enabled?: boolean })?.enabled ?? true,
        })),
        // The specs are a summary unless `full` was asked for. This used to be
        // the whole payload, and the reasoning was sound on its own terms — half
        // a spec is worse than none, because it looks complete and calls nothing.
        // But "complete" was measured in one payload rather than in a
        // conversation: one call returned tens of thousands of tokens, while the
        // history that gets summarised is counted in *messages*. A turn could put
        // half a context window into two messages and the summariser, which only
        // wakes on the message count, was never going to notice. It didn't: the
        // turn was cut mid-stream.
        //
        // The summary keeps `transport` **whole**. A summary that hoists `method`
        // and `path` out of it teaches the model a shape that is not the shape,
        // and a proposal built on it fails validation for reasons the model
        // cannot see.
        specs: (m.specs ?? []).map((s) =>
          full
            ? specForTheModel(s)
            : {
                capability: (s as MediaSpec).capability,
                displayName: (s as MediaSpec).displayName,
                models: (s as MediaSpec).models,
                transport: (s as MediaSpec).transport,
              },
        ),
        // The drift report is the reason to call this at all, so it stays in the
        // summary. Trimming the specs must not trim the finding.
        ...(behind.length
          ? {
              templateDrift: behind.map(({ spec, drift: d }) => ({
                capability: spec.capability,
                displayName: spec.displayName,
                templateId: (d as { templateId: string }).templateId,
                paths: (d as { paths: string[] }).paths,
                /**
                 * How to act on it.
                 *
                 * This used to say "click 套用模板 in the admin UI", which is
                 * how the ASR spec lost its file path twice in one day: the
                 * template still reads the audio from `$.image`, the client puts
                 * it in `file`, and re-applying the template walked straight back
                 * into a bug that had already been found, fixed and verified.
                 *
                 * A stored spec is allowed to be *better* than the template it
                 * came from, and "differs" does not say which side is right. So
                 * the pointer is to the template — read it, decide per path, and
                 * change only those paths. `paths` abbreviates values at 60
                 * characters, which is enough to see what moved and not enough
                 * to copy; the value comes from the tool named here.
                 */
                how:
                  `用 get_media_spec_reference(what="templates", capability="${spec.capability}") 取回当前模板的完整值，` +
                  "对照上面的 paths 逐条判断，然后用 propose_media_provider_update 的 specEdits 只改这些字段。" +
                  "不要整份套用模板：已存的 spec 可能带着模板里没有的、故意的修正，整份套用会把它们一起冲掉。" +
                  "paths 里的模板值超过 60 字符会被截断，以工具取回的完整值为准。",
              })),
            }
          : {}),
        ...(full ? {} : { note: "spec 正文未包含；要改某份 spec 时用 full=true 单独取一次。" }),
      };
    }),
  );
}
/**
 * One window of the protocol.
 *
 * The document is ~76 KB of markdown. Sending all of it would cost a large
 * fraction of a turn on a document the model only needs a section of, and the
 * turn loop would truncate it somewhere nobody chose — which is the same failure
 * `MAX_PAGE_CHARS` exists to prevent on the docs side. Paged instead, with the
 * offset handed back so the next call is a lookup rather than a re-read.
 */
const PROTOCOL_CHUNK_CHARS = 12_000;
const MAX_PROTOCOL_CHUNK_CHARS = 40_000;

/**
 * The two things the assistant could not read about a media spec.
 *
 * Both are references rather than configuration, which is why they lived in
 * places a tool call could not reach:
 *
 *  - **The protocol.** `docs/模型适配协议/README.md` is a file, not i18n text, so
 *    `read_docs` on `admin:media` returned the page's prose — which ends by
 *    announcing that the protocol is below it — and none of the protocol. The
 *    model's own conclusion was that it could not read the template body and
 *    should ask the user to paste it.
 *  - **The templates.** `MEDIA_TEMPLATES` is a module value. `list_media_providers`
 *    reports drift against it, but the report's values are abbreviated to 60
 *    characters, so the one field a model most needs — the whole of a missing
 *    `voices` block — arrived as `模板={"remote":{"auth":{"type":"bearer"},"request":{"voice_typ…`.
 *
 * Neither is secret. The protocol is in the repository, and the templates are
 * the operator's own starting points, already summarised by the tool that
 * reports drift. Admin-only for the same reason `list_media_providers` is: it
 * describes this deployment's media surface.
 */
async function mediaSpecReferenceTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const what = args.what === "templates" ? "templates" : "protocol";
  const capability = typeof args.capability === "string" ? args.capability.trim() : "";

  if (what === "templates") {
    const templates = Object.entries(MEDIA_TEMPLATES)
      .map(([id, t]) => ({
        id,
        name: t.name,
        baseUrl: t.baseUrl,
        models: t.models,
        specs: capability ? t.specs.filter((s) => s.capability === capability) : t.specs,
      }))
      .filter((t) => t.specs.length > 0);

    if (templates.length === 0) {
      if (!capability) return fail(ctx, "noMediaTemplates");
      return fail(ctx, "mediaTemplateMissingCapability", {
        capability,
        capabilities: [
          ...new Set(Object.values(MEDIA_TEMPLATES).flatMap((t) => t.specs.map((s) => s.capability))),
        ].join(", "),
      });
    }

    return ok({
      templates,
      note:
        "这些模板是「起点」，不是「正确答案」。已存的 spec 可能带着模板里没有的、故意的本地修正，" +
        "整份套用会把它们冲掉 —— 用 propose_media_provider_update 的 specEdits 按 templateDrift 列出的路径逐条改。",
    });
  }

  const { text, error } = await readProtocolDoc();
  if (!text) {
    return fail(ctx, "mediaProtocolUnreadable", {
      reason: error ?? toolRefusal(ctx.locale, "mediaProtocolUnreadable"),
    });
  }

  const total = text.length;
  const offset = Math.max(0, typeof args.offset === "number" ? Math.trunc(args.offset) : 0);
  const asked = typeof args.limit === "number" ? Math.trunc(args.limit) : PROTOCOL_CHUNK_CHARS;
  const limit = Math.min(Math.max(asked, 1), MAX_PROTOCOL_CHUNK_CHARS);
  const slice = text.slice(offset, offset + limit);
  const end = offset + slice.length;

  return ok({
    total,
    offset,
    returned: slice.length,
    // Absent rather than `null` on the last window: "there is no next one" and
    // "the next one is at position zero" should not look alike.
    ...(end < total ? { nextOffset: end } : {}),
    text: slice,
  });
}

async function proposeProviderUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  if (!providerId.success) return fail(ctx, "missingProviderId");

  const provider = await getProviderById(providerId.data);
  if (!provider) return fail(ctx, "providerNotFound", { providerId: providerId.data });

  const patch: Record<string, unknown> = {};
  // Which per-model fields the `modelMapping` branch below actually writes, so
  // the free-model audit can be scoped to them. See the branch for why it is
  // not simply "every field of every model".
  let mappingTouched: Record<string, Record<string, unknown>> | undefined;
  if (typeof args.baseUrl === "string") patch.baseUrl = args.baseUrl.trim();
  if (typeof args.anthropicBaseUrl === "string") patch.anthropicBaseUrl = args.anthropicBaseUrl.trim();
  if (typeof args.openaiEnabled === "boolean") patch.openaiEnabled = args.openaiEnabled;
  if (typeof args.anthropicEnabled === "boolean") patch.anthropicEnabled = args.anthropicEnabled;
  if (args.anthropicMode === "native" || args.anthropicMode === "translated") {
    patch.anthropicMode = args.anthropicMode;
  }
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    patch.priority = args.priority;
  }
  if (args.activeMode === "simple" || args.activeMode === "advanced") {
    // Only accepted when it means something. Switching a provider that has no
    // rules to "advanced" changes nothing at runtime and reads in the diff like
    // a change that did, so the proposal says so instead of writing it.
    const ruleCount = (provider.textSpecs ?? []).length;
    // A non-empty `textSpecs` in the same call can create the rules this switch
    // would then apply, so it counts. An empty array is not "some rules" — it is
    // the clear-everything form, and switching to advanced on top of it would
    // still change nothing.
    const addsRules = Array.isArray(args.textSpecs) && args.textSpecs.length > 0;
    if (args.activeMode === "advanced" && ruleCount === 0 && !addsRules) {
      return ok({
        status: "needs_attention",
        message:
          `这个服务商现在一条参数规则都没有，切到 advanced 不会改变任何行为 —— ` +
          `引擎读的是同一套「原样透传」。先写规则（textSpecs），再切。`,
        patch: {},
      });
    }
    patch.activeMode = args.activeMode;
  }
  if (typeof args.upstreamFormat === "string") {
    // The enum above has always offered "anthropic" and this check refused it:
    // a value the tool advertises and then rejects is a proposal the
    // administrator can never make. Both of them mean the same thing now —
    // the upstream speaks a protocol the OpenAI side has to be translated
    // into.
    if (
      args.upstreamFormat !== "chat" &&
      args.upstreamFormat !== "responses" &&
      args.upstreamFormat !== "anthropic" &&
      args.upstreamFormat !== "gemini"
    ) {
      return fail(ctx, "upstreamFormatInvalid");
    }
    // The trap worth naming: `responses` means /v1/responses reaches the vendor
    // untouched, but a /v1/chat/completions request still goes to
    // `<base>/chat/completions` — there is no chat-to-responses conversion. A
    // vendor that only serves /v1/responses will 404 a chat client no matter
    // what this is set to, so the proposal says so instead of letting the
    // administrator find out in production.
    if (args.upstreamFormat === "responses" && (patch.openaiEnabled ?? provider.openaiEnabled ?? true)) {
      return ok({
        status: "needs_attention",
        message:
          "上游格式设为 responses 后，客户端调 /v1/responses 时会原样透传；" +
          "但客户端调 /v1/chat/completions 时仍然发往 <API 地址>/chat/completions，" +
          "网关没有 chat→responses 的转换。该厂商如果不提供这个端点，Chat 客户端会拿到 404。" +
          "确认它提供，再把这项一起提交。",
        patch: { upstreamFormat: args.upstreamFormat },
      });
    }
    patch.upstreamFormat = args.upstreamFormat;
  }
  if (args.headers !== undefined) {
    if (args.headers === null) {
      patch.headers = {};
    } else if (typeof args.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
      }
      patch.headers = headers;
    } else {
      return fail(ctx, "headersNotObject");
    }
  }
  if (args.modelMapping && typeof args.modelMapping === "object") {
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.modelMapping as Record<string, unknown>)) {
      if (typeof v === "string") mapping[k] = v;
    }
    patch.modelMapping = mapping;
    // What this proposal actually writes, per model. The free-model audit is
    // scoped to these fields so that a proposal which only renames a model or
    // adds one is not blocked by a price it never touched — the same
    // narrowing `propose_model_configs_bulk` does. An entry that is new to
    // this provider is this proposal's own writing of every field, so it
    // carries all of them; an entry that already existed carries only the
    // field that moved.
    mappingTouched = {};
    // Keep the per-model config in step with the mapping: a model added to the
    // table with no config would fall back to a default context window, which is
    // how a 200k model ends up advertised as 1M.
    const configs: Record<string, unknown> = { ...(provider.modelConfigs ?? {}) };
    for (const [client, upstream] of Object.entries(mapping)) {
      // Keep an existing, already-corrected config rather than overwriting it
      // with the table's generic numbers; only fill in what is missing.
      const existingCfg = configs[client] as Record<string, unknown> | undefined;
      const known = knownModelOrDefault((existingCfg?.upstreamId as string) ?? upstream);
      // Spread first. This used to rebuild the entry from eight known fields,
      // so every field it did not name was dropped on the floor:
      // `cachedInputCost`, `cacheWriteCost`, `reasoningLevels`,
      // `reasoningEffortSupported` and `thinkingSwitchSupported` all silently
      // reverted to their defaults, and the two prices were written as a
      // literal 0 — so asking to add one model to a provider marked every
      // model that provider had as free, with no `all_zero` finding anywhere
      // to notice, because this path never called the audit that would have
      // raised one. The prices and the enabled flag now come from the entry
      // that is already there; only a genuinely new model is still free, and
      // that one goes through `auditModelConfigs` like every other path.
      configs[client] = {
        ...(existingCfg ?? {}),
        upstreamId: upstream,
        clientId: client,
        displayName: (existingCfg?.displayName as string) ?? client,
        contextLength: (existingCfg?.contextLength as number) ?? known.context,
        maxOutputTokens: (existingCfg?.maxOutputTokens as number) ?? known.output,
        inputCost: (existingCfg?.inputCost as number) ?? 0,
        outputCost: (existingCfg?.outputCost as number) ?? 0,
        enabled: (existingCfg?.enabled as boolean) ?? true,
      };
      mappingTouched[client] = existingCfg
        ? { upstreamId: upstream }
        : {
            /**
             * Only what the `modelMapping` argument actually expresses.
             *
             * The tool has no price parameter — asking it to add a model cannot
             * say anything about price, and the zeros it writes are this file's
             * default rather than a statement the model made. Passing the whole
             * built row here put `inputCost`, `outputCost` and `enabled` into
             * the patch, and since `all_zero` names exactly those three fields,
             * **every** newly added model was blocked for declaring itself free.
             *
             * The gate still does its job where the declaration is real: a
             * model that already exists and is being given a price goes through
             * `propose_model_config_update`, whose patch is the model's own
             * fields — so setting a price of zero there is caught, and so is
             * re-enabling one. What is no longer caught is "a new model needs
             * someone to fill in its price", which is the administrator's job
             * on the confirmation screen and not a defect to refuse over.
             */
            upstreamId: upstream,
            clientId: client,
            displayName: client,
            contextLength: known.context,
            maxOutputTokens: known.output,
          };
    }
    for (const gone of Object.keys(configs)) {
      if (!(gone in mapping)) delete configs[gone];
    }
    patch.modelConfigs = configs;
  }

  if (args.textSpecs !== undefined) {
    // Validated here, at proposal time, rather than at apply time.
    //
    // The whole point of a proposal is that the administrator sees a truthful
    // before/after before anything happens. A spec that would be rejected on
    // apply is a spec the administrator approves, and then does not get.
    if (args.textSpecs === null) {
      patch.textSpecs = [];
    } else if (!Array.isArray(args.textSpecs)) {
      return fail(ctx, "textSpecsNotArray");
    } else {
      // Merged by `protocol` rather than replaced: a provider can carry up to
      // three, one per interface, and asking the model to resend all of them to
      // change one is the same trap `modelMapping` warns about above.
      //
      // Read from the raw column rather than through `readTextSpecs`, which
      // returns the parsed spec: re-serialising would rewrite stored bytes and
      // lose anything the parser normalised away.
      const byProtocol = new Map<string, string>();
      for (const raw of provider.textSpecs ?? []) {
        try {
          const protocol = (JSON.parse(raw) as { protocol?: string }).protocol;
          if (typeof protocol === "string") byProtocol.set(protocol, raw);
        } catch {
          // A stored entry that no longer parses is replaced by whatever the
          // model sends for that interface, or left alone if it sends none.
        }
      }

      for (const entry of args.textSpecs as unknown[]) {
        const parsed = parseTextSpec(entry);
        if (!parsed.ok) {
          return fail(ctx, "textSpecInvalid", { errors: parsed.errors.join("\n- ") });
        }
        byProtocol.set(parsed.spec.protocol, JSON.stringify(parsed.spec));
      }

      const list = [...byProtocol.values()];
      const check = validateTextSpecs(list);
      if (!check.ok) {
        return fail(ctx, "textSpecsConflict", { errors: check.errors.join("\n- ") });
      }

      // A rule for an interface nothing calls is saved, looks configured, and
      // never runs. The editor hides the add-button for it; the assistant has to
      // say so out loud, because there is no UI to click here.
      //
      // Read the faces off the *merged* result, not the stored row: a proposal
      // that turns a face off and adds a rule for it in the same breath is
      // exactly the case where the stored value is the wrong one to check.
      const openaiOn =
        typeof patch.openaiEnabled === "boolean" ? patch.openaiEnabled : (provider.openaiEnabled ?? true);
      const anthropicOn =
        typeof patch.anthropicEnabled === "boolean"
          ? patch.anthropicEnabled
          : (provider.anthropicEnabled ?? false);
      const faces: Record<string, boolean> = {
        "openai-chat": openaiOn,
        "openai-responses": openaiOn,
        "anthropic-messages": anthropicOn,
      };
      const offFace = list
        .map((raw) => (JSON.parse(raw) as { protocol: string }).protocol)
        .filter((p) => faces[p] === false);

      patch.textSpecs = list;

      // The other half of the same trap: a rule for an interface nobody calls
      // is inert, and so is a rule in a provider whose mode is `simple` —
      // `activeSpecFor` returns null unless the mode resolves to "advanced".
      // The editor shows both as saved, so the only place the mismatch can be
      // said out loud is here, before the administrator is asked to approve.
      const modeAfter =
        patch.activeMode === "simple" || patch.activeMode === "advanced"
          ? patch.activeMode
          : activeModeOf(provider);
      const modeIssue =
        list.length > 0 && modeAfter !== "advanced"
          ? `这个服务商的参数规则读取模式是 simple，这 ${list.length} 条规则写进去也不会执行。` +
            `在同一份提案里带上 activeMode: "advanced"（或之后单独切换）才会生效。`
          : null;

      if (offFace.length > 0) {
        return ok({
          status: "needs_attention",
          message:
            `协议已经写好，但 ${offFace.join("、")} 这个接口没有被服务：` +
            `规则会被保存，可不会有请求走到它。要让它生效，请在接口路由里让这个接口被服务` +
            `（原样透传，或路由到这家厂商会的协议），再提交一次。` +
            (modeIssue ? `\n${modeIssue}` : ""),
          patch,
        });
      }
      if (modeIssue) {
        return ok({
          status: "needs_attention",
          message: `协议已经写好，但${modeIssue}`,
          patch,
        });
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    return fail(ctx, "noFieldsToChange");
  }
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";

  /**
   * The free-model audit, which this path used to skip entirely.
   *
   * `modelMapping` is the only way to add a model, and adding one builds a
   * config entry — with the prices the branch chose, which were two literal
   * zeros. So asking the model to register one free model marked the whole
   * provider free, and the `all_zero` finding that exists precisely to catch
   * that was never raised here, because `auditModelConfigs` had no call on
   * this path. The tool even declared `confirmFindings` in its schema, so
   * there was a way out that went nowhere.
   *
   * `mappingTouched` scopes the audit to what this proposal writes: an entry
   * it is creating carries all its fields, one that already existed carries
   * only the upstream name if that moved. Nothing here blocks a proposal over
   * a price it did not touch — the same narrowing §5.5 gave the other two
   * tools, and the reason it matters here is that a provider's paid models
   * are all 0/0-adjacent to the `all_zero` rule by being untouched.
   */
  let finalSummary = summary;
  if (mappingTouched && patch.modelConfigs) {
    const findings = auditModelConfigs(patch.modelConfigs as Record<string, Record<string, unknown>>, {
      patches: mappingTouched,
    });
    const { blocking, acknowledged } = partitionFindings(findings, args.confirmFindings);
    if (blocking.length > 0) {
      return fail(ctx, "findingsBlocked", { details: renderFindingsRefusal(blocking, findings) });
    }
    finalSummary = acknowledgedSummary(summary, acknowledged);
  }

  const diff = renderProviderDiff(provider, patch, finalSummary);

  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("provider.update" as ProposalKind, patch);
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.update",
    targetId: provider.id,
    // The acknowledgement is not part of the patch — nothing about the
    // provider changes because someone looked at it — so it rides in the
    // proposal's own text, which is what the administrator reads before
    // approving. A free model with nothing on screen saying anyone confirmed
    // it looks exactly like one that got free by accident.
    summary: finalSummary,
    args: patch,
    diff,
  });

  return ok({
    // What the shared check had to say about this payload. The admin panel's
    // own save returns the same list; refusing on errors and dropping the
    // warnings would be half a gate.
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),

    actionId: action.id,
    status: "pending",
    message: "变更已生成，等待管理员在界面上确认后才会生效。请把下面这份对比原样告诉用户。",
    diff,
  });
}

/**
 * Apply `specEdits` to a provider's specs.
 *
 * Asking a model to re-send the whole spec array is how this went wrong four
 * times in a row: the array is ~15 KB, the model has to reproduce all of it in
 * one tool call, and what arrived was not valid JSON — `_request` where the
 * field is `request`, head and tail intact and the middle mangled. The shape
 * was right because it had just read a real spec; the operation was not
 * reliable because it had to echo a document back verbatim.
 *
 * So the model sends what it wants *changed* and the merge happens here, where
 * it is exact. Only whole-spec work — adding a capability, removing one — still
 * needs the full array, and that is rare and bounded.
 */
export function applySpecEdits(
  current: unknown[],
  edits: unknown,
  locale: Locale = DEFAULT_LOCALE,
): { specs: Record<string, unknown>[]; error?: string; refusal?: Refusal } {
  if (!Array.isArray(edits)) {
    return {
      specs: current as Record<string, unknown>[],
      error: toolRefusal(locale, "specEditsNotArray"),
      refusal: { key: "specEditsNotArray" },
    };
  }

  const specs = JSON.parse(JSON.stringify(current)) as Record<string, unknown>[];
  for (const [i, raw] of edits.entries()) {
    const edit = raw as Record<string, unknown>;
    const index = typeof edit?.index === "number" ? edit.index : -1;
    if (index < 0 || index >= specs.length) {
      const vars = { index: i, value: index, count: specs.length };
      return {
        specs,
        error: toolRefusal(locale, "specEditsIndexOutOfRange", vars),
        refusal: { key: "specEditsIndexOutOfRange", vars },
      };
    }
    // Shallow merge, per spec. A nested override would need the model to
    // reproduce `transport` or `response` wholesale to change one field inside
    // it, which is the same problem one level down.
    const { index: _index, ...overrides } = edit as Record<string, unknown> & { index?: number };
    void _index;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      specs[index] = { ...specs[index], [key]: value };
    }
  }
  return { specs };
}

async function proposeMediaProviderUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  if (!providerId.success) return fail(ctx, "missingProviderId");

  const provider = await getMediaProviderById(providerId.data);
  if (!provider) return fail(ctx, "mediaProviderNotFound", { providerId: providerId.data });

  const patch: Record<string, unknown> = {};
  if (typeof args.baseUrl === "string") patch.baseUrl = args.baseUrl.trim();
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (args.models && typeof args.models === "object") patch.models = args.models;

  if (args.specEdits !== undefined) {
    // Resolved here rather than stored as edits, so the approval still applies
    // a *whole* spec array and the diff the admin reads is the result.
    const merged = applySpecEdits(provider.specs ?? [], args.specEdits, ctx.locale);
    if (merged.refusal) return fail(ctx, merged.refusal.key, merged.refusal.vars);
    patch.specs = merged.specs;
  } else if (Array.isArray(args.specs)) {
    patch.specs = args.specs;
  }

  if (Object.keys(patch).length === 0) return fail(ctx, "noFieldsToChange");

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderMediaDiff(provider, patch, summary);

  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("media_provider.update" as ProposalKind, patch);
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "media_provider.update",
    targetId: provider.id,
    summary,
    args: patch,
    diff,
  });

  return ok({
    actionId: action.id,
    status: "pending",
    message: "变更已生成，等待管理员确认后才会生效。",
    diff,
    // Legal, but worth reading: the same list the admin panel's own save
    // returns, and the one this proposal just passed.
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),
  });
}

/**
 * Propose a brand-new chat provider.
 *
 * **There is no `apiKey` parameter, and that is the whole design.** A key the
 * model handled would be a key in the conversation, in the tool-call arguments
 * persisted beside it, and in `assistant_actions` — three copies of a secret in
 * a place none of them are encrypted. Instead the admin types it into the
 * approval, where it goes straight to the provider row and is encrypted on the
 * way in.
 *
 * So this tool's job is everything *except* the key, and the diff has to say so
 * — a card that looked complete and then needed a field the reader could not
 * see is the same misread as everything else in this round.
 */
async function proposeProviderCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Refused out loud rather than quietly dropped. The whitelist below already
  // makes it impossible to *store* a key here, but a model that put one in the
  // call has already put it in the persisted tool-call row — so the refusal is
  // the model learning not to do that a second time.
  if ("apiKey" in args || "api_key" in args) {
    return fail(ctx, "apiKeyInArguments");
  }

  // Trimmed *before* the length check, not after. `"   "` satisfies
  // `min(1)` and then trims to nothing, which is how a provider ends up with a
  // blank name in the admin's list — created the moment they approve, and with
  // nothing to pick it out by. The same bug once shipped as a 404 on an
  // all-whitespace thread title.
  const name = z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(120)).safeParse(args.name);
  if (!name.success) return fail(ctx, "missingName");

  const spec: Record<string, unknown> = { name: name.data };
  if (typeof args.kind === "string") spec.kind = args.kind;
  if (typeof args.baseUrl === "string") spec.baseUrl = args.baseUrl.trim();
  if (typeof args.upstreamFormat === "string") spec.upstreamFormat = args.upstreamFormat;
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    spec.priority = args.priority;
  }
  if (args.modelMapping && typeof args.modelMapping === "object") {
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.modelMapping as Record<string, unknown>)) {
      if (typeof v === "string") mapping[k] = v;
    }
    if (Object.keys(mapping).length === 0) return fail(ctx, "modelMappingEmpty");
    spec.modelMapping = mapping;
    // Same reason the update path does this: a mapped model with no config
    // falls back to a generic context window, which is how a 200k model ends
    // up advertised as 1M.
    const configs: Record<string, unknown> = {};
    for (const [client, upstream] of Object.entries(mapping)) {
      const known = knownModelOrDefault(upstream);
      configs[client] = {
        upstreamId: upstream,
        clientId: client,
        displayName: client,
        contextLength: known.context,
        maxOutputTokens: known.output,
        // Zero, because this tool has no way to say otherwise — see the gate
        // below. Which is exactly why the gate has to be here: every provider
        // the assistant creates is free until someone edits it, and nothing
        // used to say so before the administrator approved it.
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      };
    }
    spec.modelConfigs = configs;
  }

  if (typeof args.openaiEnabled === "boolean") spec.openaiEnabled = args.openaiEnabled;
  if (typeof args.anthropicEnabled === "boolean") spec.anthropicEnabled = args.anthropicEnabled;
  if (args.anthropicMode === "native" || args.anthropicMode === "translated") {
    spec.anthropicMode = args.anthropicMode;
  }
  if (typeof args.anthropicBaseUrl === "string") {
    // Empty means "derive it from baseUrl", which is stored as NULL — the same
    // distinction the editor makes. `""` would reach the Anthropic client as a
    // base URL of nothing.
    spec.anthropicBaseUrl = args.anthropicBaseUrl.trim() || null;
  }
  if (args.headers !== undefined) {
    if (args.headers === null) {
      spec.headers = {};
    } else if (typeof args.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
      }
      spec.headers = headers;
    } else {
      return fail(ctx, "headersNotObject");
    }
  }

  /**
   * The rules, validated here rather than at approval.
   *
   * Same reason as the update path: a spec the apply would reject is a
   * proposal the administrator approves and then loses. A create has nothing
   * stored to merge against, so the list is exactly what was sent.
   */
  let specs: string[] = [];
  if (args.textSpecs !== undefined) {
    if (args.textSpecs === null) {
      specs = [];
    } else if (!Array.isArray(args.textSpecs)) {
      return fail(ctx, "textSpecsNotArray");
    } else {
      const byProtocol = new Map<string, string>();
      for (const entry of args.textSpecs as unknown[]) {
        const parsed = parseTextSpec(entry);
        if (!parsed.ok) {
          return fail(ctx, "textSpecInvalid", { errors: parsed.errors.join("\n- ") });
        }
        byProtocol.set(parsed.spec.protocol, JSON.stringify(parsed.spec));
      }
      specs = [...byProtocol.values()];
    }
    spec.textSpecs = specs;
  }

  if (args.activeMode === "simple" || args.activeMode === "advanced") {
    if (args.activeMode === "advanced" && specs.length === 0) {
      return ok({
        status: "needs_attention",
        message:
          "新建的服务商没有任何参数规则，advanced 和 simple 在行为上完全一样 —— " +
          "引擎读的是同一套「原样透传」。先给出 textSpecs，再切 advanced。",
        patch: {},
      });
    }
    spec.activeMode = args.activeMode;
  }

  // The same trap as on update, on the create path: rules written without the
  // mode that reads them are stored, displayed, and never executed.
  const modeAfter =
    spec.activeMode === "simple" || spec.activeMode === "advanced"
      ? spec.activeMode
      : specs.length > 0
        ? "advanced" // null infers advanced when rules exist
        : "simple";
  if (specs.length > 0 && modeAfter !== "advanced") {
    return ok({
      status: "needs_attention",
      message:
        `这 ${specs.length} 条规则写进去也不会执行：这个服务商的参数规则读取模式是 simple。` +
        `在同一份提案里带上 activeMode: "advanced" 才会生效。`,
      patch: {},
    });
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";

  /**
   * The free-model audit, which this path skipped like `modelMapping` did.
   *
   * Every model here is written at a literal zero price, so `all_zero` fires on
   * each one — and the refusal names `confirmFindings`, which is declared in
   * this tool's schema but was never read by it. An unconfirmed provider could
   * be created with its models free and enabled, and the diff showed the zeros
   * as an ordinary starting value rather than as something waiting on a
   * decision.
   *
   * Every field is this proposal's own writing, so every field is in scope.
   */
  let finalSummary = summary;
  if (spec.modelConfigs) {
    const configs = spec.modelConfigs as Record<string, Record<string, unknown>>;
    const patches = Object.fromEntries(Object.keys(configs).map((k) => [k, configs[k]]));
    const findings = auditModelConfigs(configs, { patches });
    const { blocking, acknowledged } = partitionFindings(findings, args.confirmFindings);
    if (blocking.length > 0) {
      return fail(ctx, "findingsBlocked", { details: renderFindingsRefusal(blocking, findings) });
    }
    finalSummary = acknowledgedSummary(summary, acknowledged);
  }

  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("provider.create" as ProposalKind, spec);
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "provider.create",
    // The acknowledgement changes nothing about the provider, so it rides in
    // the proposal's own text — which is what the administrator reads before
    // approving. A provider whose models are free with nothing saying anyone
    // confirmed it looks exactly like one that got free by accident.
    summary: finalSummary,
    args: spec,
    diff: renderCreateDiff(spec, summary),
  });

  return ok({
    // What the shared check had to say about this payload. The admin panel's
    // own save returns the same list; refusing on errors and dropping the
    // warnings would be half a gate.
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),

    actionId: action.id,
    status: "pending",
    message:
      "新建请求已生成。还需要管理员在界面上补填 API 密钥并确认，才会产生服务商。请把下面这份内容告诉用户，并说明密钥由管理员自己填。",
    diff: renderCreateDiff(spec, summary),
  });
}

async function proposeMediaProviderCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if ("apiKey" in args || "api_key" in args) {
    return fail(ctx, "apiKeyInArguments");
  }

  const name = z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(120)).safeParse(args.name);
  if (!name.success) return fail(ctx, "missingName");
  if (!args.models || typeof args.models !== "object") {
    return fail(ctx, "missingModels");
  }

  const models = args.models as Record<string, unknown>;
  if (Object.keys(models).length === 0) return fail(ctx, "mediaModelsEmpty");
  for (const [id, cfg] of Object.entries(models)) {
    if (!cfg || typeof cfg !== "object") return fail(ctx, "mediaModelNotObject", { modelId: id });
    if (typeof (cfg as { upstreamId?: unknown }).upstreamId !== "string") {
      return fail(ctx, "mediaModelMissingUpstreamId", { modelId: id });
    }
  }

  const spec: Record<string, unknown> = { name: name.data, models };
  if (typeof args.baseUrl === "string") spec.baseUrl = args.baseUrl.trim();
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    spec.priority = args.priority;
  }
  if (Array.isArray(args.specs)) spec.specs = args.specs;

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderCreateDiff(spec, summary);
  /**
   * The gate between writing a proposal and asking for approval.
   *
   * Every one of these payloads used to be checked only when the
   * administrator pressed 同意 — and the diff they read does not
   * validate, so an invalid payload looked exactly like a valid one
   * right up to the click, and then took the whole proposal down. This
   * is the same call the apply route makes, so the two cannot answer
   * differently about what a proposal may contain.
   */
  const gate = checkProposal("media_provider.create" as ProposalKind, spec);
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "media_provider.create",
    summary,
    args: spec,
    diff,
  });

  return ok({
    // What the shared check had to say about this payload. The admin panel's
    // own save returns the same list; refusing on errors and dropping the
    // warnings would be half a gate.
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),

    actionId: action.id,
    status: "pending",
    message:
      "新建请求已生成。还需要管理员在界面上补填 API 密钥并确认，才会产生服务商。请把下面这份内容告诉用户。",
    diff,
  });
}

/**
 * The before/after a create shows: nothing, then everything.
 *
 * Written by hand rather than reused from the update path because there is no
 * "before" — and the one line that is *not* in the table is the line that
 * matters, so it is stated in the table rather than left to be discovered at
 * the approval.
 */
function renderCreateDiff(spec: Record<string, unknown>, summary: string): string {
  const lines = [`新增：${summary}`, ""];
  for (const [key, value] of Object.entries(spec)) {
    if (key === "modelConfigs" || key === "specs") {
      const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
      lines.push(`  ${key}：${count} 项`);
      continue;
    }
    if (key === "modelMapping") {
      for (const [client, upstream] of Object.entries(value as Record<string, string>)) {
        lines.push(`  modelMapping.${client} → ${upstream}`);
      }
      continue;
    }
    // A rule set is two full protocol documents. Printed as JSON it is a wall
    // of text in which the one thing the administrator needs — which
    // interfaces will be rewritten — is invisible.
    if (key === "textSpecs") {
      const protocols = (value as string[]).map((raw) => {
        try {
          const p = (JSON.parse(raw) as { protocol?: string }).protocol;
          return p ?? "（未知接口）";
        } catch {
          return "（无法解析）";
        }
      });
      lines.push(`  textSpecs：${protocols.length ? protocols.join("、") : "（无）"}`);
      continue;
    }
    if (key === "headers") {
      const entries = Object.entries(value as Record<string, string>);
      lines.push(
        `  headers：${entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("；") : "（无）"}`,
      );
      continue;
    }
    lines.push(`  ${key}：${JSON.stringify(value)}`);
  }
  lines.push("");
  lines.push("  apiKey：（不在这份提议里）批准时由管理员在界面上填写");
  return lines.join("\n");
}

/**
 * The search backends, and what each of them actually talks to.
 *
 * The interesting field is the **endpoint**: a row's address and the spec's
 * path together decide where a request goes, and before the protocol the same
 * column meant two different things depending on the vendor. So the tool
 * reports the resolved endpoint rather than making the model reason about it.
 */
async function listSearchProvidersTool(full = false): Promise<ToolResult> {
  const rows = await listSearchProviders();
  return okCompact(
    rows.map((row) => {
      const config = effectiveSearchConfig(row);
      const drift = config ? config.drift : null;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        priority: row.priority,
        creditsPerCall: row.creditsPerCall,
        hasApiKey: row.encryptedApiKey.length > 0,
        /**
         * The address as it is stored, and the address the request will use.
         *
         * Both, because they can differ: a row written before the protocol
         * keeps the old reading of its address, and a row with a spec has its
         * path appended to the root.
         */
        baseUrl: row.baseUrl || null,
        endpoint: config ? effectiveEndpoint(config) : null,
        legacy: config?.legacy ?? true,
        ...(drift && drift.kind === "differs"
          ? {
              templateDrift: {
                templateId: drift.templateId,
                paths: drift.paths,
                how:
                  "用 get_search_spec_reference(what=\"templates\") 取回当前模板的完整值，" +
                  "对照上面的 paths 逐条判断，然后只改这些路径。整份套用模板会把已存的本地修正一起冲掉。",
              },
            }
          : {}),
        // The spec is a summary unless `full` was asked for. A summary that is
        // not the shape the engine reads teaches a shape that does not work.
        spec: row.spec
          ? full
            ? row.spec
            : {
                vendor: (row.spec as { vendor?: string }).vendor,
                displayName: (row.spec as { displayName?: string }).displayName,
                transport: (row.spec as { transport?: unknown }).transport,
                response: (row.spec as { response?: unknown }).response,
              }
          : null,
        ...(full ? {} : { note: "spec 正文未包含；要改某一条时用 full=true 单独取一次。" }),
      };
    }),
  );
}

/**
 * The search protocol, and the templates that come with it.
 *
 * The same two things the media side needed and could not reach: the protocol
 * is a file, and the templates are a module value. Both are here so a spec can
 * be written against the real text rather than against a recollection of it.
 */
async function searchSpecReferenceTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const what = args.what === "templates" ? "templates" : "protocol";

  if (what === "templates") {
    return ok({
      templates: SEARCH_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        spec: template.spec,
      })),
      note:
        "模板是「起点」，不是「正确答案」。已存的 spec 可能带着模板里没有的、故意的本地修正，" +
        "整份套用会把它们冲掉 —— 用 propose_search_provider_update 按 templateDrift 列出的路径逐条改。",
    });
  }

  const { text, error } = await readSearchProtocolDoc();
  if (!text) {
    return fail(ctx, "searchProtocolUnreadable", {
      reason: error ?? toolRefusal(ctx.locale, "searchProtocolUnreadable"),
    });
  }

  const total = text.length;
  const offset = Math.max(0, typeof args.offset === "number" ? Math.trunc(args.offset) : 0);
  const asked = typeof args.limit === "number" ? Math.trunc(args.limit) : PROTOCOL_CHUNK_CHARS;
  const limit = Math.min(Math.max(asked, 1), MAX_PROTOCOL_CHUNK_CHARS);
  const slice = text.slice(offset, offset + limit);
  const end = offset + slice.length;

  return ok({
    total,
    offset,
    returned: slice.length,
    ...(end < total ? { nextOffset: end } : {}),
    text: slice,
  });
}

async function proposeSearchProviderCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if ("apiKey" in args || "api_key" in args) {
    return fail(ctx, "apiKeyInArguments");
  }

  const name = z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(120)).safeParse(args.name);
  if (!name.success) return fail(ctx, "missingName");
  const kind = z.string().transform((v) => v.trim()).pipe(z.string().min(1).max(60)).safeParse(args.kind);
  if (!kind.success) return fail(ctx, "missingKind");

  const spec: Record<string, unknown> = { name: name.data, kind: kind.data };
  if (typeof args.baseUrl === "string") spec.baseUrl = args.baseUrl.trim();
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    spec.priority = args.priority;
  }
  if (typeof args.creditsPerCall === "number" && Number.isInteger(args.creditsPerCall)) {
    spec.creditsPerCall = args.creditsPerCall;
  }
  if (typeof args.enabled === "boolean") spec.enabled = args.enabled;
  if (args.spec !== undefined && args.spec !== null) spec.spec = args.spec;

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderSearchCreateDiff(spec, summary);

  const gate = checkProposal("search_provider.create" as ProposalKind, spec);
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "search_provider.create",
    summary,
    args: spec,
    diff,
  });

  return ok({
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),
    actionId: action.id,
    status: "pending",
    message:
      "新建请求已生成。还需要管理员在界面上补填 API 密钥并确认，才会产生搜索提供商。请把下面这份内容告诉用户。",
    diff,
  });
}

async function proposeSearchProviderUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const providerId = z.string().min(1).safeParse(args.providerId);
  if (!providerId.success) return fail(ctx, "missingProviderId");

  const provider = await getSearchProviderById(providerId.data);
  if (!provider) return fail(ctx, "searchProviderNotFound", { providerId: providerId.data });

  const patch: Record<string, unknown> = {};
  if (typeof args.kind === "string") patch.kind = args.kind.trim();
  if (typeof args.baseUrl === "string") patch.baseUrl = args.baseUrl.trim();
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  if (typeof args.priority === "number" && Number.isInteger(args.priority)) {
    patch.priority = args.priority;
  }
  if (typeof args.creditsPerCall === "number" && Number.isInteger(args.creditsPerCall)) {
    patch.creditsPerCall = args.creditsPerCall;
  }
  if (args.spec !== undefined) patch.spec = args.spec;

  if (Object.keys(patch).length === 0) {
    return fail(ctx, "noSearchFieldsToChange");
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "未说明的变更";
  const diff = renderSearchProviderDiff(provider, patch, summary);

  const gate = checkProposal("search_provider.update" as ProposalKind, patch);
  if (!gate.ok) return fail(ctx, "proposalRejected", { reason: gate.message! });
  const action = await createAssistantAction({
    userId: ctx.user.id,
    kind: "search_provider.update",
    targetId: provider.id,
    summary,
    args: patch,
    diff,
  });

  return ok({
    ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}),
    actionId: action.id,
    status: "pending",
    message: "变更请求已生成，等管理员在界面上确认。请把下面这份内容告诉用户。",
    diff,
  });
}

/**
 * The before/after a search-provider create shows: nothing, then everything.
 */
function renderSearchCreateDiff(spec: Record<string, unknown>, summary: string): string {
  const lines = [`新增搜索提供商：${summary}`, ""];
  for (const [key, value] of Object.entries(spec)) {
    if (key === "spec") {
      lines.push("  spec：");
      lines.push(
        JSON.stringify(value, null, 2)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      continue;
    }
    lines.push(`  ${key}：${JSON.stringify(value)}`);
  }
  lines.push("");
  lines.push("  apiKey：（不在这份提议里）批准时由管理员在界面上填写");
  return lines.join("\n");
}

async function listUsersTool(): Promise<ToolResult> {  const { users } = await listUsers({ limit: 200 });
  return ok(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      displayName: u.displayName,
      quotaType: u.quotaType,
      quotaLimit: u.quotaLimit,
      quotaUsed: u.quotaUsed,
      maxActiveKeys: u.maxActiveKeys,
      allowedModels: u.allowedModels,
      lastLoginAt: u.lastLoginAt,
    })),
  );
}

/**
 * Why this turn cannot search, as the key of the refusal to use.
 *
 * The three reasons are three different requests, and the old single message
 * asked for the wrong one: "请在输入框旁边打开开关" is a request the user can
 * only carry out when *they* are the one who turned it off. When the
 * administrator turned the feature off there is no such switch — the
 * composer toggle is disabled and the honest answer is "the administrator
 * switched this off", which the model can say and the user can act on by
 * asking the administrator.
 *
 * A key rather than a sentence, because the sentence is read in the reader's
 * language and the three of them live in the table beside every other refusal.
 */
function webSearchOffKey(reason?: "user" | "admin" | "no_backend"): string {
  switch (reason) {
    case "admin":
      return "searchOffByAdmin";
    case "no_backend":
      return "searchNoBackend";
    default:
      return "searchOffThisTurn";
  }
}

/**
 * Search the public web.
 *
 * The tool the assistant was missing: `fetch_page` can read a URL it already
 * knows, and "I need the vendor's API reference" is precisely the case where
 * it does not know one. Without this the model either recites an address from
 * memory (which is how an invented endpoint reaches a spec) or asks the user
 * for a link.
 *
 * A refusal — no backend configured, key rejected, provider throttled — comes
 * back as a *result*, not an exception, for the same reason every other tool
 * does: the model can say what happened, and an exception would end the turn
 * along with everything it had established.
 *
 * ## What it costs
 *
 * **The deployment's provider is charged to the account, exactly like
 * `/v1/search`.** It used to be charged to nobody: this tool went straight to
 * `searchWeb()`, so every search was a free ride on the operator's Tavily /
 * Brave / SearXNG account, invisible in every usage report, and available to
 * an account whose balance was empty. The three other doors (`/v1/search` and
 * the panel's two test buttons) all went through the shared settlement; this
 * one now does too.
 *
 * **The user's own search service is not charged.** Their key paid their
 * vendor; the gateway is a relay there, and charging them for it would be
 * charging them twice.
 */
async function webSearchTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail(ctx, "missingQuery");
  // The user's preference is the ceiling the model may not exceed; the
  // operator's hard limit caps that in turn.
  const cap = Math.min(ctx.webSearchLimit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const fallback = Math.min(DEFAULT_WEB_SEARCH_LIMIT, cap);
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.trunc(args.limit), 1), cap)
      : fallback;

  /**
   * The backend that answered, kept outside the `try` so the catch block can
   * say **which** one failed.
   */
  let backend: SearchBackend | null = null;

  try {
    // The same switch `/v1/search` reads. "Off" has to mean off in both
    // places, or the panel is a button that does not do what it says.
    const config = await loadSearchConfig();
    if (!config.enabled) {
      return fail(ctx, "searchOffByAdmin");
    }
    /**
     * The user's own service first, the deployment's providers after it.
     *
     * The order is money: a user who brought their own search service is
     * paying that vendor, and the deployment's provider is not theirs to
     * spend.
     */
    backend = await resolveSearchBackendForAccount(ctx.user.id);
    if (!backend) {
      return fail(ctx, "searchBackendMissing");
    }

    /**
     * The deployment's providers are the **deployment's** money, spent on the
     * account's behalf — so they need the account identity, exactly like the
     * model calls do.
     *
     * It used to be the other way round: the search was the one path that
     * worked without the assistant credential, so a user who had explicitly
     * switched their credential off could still spend the deployment's search
     * budget through the assistant. The credential is the account's agreement
     * to spend the deployment's resources; a service that skips it is not
     * respecting the switch.
     *
     * The user's **own** search service needs no credential at all: their key
     * pays their vendor, and the deployment spends nothing.
     */
    if (backend.source !== "user") {
      const credential = await getAssistantCredential(ctx.user.id);
      if (!credential?.enabled) {
        return fail(ctx, "searchNeedsCredential");
      }
    }

    // The account's own row: the quota and the balance that gets charged live
    // on the user record, not on the session's copy of it.
    const account = await getUserById(ctx.user.id);
    if (!account) return fail(ctx, "accountNotFound");

    /**
     * Whose bill is it?
     *
     * `none` for the user's own service — their key paid their vendor.
     * `account` for the deployment's providers — the operator paid that
     * vendor, so the account pays the operator.
     */
    const charge = backend.source === "user" ? "none" : "account";

    /**
     * A spend that cannot be seen in any report is a spend nobody can audit.
     *
     * The usage row hangs off a real key, and the usage pages read by key. An
     * account with no key at all has nowhere to put the row, so the call is
     * refused — with the two things that would fix it: a key, or a search
     * service of its own (which is not charged here at all).
     *
     * Only asked for when there is something to charge: the user's own service
     * is not charged, and looking up a key for it would be a query for nothing.
     */
    const apiKeyId = charge === "account" ? await attributionKeyFor(account.id) : "";
    if (charge === "account" && !apiKeyId) {
      return fail(ctx, "searchNoApiKey");
    }

    const settled = await runSearch({
      query,
      limit,
      user: account,
      backend,
      charge,
      ...(apiKeyId ? { apiKeyId } : {}),
    });

    const outcome = settled.outcome;
    if (outcome.results.length === 0) {
      return ok({
        backend: outcome.backend,
        query: outcome.query,
        results: [],
        note:
          "搜索后端没有返回任何结果。换一组关键词再试一次（把厂商名和要找的东西分开写），" +
          "或者直接问用户文档地址；不要凭记忆补一个网址。",
      });
    }
    return ok({
      backend: outcome.backend,
      query: outcome.query,
      results: outcome.results,
      note:
        "这些是搜索摘要，不是文档正文。核对字段名、参数取值和端点之前，先用 fetch_page 打开其中至少一个官方页面。",
    });
  } catch (err) {
    if (err instanceof WebSearchError) {
      /**
       * Which backend failed, and what to do about it.
       *
       * The user's own service failing says nothing about the deployment's
       * providers, and the fix is one click away in the settings — so the
       * message names it. Without that, the model reports a broken search and
       * the user goes looking at the wrong thing.
       */
      const own = backend?.source === "user";
      return fail(ctx, own ? "searchUserBackendFailed" : "searchFailed", { message: err.message });
    }
    return fail(ctx, "searchFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Read a public web page.
 *
 * Available to both tiers: reading a vendor's documentation is not an
 * administrative act, and the model that cannot check a spec is the model that
 * guesses one. The address checks live in `web-fetch` — the point of routing
 * through it rather than calling `fetch` here is that they are the feature.
 *
 * A refusal comes back as a *result*, not an exception. "That URL is on the
 * private network" is a fact the model can report and work around; an
 * exception would end the turn and lose whatever it had already established.
 */
async function fetchPageTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = z.string().min(1).max(2000).safeParse(args.url);
  if (!url.success) return fail(ctx, "missingUrl");
  try {
    const page = await fetchPage(url.data);
    return ok({
      url: page.finalUrl,
      status: page.status,
      contentType: page.contentType || "text/plain",
      bytes: page.bytes,
      truncated: page.truncated,
      // Named explicitly: a body that came from somewhere else must not read
      // as if the requested URL contained it.
      ...(page.source ? { source: page.source } : {}),
      ...(page.discovered && page.discovered.length > 0
        ? { discovered: page.discovered, note: "以下地址可以用 fetch_page 继续读。" }
        : {}),
      text: page.text,
    });
  } catch (err) {
    if (err instanceof WebFetchError) return fail(ctx, "webFetchRefused", { message: err.message });
    return fail(ctx, "fetchFailed", { message: err instanceof Error ? err.message : String(err) });
  }
}

/** Exposed for the test route so it resolves a model the same way the proxy does. */
export async function findMediaModel(model: string) {
  return resolveMediaProviderForModel(model);
}
