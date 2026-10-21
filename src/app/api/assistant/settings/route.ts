/**
 * app/api/assistant/settings/route.ts
 *
 * The caller's own upstream configuration for the assistant.
 *
 *   GET    /api/assistant/settings      → public view (never the key)
 *   PUT    /api/assistant/settings      → create or update
 *   DELETE /api/assistant/settings      → forget
 *   POST   /api/assistant/settings      → probe without saving
 *
 * The assistant runs on the user's own key rather than on the admin's
 * providers, so this is per-account and the key is encrypted with the same
 * master key as everything else. A blank `apiKey` on PUT keeps the stored one,
 * which is what lets the settings form save a changed model without the browser
 * ever holding the key again.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { listSearchProviders } from "@/lib/db/search-providers";
import {
  getPublicAssistantSettings,
  getAssistantSettings,
  saveAssistantSettings,
  deleteAssistantSettings,
  AssistantSettingsError,
} from "@/lib/db/assistant";
import { probeUpstream } from "@/lib/assistant/client";
import { isPrivateSearchAddress } from "@/lib/search/user";
import { MAX_SEARCH_RESULTS } from "@/lib/assistant/web-search";

export const dynamic = "force-dynamic";

/**
 * What the form may write.
 *
 * `baseUrl` and `model` are blankable because the account path has no upstream
 * of its own: a row still has to exist to remember which model the account path
 * uses, and the key-path fields are simply not in use there. Which of them
 * actually has to be filled is decided per mode below, not by the shape of the
 * request.
 */
const PutSchema = z.object({
  baseUrl: z.string().max(500).optional().default(""),
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional().default(""),
  credentialMode: z.enum(["account", "key"]).nullable().optional(),
  accountModel: z.string().max(200).nullable().optional(),
  protocol: z.enum(["openai"]).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  // Nullable, not optional-and-defaulted: an empty box sends `null` and has
  // to mean "stop sending this". Optional alone would make clearing the box
  // a no-op, and a stored temperature would outlive the form that set it.
  contextLength: z.number().int().positive().max(100_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(100_000_000).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  // Free text, because the levels are published per model and some models can
  // switch thinking off entirely. A closed list here would be wrong for most of
  // the models on a deployment, and the request would carry a value the vendor
  // ignores or refuses.
  reasoningEffort: z.string().min(1).max(64).nullable().optional(),
  // Whether it thinks, which the level above cannot express. A schema that
  // named only the effort would strip this — the field would be accepted by
  // the form, dropped on save, and read back as "never configured", with
  // nothing to tell the user that it had been set.
  thinkingType: z.string().min(1).max(64).nullable().optional(),
  // Web-search preferences. Nullable because "not chosen" is a real state:
  // null means the default (on, six results), and a later change to the
  // default should still reach a user who never touched these.
  webSearchDefault: z.boolean().nullable().optional(),
  webSearchLimit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).nullable().optional(),
  // The user's own search service. The address is one complete endpoint URL —
  // what they paste is what gets called — and the key is optional, because a
  // service on their own machine may not want one.
  //
  // Null clears the address; the source says which of the two the assistant
  // searches. `null` for the key is the explicit "delete it", which a blank
  // password box cannot express.
  searchBaseUrl: z.string().max(500).nullable().optional(),
  searchSource: z.enum(["deployment", "own"]).nullable().optional(),
  /**
   * Which of the deployment's search services the assistant searches with.
   *
   * Null is "the one the deployment serves by default". A name that does not
   * exist is refused at save time, where the person who picked it is looking
   * at the message — a stored name nobody can use is a setting that fails
   * later, in the middle of a conversation.
   */
  searchServiceId: z.string().trim().max(64).nullable().optional(),
  searchApiKey: z.string().max(500).nullable().optional(),
});

const ProbeSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  apiKey: z.string().min(1, "需要 API 密钥").max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

function unauthorized(): Response {
  return NextResponse.json(
    { ok: false, error: { code: "unauthenticated", message: "Login required" } },
    { status: 401 },
  );
}

/**
 * An address a request can actually be sent to.
 *
 * The same rule the search engine applies to a provider's address, and for the
 * same reason: an address that is not http(s) is not a search service, and
 * storing it only defers the error to the moment somebody searches.
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();

  const settings = await getPublicAssistantSettings(me.id);
  return NextResponse.json({ ok: true, data: { settings } });
}

export async function PUT(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const existing = await getAssistantSettings(me.id);
  const mode = data.credentialMode === undefined ? (existing?.credentialMode ?? null) : data.credentialMode;

  /**
   * Only the mode being switched *to* is held to its own requirements.
   *
   * Validating both would make a person who keeps a key-path configuration also
   * maintain an account-path one they are not using, and the form would refuse
   * to save a working configuration over a field that is not on screen. What is
   * refused is the state that would be left behind: choosing a mode whose
   * required field is blank.
   */
  const modelForMode = mode === "account" ? data.accountModel : data.model;
  const modelStored = mode === "account" ? existing?.accountModel : existing?.model;
  if (mode === "account" && !(modelForMode ?? "").trim() && !(modelStored ?? "").trim()) {
    return NextResponse.json(
      { ok: false, error: { code: "no_model", message: "用账号身份需要一个模型：请从列表里选一个。" } },
      { status: 400 },
    );
  }
  if (mode === "key") {
    if (!data.baseUrl.trim()) {
      return NextResponse.json(
        { ok: false, error: { code: "no_upstream", message: "用自己的密钥需要填写接口地址。" } },
        { status: 400 },
      );
    }
    if (!data.model.trim()) {
      return NextResponse.json(
        { ok: false, error: { code: "no_model", message: "用自己的密钥需要填写模型名。" } },
        { status: 400 },
      );
    }
  }

  /**
   * The search service's address, checked before it is stored.
   *
   * A mistyped address is the one configuration mistake that is invisible
   * until a search is attempted — and the search then fails every time, with a
   * message about the *vendor* rather than about the address. So the address is
   * checked here, where the person who typed it is looking at the message.
   */
  const searchUrl = (data.searchBaseUrl ?? "").trim();
  if (searchUrl && !isHttpUrl(searchUrl)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bad_search_url",
          message: "搜索接口地址必须是一个 http(s) 地址（要写完整端点，例如 https://example.com/v1/search）。",
        },
      },
      { status: 400 },
    );
  }

  /**
   * An address on the deployment's own network is not the user's service.
   *
   * The request is made by the gateway, so `127.0.0.1` here is the gateway's
   * own port and `169.254.169.254` is the cloud metadata endpoint — the
   * deployment's insides, reachable by whoever typed the address. A user's
   * service has to be somewhere the gateway can reach over the internet.
   *
   * Refused here, where the person who typed it is looking at the message.
   * The names that resolve to a private address are caught when the request is
   * made, because that is the check that sees the address the request really
   * goes to.
   */
  if (searchUrl && isPrivateSearchAddress(searchUrl)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "private_search_url",
          message:
            "这个地址指向内网。请求是由本中转站发出的，所以它只能填公网上能访问到的地址" +
            "（本机、局域网、云厂商的元数据地址都不行）。",
        },
      },
      { status: 400 },
    );
  }

  /**
   * Choosing "my own service" without an address would leave the assistant
   * searching through the deployment's provider instead — silently, and the
   * opposite of what was asked for. So it is refused here rather than quietly
   * doing something else.
   *
   * The address checked is the one that will be **in effect after this save**,
   * not the one already stored: clearing the address while asking for "my own"
   * is exactly the state that must not be saved.
   */
  const searchSource =
    data.searchSource === undefined ? (existing?.searchSource ?? null) : data.searchSource;
  const searchUrlEffective = (
    data.searchBaseUrl === undefined ? (existing?.searchBaseUrl ?? "") : (data.searchBaseUrl ?? "")
  ).trim();
  if (searchSource === "own" && !searchUrlEffective) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "no_search_url",
          message: "选择用自己的搜索服务就需要填它的接口地址。",
        },
      },
      { status: 400 },
    );
  }

  /**
   * The named service has to be one of the deployment's.
   *
   * Checked here rather than at search time: a name that does not exist is a
   * mistake in the form, and the form is where somebody can still do
   * something about it. And a name that exists but cannot answer is a
   * different thing — that one is the administrator's to fix, and the panel
   * says so.
   */
  const wantedService = (data.searchServiceId ?? "").trim();
  if (wantedService) {
    const services = await listSearchProviders();
    const known = services.some((row) => row.serviceId === wantedService);
    if (!known) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "unknown_search_service",
            message: `没有叫「${wantedService}」的搜索服务，请重新选一个。`,
          },
        },
        { status: 400 },
      );
    }
  }

  try {
    await saveAssistantSettings(me.id, data);
  } catch (err) {
    if (err instanceof AssistantSettingsError) {
      return NextResponse.json(
        { ok: false, error: { code: "missing_key", message: err.message } },
        { status: 400 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true, data: { settings: await getPublicAssistantSettings(me.id) } });
}

/**
 * Probe a candidate configuration *without* saving it.
 *
 * Saving first and discovering afterwards that the base URL is wrong leaves a
 * broken assistant behind; this lets the settings form check first.
 */
export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = ProbeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const result = await probeUpstream({
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    ...(parsed.data.extraHeaders ? { extraHeaders: parsed.data.extraHeaders } : {}),
  });

  return NextResponse.json({ ok: true, data: { probe: result } });
}

export async function DELETE(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  await deleteAssistantSettings(me.id);
  return NextResponse.json({ ok: true, data: { deleted: true } });
}
