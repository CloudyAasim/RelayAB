/**
 * tests/unit/ws-frames.test.ts
 *
 * The WebSocket frame layer: the handshake, the frames a server writes, and
 * the frames a client sends.
 *
 * The frame layer is the part of the realtime surface where a mistake is
 * silent. A wrong length form, an unmasked frame or a control frame that
 * carries too much does not throw — it makes the *other* side hang, and the
 * other side is a browser waiting for an audio chunk that never arrives. So
 * each rule of RFC 6455 that can be broken silently gets a test here: the
 * accept value from the specification's own vector, the three length forms,
 * the mask, the control-frame limits, and the incremental reading of a frame
 * that arrives in pieces.
 */
import { describe, it, expect } from "vitest";
import {
  WS_GUID,
  WS_MAX_PAYLOAD,
  OPCODE,
  computeAcceptValue,
  buildHandshakeResponse,
  encodeFrame,
  encodeClosePayload,
  FrameParser,
} from "@/lib/ws/frames";

/**
 * Build a client→server frame: masked, as RFC 6455 §5.3 requires.
 *
 * `lengthBytes` forces the length form, so a test can put a payload in a
 * form it does not strictly need.
 */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; maskKey?: Buffer; lengthBytes?: 7 | 16 | 64 } = {},
): Buffer {
  const fin = options.fin ?? true;
  const maskKey = options.maskKey ?? Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i & 3];

  const first = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const length = payload.length;

  const wants16 = options.lengthBytes === 16 || (options.lengthBytes !== 64 && length >= 126 && length <= 0xffff);
  const wants64 = options.lengthBytes === 64 || (options.lengthBytes === undefined && length > 0xffff);

  let header: Buffer;
  if (wants64) {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  } else if (wants16) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.from([first, 0x80 | length]);
  }

  return Buffer.concat([header, maskKey, masked]);
}

describe("the handshake", () => {
  it("uses the GUID the specification names", () => {
    expect(WS_GUID).toBe("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  });

  it("computes the accept value of the RFC 6455 §1.3 vector", () => {
    // The example from the specification: the key the client sends and the
    // accept value the server must answer with.
    expect(computeAcceptValue("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("answers the upgrade with 101 and the accept header", () => {
    const response = buildHandshakeResponse("dGhlIHNhbXBsZSBub25jZQ==");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(response).toContain("Upgrade: websocket");
    expect(response).toContain("Connection: Upgrade");
    expect(response).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    // The head ends with the blank line that separates it from the frames.
    expect(response.endsWith("\r\n\r\n")).toBe(true);
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
  });

  it("inserts extra headers as they are given", () => {
    const response = buildHandshakeResponse("dGhlIHNhbXBsZSBub25jZQ==", {
      "Sec-WebSocket-Protocol": "realtime",
    });
    expect(response).toContain("Sec-WebSocket-Protocol: realtime");
    expect(response.endsWith("\r\n\r\n")).toBe(true);
  });
});

describe("writing a frame", () => {
  it("writes a server frame without the mask bit", () => {
    const frame = encodeFrame(OPCODE.TEXT, Buffer.from("hi"));
    expect(frame[0]).toBe(0x81); // FIN + TEXT
    expect(frame[1] & 0x80).toBe(0); // no mask
    expect(frame[1] & 0x7f).toBe(2); // inline length
    expect(frame.subarray(2).toString("utf8")).toBe("hi");
  });

  it("writes the shortest length form that fits", () => {
    const small = encodeFrame(OPCODE.BINARY, Buffer.alloc(10));
    expect(small[1] & 0x7f).toBe(10);

    const medium = encodeFrame(OPCODE.BINARY, Buffer.alloc(200));
    expect(medium[1] & 0x7f).toBe(126);
    expect(medium.readUInt16BE(2)).toBe(200);

    const large = encodeFrame(OPCODE.BINARY, Buffer.alloc(70000));
    expect(large[1] & 0x7f).toBe(127);
    expect(Number(large.readBigUInt64BE(2))).toBe(70000);
  });

  it("round-trips through a reader that does not require a mask", () => {
    // The server→client direction is unmasked, so reading it back needs the
    // relaxed reader.
    const parser = new FrameParser({ requireMask: false });
    const frames = parser.push(encodeFrame(OPCODE.TEXT, Buffer.from("hello")));
    expect(frames).toHaveLength(1);
    expect(frames[0].fin).toBe(true);
    expect(frames[0].opcode).toBe(OPCODE.TEXT);
    expect(frames[0].payload.toString("utf8")).toBe("hello");
  });

  it("writes a close payload of a status code and a reason", () => {
    const payload = encodeClosePayload(1000, "bye");
    expect(payload.length).toBe(5);
    expect(payload.readUInt16BE(0)).toBe(1000);
    expect(payload.subarray(2).toString("utf8")).toBe("bye");
  });

  it("refuses a close reason that does not fit in a close frame", () => {
    // 123 bytes is the most a reason can be: 125 minus the status code.
    expect(() => encodeClosePayload(1000, "x".repeat(124))).toThrow();
    expect(encodeClosePayload(1000, "x".repeat(123)).length).toBe(125);
  });
});

describe("reading a client frame", () => {
  it("unmasks a masked client frame", () => {
    const parser = new FrameParser();
    const frames = parser.push(clientFrame(OPCODE.TEXT, Buffer.from("hello")));
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode).toBe(OPCODE.TEXT);
    expect(frames[0].fin).toBe(true);
    expect(frames[0].payload.toString("utf8")).toBe("hello");
  });

  it("refuses a client frame without the mask bit", () => {
    // A server frame is unmasked; a client that sends one is not speaking the
    // protocol of §5.3, and the connection has to fail.
    const parser = new FrameParser();
    expect(() => parser.push(encodeFrame(OPCODE.TEXT, Buffer.from("hello")))).toThrow(
      /mask/i,
    );
  });

  it("reads the 16-bit length form", () => {
    const parser = new FrameParser();
    const payload = Buffer.alloc(300, 0x41);
    const frames = parser.push(clientFrame(OPCODE.BINARY, payload, { lengthBytes: 16 }));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.length).toBe(300);
    expect(frames[0].payload.equals(payload)).toBe(true);
  });

  it("reads the 64-bit length form", () => {
    const parser = new FrameParser();
    const payload = Buffer.alloc(70000, 0x42);
    const frames = parser.push(clientFrame(OPCODE.BINARY, payload, { lengthBytes: 64 }));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.length).toBe(70000);
    expect(frames[0].payload.equals(payload)).toBe(true);
  });

  it("refuses a payload over the 16 MiB limit", () => {
    // The header alone is enough to fail: a length is a claim, and a claim of
    // more than the limit is refused before anything is allocated.
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(WS_MAX_PAYLOAD + 1), 2);

    const parser = new FrameParser();
    expect(() => parser.push(header)).toThrow(/limit/i);
  });

  it("refuses a control frame longer than 125 bytes", () => {
    const parser = new FrameParser();
    expect(() =>
      parser.push(clientFrame(OPCODE.CLOSE, Buffer.alloc(126, 0x03))),
    ).toThrow(/125 bytes/i);
  });

  it("refuses a fragmented control frame", () => {
    const parser = new FrameParser();
    expect(() =>
      parser.push(clientFrame(OPCODE.PING, Buffer.from("x"), { fin: false })),
    ).toThrow(/must not be fragmented/i);
  });
});

describe("reading incrementally", () => {
  it("holds an incomplete frame until the rest of it arrives", () => {
    const parser = new FrameParser();
    const frame = clientFrame(OPCODE.TEXT, Buffer.from("hello world"));

    const firstHalf = frame.subarray(0, Math.floor(frame.length / 2));
    expect(parser.push(firstHalf)).toHaveLength(0);
    expect(parser.pendingBytes).toBe(firstHalf.length);

    const frames = parser.push(frame.subarray(Math.floor(frame.length / 2)));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString("utf8")).toBe("hello world");
    expect(parser.pendingBytes).toBe(0);
  });

  it("hands over every frame that arrived in one chunk", () => {
    const parser = new FrameParser();
    const chunk = Buffer.concat([
      clientFrame(OPCODE.TEXT, Buffer.from("one")),
      clientFrame(OPCODE.PING, Buffer.from("two")),
    ]);
    const frames = parser.push(chunk);
    expect(frames.map((f) => f.opcode)).toEqual([OPCODE.TEXT, OPCODE.PING]);
    expect(frames.map((f) => f.payload.toString("utf8"))).toEqual(["one", "two"]);
    expect(parser.pendingBytes).toBe(0);
  });
});

describe("reading a fragmented message", () => {
  it("hands the fragments over one by one, with the opcodes they had", () => {
    // A fragmented message is a TEXT frame with FIN clear, then CONTINUATION
    // frames, the last of which closes it. The reader does not merge them —
    // reassembly is the caller's job.
    const parser = new FrameParser();
    const chunk = Buffer.concat([
      clientFrame(OPCODE.TEXT, Buffer.from("he"), { fin: false }),
      clientFrame(OPCODE.CONTINUATION, Buffer.from("ll"), { fin: false }),
      clientFrame(OPCODE.CONTINUATION, Buffer.from("o"), { fin: true }),
    ]);

    const frames = parser.push(chunk);
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.opcode)).toEqual([
      OPCODE.TEXT,
      OPCODE.CONTINUATION,
      OPCODE.CONTINUATION,
    ]);
    expect(frames.map((f) => f.fin)).toEqual([false, false, true]);
    expect(frames.map((f) => f.payload.toString("utf8"))).toEqual(["he", "ll", "o"]);
  });

  it("holds a fragment that is split across two chunks", () => {
    const parser = new FrameParser();
    const frame = clientFrame(OPCODE.CONTINUATION, Buffer.from("split"), { fin: true });
    const cut = Math.floor(frame.length / 2);

    expect(parser.push(frame.subarray(0, cut))).toHaveLength(0);
    expect(parser.pendingBytes).toBe(cut);

    const frames = parser.push(frame.subarray(cut));
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode).toBe(OPCODE.CONTINUATION);
    expect(frames[0].payload.toString("utf8")).toBe("split");
  });
});
