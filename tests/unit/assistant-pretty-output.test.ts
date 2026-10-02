/**
 * tests/unit/assistant-pretty-output.test.ts
 *
 * The "pretty output" switch: rendered Markdown with reasoning folded away, or
 * the model's text exactly as written. The switch is the whole feature, so both
 * ends of it and the pieces it composes are pinned here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitThinking, splitLinks, toolContentForDisplay } from "@/app/(user)/dashboard/assistant/MediaArtifacts";
import { parsePretty } from "@/lib/assistant/pretty";

const SRC = join(process.cwd(), "src");
const CHAT = readFileSync(join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"), "utf-8");
const SHEET = readFileSync(join(SRC, "components", "ui", "Sheet.tsx"), "utf-8");
const ARTIFACT_ROUTE = readFileSync(
  join(SRC, "app", "api", "assistant", "artifacts", "[id]", "route.ts"),
  "utf-8",
);

/** The source of one exported function, up to the next one. */
function sourceOf(file: string, name: string): string {
  const start = file.indexOf(`export function ${name}`);
  expect(start, `${name} is not exported any more`).toBeGreaterThanOrEqual(0);
  const rest = file.slice(start + 1);
  const next = rest.indexOf("export function ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("assistant: folding the reasoning away", () => {
  it("separates thinking from the answer", () => {
    const { thinking, answer } = splitThinking(
      "<think>用户想要一张图。选 image-01。</think>已经生成好了。",
    );
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toBe("用户想要一张图。选 image-01。");
    expect(answer).toBe("已经生成好了。");
  });

  it("handles more than one thinking block and interleaved text", () => {
    const { thinking, answer } = splitThinking(
      "开头。<think>一</think>中间。<think>二</think>结尾。",
    );
    expect(thinking).toEqual(["一", "二"]);
    // Removing a block leaves a paragraph break rather than welding the
    // sentences together, which is what the rendered form wants.
    expect(answer).toBe("开头。\n\n中间。\n\n结尾。");
  });

  it("keeps the reasoning rather than discarding it", () => {
    // Deleting a model's words is a worse thing to do than moving them.
    const { thinking } = splitThinking("<think>重要的推理</think>答");
    expect(thinking[0]).toBe("重要的推理");
  });

  it("copes with an unterminated block", () => {
    const { thinking, answer } = splitThinking("<think>说到一半就断了");
    expect(thinking).toHaveLength(1);
    expect(answer).toBe("");
  });

  it("leaves an answer with no reasoning alone", () => {
    const { thinking, answer } = splitThinking("就是一句话。");
    expect(thinking).toEqual([]);
    expect(answer).toBe("就是一句话。");
  });
});

describe("assistant: the pretty switch", () => {
  it("defaults to pretty, and only a stored off turns it off", () => {
    expect(parsePretty(null)).toBe(true);
    expect(parsePretty(undefined)).toBe(true);
    expect(parsePretty("")).toBe(true);
    expect(parsePretty("1")).toBe(true);
    // A cleared, hand-edited or older value must not leave someone stuck in a
    // mode they cannot identify.
    expect(parsePretty("something-else")).toBe(true);
    expect(parsePretty("0")).toBe(false);
    expect(parsePretty("off")).toBe(false);
    expect(parsePretty("false")).toBe(false);
  });

  it("lives in localStorage, like the theme choice", () => {
    expect(readFileSync(join(SRC, "lib", "assistant", "pretty.ts"), "utf-8")).toContain(
      "relayab-assistant-pretty",
    );
  });

  it("is read after mount rather than during render", () => {
    // Reading it during render would flash the raw form at someone whose
    // stored choice is "pretty".
    const effect = CHAT.slice(CHAT.indexOf("setPretty(readPretty())") - 400);
    expect(effect.slice(0, effect.indexOf("setPretty(readPretty())"))).toContain("useEffect");
  });

  it("passes the switch into the renderer, so it actually decides the form", () => {
    expect(CHAT).toMatch(/<AssistantBody[\s\S]{0,300}pretty=\{pretty\}/);
  });

  it("offers the switch in the settings drawer", () => {
    expect(CHAT).toContain("assistant.pretty.switch");
    expect(CHAT).toMatch(/checked=\{pretty\}[\s\S]{0,160}writePretty\(e\.target\.checked\)/);
  });
});

describe("assistant: a picture with a label and a way to keep it", () => {
  const body = readFileSync(
    join(SRC, "app", "(user)", "dashboard", "assistant", "MediaArtifacts.tsx"),
    "utf-8",
  );

  it("puts the details beside the file, not under it", () => {
    const media = sourceOf(body, "MediaArtifacts");
    // A caption under a wide picture puts the two things a reader wants - what
    // it is and where it lives - at the far edge of the column.
    expect(media).toMatch(/className="flex flex-col gap-3 sm:flex-row sm:items-start"/);
    expect(media).toMatch(/className="min-w-0 flex-1 space-y-2\.5"/);
    expect(media).not.toContain("figcaption");
  });

  it("labels the kind, the format and the link, and says the size only when it knows it", () => {
    const media = sourceOf(body, "MediaArtifacts");
    for (const row of ["类型", "格式", "大小", "链接"]) {
      expect(media, `missing the ${row} row`).toContain(row);
    }
    expect(media).toContain("artifact.url");
    // A linked file was never measured, so the row is conditional rather than
    // filled with a plausible number.
    expect(media).toMatch(/\{size && \(/);
  });

  it("makes the download a button, not a word in a caption", () => {
    const media = sourceOf(body, "MediaArtifacts");
    expect(media).toContain("buttonVariants");
    expect(media).toMatch(/<a[\s\S]{0,200}\?dl=1[\s\S]{0,120}download/);
  });

  it("downloads through our own route rather than linking at a redirect", () => {
    // A `download` attribute is not honoured once the browser has followed a hop
    // to another origin, so a download has to be streamed by us.
    expect(ARTIFACT_ROUTE).toContain('searchParams.get("dl") === "1"');
    expect(ARTIFACT_ROUTE).toContain("Content-Disposition");
    // And the cheap path - someone just looking at a picture - still redirects.
    expect(ARTIFACT_ROUTE).toMatch(/if \(!wantsDownload\) return NextResponse\.redirect/);
  });

  it("renders the picture here and nowhere else", () => {
    // One place. Two was what made every generated image appear twice.
    const withImg = body.match(/<img\b/g)?.length ?? 0;
    expect(withImg).toBe(1);
    expect(sourceOf(body, "AssistantBody")).not.toContain("<img");
    expect(sourceOf(body, "MediaArtifacts")).toContain("<img");
  });

  it("carries a size only when one is known", () => {
    const ref = readFileSync(join(SRC, "lib", "db", "assistant-artifacts.ts"), "utf-8");
    expect(ref).toMatch(/bytes: row\.bytes \? row\.bytes\.byteLength : null/);
    expect(ref).toMatch(/bytes: number \| null/);
  });
});

describe("assistant: the drawer finally has padding", () => {
  it("pads the panel, so the heading is not flush with the edge", () => {
    // Every child supplying its own inset is why the two drawers kept looking
    // wrong in different places.
    expect(SHEET).toMatch(/"fixed z-50 gap-4 bg-background p-5 shadow-lg/);
  });

  it("and that panel is only used by the assistant", () => {
    const users = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".tsx") && readFileSync(full, "utf-8").includes("SheetContent")) {
          users.add(entry.name);
        }
      }
    };
    walk(join(SRC, "app"));
    expect([...users]).toEqual(["AssistantChat.tsx"]);
  });
});

describe("assistant: links survive Markdown rendering", () => {
  it("are still split out before the renderer escapes them", () => {
    const segments = splitLinks("看这里 /api/assistant/artifacts/abc 就这个");
    expect(segments.some((s) => s.kind === "link")).toBe(true);
  });

  it("and a tool result still hides the artefact array", () => {
    expect(
      toolContentForDisplay(JSON.stringify({ ok: true, artifacts: [{ id: "a" }] })),
    ).not.toContain("artifacts");
  });
});
