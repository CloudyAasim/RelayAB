/**
 * tests/unit/stream-rewrite.test.ts
 *
 * `sseRewrite`, and the one way it can hang.
 *
 * ## The bug this file exists for
 *
 * A `pull` that enqueues nothing is **not** followed by another pull: the
 * stream waits for the next read request, and the consumer is waiting for the
 * very bytes that pull was supposed to produce. A mapper that has no use for a
 * line — the usage frame, the `event:` line, a keep-alive — therefore used to
 * be able to stall the stream dead.
 *
 * It was not a corner case. An upstream that sends its frames one at a time
 * puts the closing frame in a chunk of its own, and the closing frame is
 * exactly the one the mapper has no use for: the client was left waiting for a
 * last chunk that never came.
 *
 * So the rewrite keeps reading until it has something to hand over, and this
 * file pins that: the frames the mapper drops must not cost the stream its
 * last word.
 */
import { describe, it, expect } from "vitest";
import { sseRewrite } from "@/lib/proxy/stream-tap";

/** A source that hands over one line per chunk, the way a network does. */
function lineByLine(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${lines[index++]}\n`));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 2000),
      ),
    ]);
    if (next.done) break;
    out += decoder.decode(next.value);
  }
  return out;
}

describe("rewriting a stream", () => {
  it("passes the frames the mapper wants through", async () => {
    const out = await readAll(
      sseRewrite(lineByLine(["data: one", "data: two"]), {
        map: (line) => (line.startsWith("data:") ? `M ${line}` : null),
      }),
    );
    expect(out).toContain("M data: one");
    expect(out).toContain("M data: two");
  });

  it("does not stall on a frame the mapper drops", async () => {
    // The whole point: a chunk whose every line maps to null must not end the
    // stream's output. The mapper here drops everything except the last line.
    const out = await readAll(
      sseRewrite(lineByLine(["junk one", "junk two", "data: kept"]), {
        map: (line) => (line.startsWith("data:") ? `M ${line}` : null),
      }),
    );
    expect(out).toContain("M data: kept");
  });

  it("still ends with the closing frame when the last line was dropped", async () => {
    // The shape of the bug: the upstream's closing frame arrives in its own
    // chunk and the mapper has no use for it — so the client was left waiting
    // for a last chunk that never came.
    const out = await readAll(
      sseRewrite(lineByLine(["data: text", "data: {usage}"]), {
        map: (line) => (line === "data: text" ? "M data: text" : null),
        onEnd: () => "M end",
      }),
    );
    expect(out).toContain("M data: text");
    expect(out).toContain("M end");
  });

  it("can be stacked: a rewrite over a rewrite", async () => {
    // The stack the Chat surface needs: the pivot's frames, translated once on
    // the way in and once on the way out.
    const inner = sseRewrite(lineByLine(["data: one", "data: two"]), {
      map: (line) => (line.startsWith("data:") ? `INNER ${line}` : null),
      onEnd: () => "INNER end",
    });
    const out = await readAll(
      sseRewrite(inner, {
        map: (line) => (line.startsWith("INNER") ? `OUTER ${line}` : null),
        onEnd: () => "OUTER end",
      }),
    );
    expect(out).toContain("OUTER INNER data: one");
    expect(out).toContain("OUTER INNER data: two");
    expect(out).toContain("OUTER end");
  });
});
