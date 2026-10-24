/**
 * tests/unit/model-groups.test.ts
 *
 * The models an account may be given, grouped by kind.
 *
 * The picker used to list every model in one flat alphabet, which turned
 * "grant this account the image models" into a reading exercise. The grouping
 * has to be right in a particular way: the media models are grouped by the
 * capability of the spec that serves them — the same rule the model catalogue
 * uses to tell a client that a model produces images rather than text — so the
 * picker and the catalogue can never disagree about what a model is.
 */
import { describe, it, expect } from "vitest";
import { groupAllowedModels, groupModelsByKind } from "@/lib/admin/model-groups";
import type { Provider } from "@/lib/db/types";
import type { MediaProvider, MediaSpec } from "@/lib/media/spec";

function provider(
  modelMapping: Record<string, string>,
  modelConfigs: Record<string, unknown> = {},
): Provider {
  return {
    id: "p1",
    name: "Chat vendor",
    kind: "openai",
    baseUrl: "https://api.example.com/v1",
    encryptedApiKey: "encrypted",
    modelMapping,
    modelConfigs,
    enabled: true,
    priority: 1,
    headers: {},
    upstreamFormat: "responses",
    openaiEnabled: true,
    anthropicEnabled: false,
    anthropicBaseUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Provider;
}

function spec(capability: string, models?: string[]): MediaSpec {
  return {
    specVersion: 1,
    capability,
    ...(models ? { models } : {}),
    transport: { method: "POST", path: "/v1/images/generations" },
  } as unknown as MediaSpec;
}

function mediaProvider(
  models: string[],
  specs: MediaSpec[],
): MediaProvider {
  return {
    id: "m1",
    name: "Media vendor",
    baseUrl: "https://api.example.com",
    encryptedApiKey: "encrypted",
    enabled: true,
    priority: 1,
    models: Object.fromEntries(
      models.map((model) => [model, { upstreamId: model, pricePerItem: 0, enabled: true }]),
    ),
    specs,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MediaProvider;
}

describe("grouping the models by kind", () => {
  it("puts the conversation providers' models under text", () => {
    const groups = groupModelsByKind([provider({ "MiniMax-M3": "MiniMax-M3" })], []);
    expect(groups).toEqual([{ kind: "chat", models: ["MiniMax-M3"] }]);
  });

  it("puts each media model under the capability of the spec that serves it", () => {
    const groups = groupModelsByKind(
      [],
      [
        mediaProvider(
          ["image-01", "video-01", "speech-2.8", "asr-1.0", "translate-1", "music-1"],
          [
            spec("image.generate", ["image-01"]),
            spec("video.generate", ["video-01"]),
            spec("audio.tts", ["speech-2.8"]),
            spec("audio.stt", ["asr-1.0"]),
            spec("audio.translate", ["translate-1"]),
            spec("music.generate", ["music-1"]),
          ],
        ),
      ],
    );
    expect(groups.map((g) => g.kind)).toEqual([
      "image",
      "video",
      "tts",
      "stt",
      "translate",
      "music",
    ]);
    expect(groups.find((g) => g.kind === "image")?.models).toEqual(["image-01"]);
    expect(groups.find((g) => g.kind === "music")?.models).toEqual(["music-1"]);
  });

  it("puts both image capabilities in one group", () => {
    const groups = groupModelsByKind(
      [],
      [
        mediaProvider(
          ["image-01", "image-edit"],
          [spec("image.generate", ["image-01"]), spec("image.edit", ["image-edit"])],
        ),
      ],
    );
    expect(groups).toEqual([{ kind: "image", models: ["image-01", "image-edit"] }]);
  });

  it("shows the text group first, then the media kinds", () => {
    const groups = groupModelsByKind(
      [provider({ "MiniMax-M3": "MiniMax-M3" })],
      [mediaProvider(["image-01"], [spec("image.generate", ["image-01"])])],
    );
    expect(groups.map((g) => g.kind)).toEqual(["chat", "image"]);
  });

  it("leaves out a group with no models", () => {
    // An empty heading is a question the reader has to answer.
    const groups = groupModelsByKind(
      [],
      [mediaProvider(["image-01"], [spec("image.generate", ["image-01"])])],
    );
    expect(groups.map((g) => g.kind)).toEqual(["image"]);
  });

  it("sorts the models inside a group", () => {
    const groups = groupModelsByKind([provider({ "b-model": "b", "a-model": "a" })], []);
    expect(groups[0].models).toEqual(["a-model", "b-model"]);
  });

  it("gives a model that both catalogues offer to the media group", () => {
    // The more specific answer wins: a model offered as an image is not a text
    // model, whatever else it is.
    const groups = groupModelsByKind(
      [provider({ "image-01": "image-01" })],
      [mediaProvider(["image-01"], [spec("image.generate", ["image-01"])])],
    );
    expect(groups).toEqual([{ kind: "image", models: ["image-01"] }]);
  });

  it("uses the spec that names the model, not the first one", () => {
    // The same rule the catalogue follows: a provider can hold several
    // capabilities, and "the first spec" is not an answer.
    const groups = groupModelsByKind(
      [],
      [
        mediaProvider(
          ["video-01", "image-01"],
          [spec("video.generate"), spec("image.generate", ["image-01"])],
        ),
      ],
    );
    // `video-01` is served by the unscoped spec (the first one that serves
    // every model of its capability), `image-01` by the spec that names it.
    expect(groups.find((g) => g.kind === "image")?.models).toEqual(["image-01"]);
    expect(groups.find((g) => g.kind === "video")?.models).toEqual(["video-01"]);
  });
});

describe("a model that is not a conversation model", () => {
  it("is filed under the purpose the operator declared", () => {
    // A vector model and a conversation model are both rows of the same
    // table, and only the operator knows which is which — so the grouping asks
    // the row, not the name.
    const groups = groupModelsByKind(
      [
        provider(
          { "MiniMax-M3": "MiniMax-M3", "text-embedding-3-small": "text-embedding-3-small" },
          {
            "text-embedding-3-small": {
              upstreamId: "text-embedding-3-small",
              clientId: "text-embedding-3-small",
              purpose: "embedding",
            },
          },
        ),
      ],
      [],
    );
    expect(groups.map((g) => g.kind)).toEqual(["chat", "embedding"]);
    expect(groups.find((g) => g.kind === "chat")?.models).toEqual(["MiniMax-M3"]);
    expect(groups.find((g) => g.kind === "embedding")?.models).toEqual([
      "text-embedding-3-small",
    ]);
  });

  it("keeps every kind of non-conversation model in its own group", () => {
    const groups = groupModelsByKind(
      [
        provider(
          { a: "a", b: "b", c: "c" },
          {
            a: { upstreamId: "a", clientId: "a", purpose: "embedding" },
            b: { upstreamId: "b", clientId: "b", purpose: "rerank" },
            c: { upstreamId: "c", clientId: "c", purpose: "moderation" },
          },
        ),
      ],
      [],
    );
    expect(groups.map((g) => g.kind)).toEqual(["embedding", "rerank", "moderation"]);
  });

  it("files a row that declares nothing under the conversation models", () => {
    // A row written before the field existed is a conversation model — that is
    // what the rows were for.
    const groups = groupModelsByKind([provider({ "MiniMax-M3": "MiniMax-M3" })], []);
    expect(groups.map((g) => g.kind)).toEqual(["chat"]);
  });
});

describe("the models an account was granted", () => {
  const groups = groupModelsByKind(
    [provider({ "MiniMax-M3": "MiniMax-M3", "agnes-2.5": "agnes-2.5" })],
    [mediaProvider(["image-01"], [spec("image.generate", ["image-01"])])],
  );

  it("are grouped by kind, keeping only the granted ones", () => {
    const { groups: used } = groupAllowedModels(["MiniMax-M3", "image-01"], groups);
    expect(used.map((g) => g.kind)).toEqual(["chat", "image"]);
    expect(used[0].models).toEqual(["MiniMax-M3"]);
    expect(used[1].models).toEqual(["image-01"]);
  });

  it("keep a model the catalogue no longer knows about", () => {
    // It was granted before it was taken out of the catalogue, and the
    // account can still call it — so it has to be shown somewhere.
    const { groups: used, others } = groupAllowedModels(
      ["MiniMax-M3", "retired-model"],
      groups,
    );
    expect(used.map((g) => g.kind)).toEqual(["chat"]);
    expect(others).toEqual(["retired-model"]);
  });

  it("say nothing when the account has none", () => {
    const { groups: used, others } = groupAllowedModels([], groups);
    expect(used).toEqual([]);
    expect(others).toEqual([]);
  });
});
