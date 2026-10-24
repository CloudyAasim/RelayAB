/**
 * src/lib/ws/frames.ts
 *
 * The WebSocket frame layer of the realtime surface.
 *
 * ## Why this exists
 *
 * `GET /v1/realtime` is an OpenAI Realtime API endpoint, and the Realtime API
 * is a WebSocket, not a request/response call. A Next.js route handler cannot
 * see the socket an HTTP request arrived on — the runtime owns it — so the
 * upgrade is taken over by a custom HTTP server (`server.mjs`), which gets the
 * raw socket in its `upgrade` event and hands it to the realtime surface.
 *
 * That server needs exactly three things from the protocol:
 *
 *   1. the handshake response, so the upgrade can be accepted at all;
 *   2. a reader that turns the bytes coming off the socket into frames;
 *   3. a writer that turns frames into bytes.
 *
 * This module is those three things and nothing else.
 *
 * ## What this module deliberately is not
 *
 * It is not a socket, not an HTTP server and not a WebSocket implementation.
 * There is no connection object, no heartbeat, no close-handshake state
 * machine and no I/O anywhere in here: a frame is a pure function of bytes, so
 * the protocol can be tested without a network and read on its own.
 *
 * ## The two directions are not the same
 *
 * RFC 6455 §5.3 makes masking mandatory in one direction only: a client MUST
 * mask every frame it sends to a server, and a server MUST NOT mask the frames
 * it sends back. The mask bit is therefore not a detail of the framing — it
 * is the statement of which side is speaking. So the reader demands it (a
 * client frame without it is a protocol violation), and the writer never sets
 * it.
 *
 * The reader defaults to that strict contract and can be relaxed with
 * `{ requireMask: false }`, which is what the tests and any internal tooling
 * that speaks server→server need.
 *
 * ## Bytes in, frames out — and the limit
 *
 * A socket hands over whatever the network gave it: half a frame, three
 * frames, a frame split down the middle. So the reader is incremental: it
 * keeps what it cannot yet make sense of and hands over only whole frames.
 * A frame is also allowed to be arbitrarily large, which is why there is a
 * defensive payload cap (`WS_MAX_PAYLOAD`): a length header is a claim, not a
 * fact, and a peer that claims a terabyte must not be able to make the
 * process allocate one.
 */

import { createHash } from "node:crypto";

/** RFC 6455 §1.3 handshake GUID. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * The largest payload a single frame may carry: 16 MiB.
 *
 * A frame's length is a claim made by the peer, not a fact, and the reader
 * allocates on the strength of it. The realtime surface carries audio chunks
 * and text events — nothing legitimate approaches 16 MiB — so the cap is set
 * well above anything real and well below anything that could hurt.
 */
export const WS_MAX_PAYLOAD = 16 * 1024 * 1024;

/** Frame opcodes (RFC 6455 §5.2). */
export const OPCODE = {
  /** A fragment of the message started by a TEXT or BINARY frame. */
  CONTINUATION: 0x0,
  /** A UTF-8 text message. */
  TEXT: 0x1,
  /** A binary message. */
  BINARY: 0x2,
  /** The end of the conversation (carries a status code and a reason). */
  CLOSE: 0x8,
  /** A liveness probe. */
  PING: 0x9,
  /** The answer to a ping. */
  PONG: 0xa,
} as const;

/** The opcodes this reader understands. Anything else fails the connection. */
const KNOWN_OPCODES: ReadonlySet<number> = new Set<number>([
  OPCODE.CONTINUATION,
  OPCODE.TEXT,
  OPCODE.BINARY,
  OPCODE.CLOSE,
  OPCODE.PING,
  OPCODE.PONG,
]);

/** A control frame carries the high bit of the opcode (RFC 6455 §5.5). */
function isControlOpcode(opcode: number): boolean {
  return (opcode & 0x8) !== 0;
}

/** One parsed frame. */
export interface ParsedFrame {
  /** Whether this frame ends the message it belongs to. */
  fin: boolean;
  /** The opcode (see {@link OPCODE}). */
  opcode: number;
  /** The payload, already unmasked. */
  payload: Buffer;
}

/** How the reader is allowed to treat the frames it is given. */
export interface FrameParserOptions {
  /**
   * Whether every frame must carry the mask bit.
   *
   * `true` (the default) is the client→server contract of RFC 6455 §5.3: a
   * frame without the mask bit is a protocol violation and fails the
   * connection. `false` accepts unmasked frames, which is what a
   * server→server or test reader needs.
   */
  requireMask?: boolean;
}

/**
 * Compute the `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key`.
 *
 * RFC 6455 §1.3: the accept value is the base64 of the SHA-1 of the key
 * concatenated with the protocol GUID. The GUID is what makes this a
 * handshake rather than a coincidence — the same key and the same digest
 * would otherwise be reusable by any other protocol.
 */
export function computeAcceptValue(secWebSocketKey: string): string {
  return createHash("sha1")
    .update(`${secWebSocketKey}${WS_GUID}`, "utf8")
    .digest("base64");
}

/**
 * Build the handshake response for an accepted upgrade.
 *
 * The result is the whole response head, headers included, ending with the
 * blank line that separates it from the frames that follow — the caller
 * writes it to the socket and then starts speaking WebSocket.
 *
 * `extraHeaders` are inserted as they are given: the caller is the only one
 * that knows what else the upgrade needs (a negotiated subprotocol, a
 * cookie), and this module has no opinion about it.
 */
export function buildHandshakeResponse(
  secWebSocketKey: string,
  extraHeaders?: Record<string, string>,
): string {
  const lines: string[] = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${computeAcceptValue(secWebSocketKey)}`,
  ];
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Encode a server→client frame.
 *
 * Server frames are never masked (RFC 6455 §5.3), so the mask bit stays
 * clear. The length is written in the shortest of the three forms the
 * protocol allows: 7 bits inline, 16 bits after a `126` marker, or 64 bits
 * after a `127` marker.
 */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  const first = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([first, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Encode the payload of a close frame: a 2-byte status code and a UTF-8
 * reason.
 *
 * The reason is what the peer reads to know *why* the conversation ended, so
 * it is worth having — but it shares the 125-byte budget of a control frame
 * with the status code, and a close frame that is too long is not a close
 * frame at all. The codes that RFC 6455 §7.4.1 reserves for the wire's own
 * use (1004, 1005, 1006, 1015) are refused as well: they describe conditions
 * the peer must infer, never conditions to announce.
 */
export function encodeClosePayload(code: number, reason?: string): Buffer {
  if (!Number.isInteger(code) || code < 1000 || code > 4999) {
    throw new Error(`Invalid WebSocket close code: ${code}`);
  }
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    throw new Error(`WebSocket close code ${code} must not be sent on the wire`);
  }

  const reasonBytes = reason ? Buffer.from(reason, "utf8") : Buffer.alloc(0);
  if (reasonBytes.length > 123) {
    throw new Error(
      `WebSocket close reason of ${reasonBytes.length} bytes does not fit in a close frame`,
    );
  }

  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

/**
 * An incremental reader: bytes go in, whole frames come out.
 *
 * The socket decides how the bytes are cut, not the protocol, so the reader
 * keeps what it cannot yet make sense of and hands over only frames that are
 * complete. A frame that arrives in three chunks is one frame when it is
 * finally whole; three frames that arrive in one chunk are three frames the
 * moment they are read.
 *
 * Messages are *not* merged here. A fragmented message arrives as a TEXT
 * frame with `fin` clear, then CONTINUATION frames, the last of which closes
 * it — and the reader hands over exactly those frames, in order, with the
 * opcodes they had. Reassembly is the caller's job: it is the one that knows
 * whether the message it is assembling is text or binary, and what to do with
 * a message that never ends.
 *
 * Every protocol violation throws. A masked frame that claims a huge payload,
 * a control frame that is too long, a frame from a client that forgot to mask
 * — each of them means the peer is not speaking the protocol, and the only
 * correct answer is to fail the connection.
 */
export class FrameParser {
  /** Bytes received that do not yet make a whole frame. */
  private buffer: Buffer = Buffer.alloc(0);

  /** Whether every frame must carry the mask bit (RFC 6455 §5.3). */
  private readonly requireMask: boolean;

  constructor(options: FrameParserOptions = {}) {
    this.requireMask = options.requireMask ?? true;
  }

  /** How many bytes are buffered waiting for the rest of their frame. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Feed a chunk of bytes and take out every frame that is now complete.
   *
   * Frames are returned in the order they arrived. A frame that is not
   * complete yet is kept for the next call — `pendingBytes` says how much is
   * being held.
   */
  push(chunk: Buffer): ParsedFrame[] {
    if (chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }

    const frames: ParsedFrame[] = [];
    let offset = 0;
    for (;;) {
      const decoded = this.decodeAt(this.buffer, offset);
      if (!decoded) break;
      frames.push(decoded.frame);
      offset += decoded.size;
    }

    if (offset > 0) {
      this.buffer = Buffer.from(this.buffer.subarray(offset));
    }
    return frames;
  }

  /**
   * Try to read one frame starting at `offset`.
   *
   * Returns `null` when the bytes so far do not make a whole frame — which is
   * not an error, just a frame that has not arrived yet. Throws when the
   * bytes make a frame the protocol does not allow.
   */
  private decodeAt(
    buf: Buffer,
    offset: number,
  ): { frame: ParsedFrame; size: number } | null {
    const available = buf.length - offset;
    if (available < 2) return null;

    const first = buf[offset];
    const second = buf[offset + 1];

    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const lengthIndicator = second & 0x7f;

    if (rsv !== 0) {
      throw new Error(
        "WebSocket protocol violation: reserved bits are set but no extension was negotiated",
      );
    }
    if (!KNOWN_OPCODES.has(opcode)) {
      throw new Error(
        `WebSocket protocol violation: unknown opcode 0x${opcode.toString(16)}`,
      );
    }
    if (this.requireMask && !masked) {
      throw new Error(
        "WebSocket protocol violation: client frame is missing the mandatory mask (RFC 6455 §5.3)",
      );
    }

    // The length is either inline, 16 bits after a 126 marker, or 64 bits
    // after a 127 marker. A 64-bit length is read unsigned: the high bit is
    // not a sign, and a length is never negative.
    let payloadLength: number;
    let headerSize: number;
    if (lengthIndicator === 126) {
      if (available < 4) return null;
      payloadLength = buf.readUInt16BE(offset + 2);
      headerSize = 4;
    } else if (lengthIndicator === 127) {
      if (available < 10) return null;
      payloadLength = Number(buf.readBigUInt64BE(offset + 2));
      headerSize = 10;
    } else {
      payloadLength = lengthIndicator;
      headerSize = 2;
    }

    if (isControlOpcode(opcode)) {
      // A control frame may sit in the middle of a fragmented message, but it
      // may not itself be fragmented and it may not carry more than 125 bytes
      // (RFC 6455 §5.5).
      if (!fin) {
        throw new Error(
          "WebSocket protocol violation: control frames must not be fragmented (RFC 6455 §5.5)",
        );
      }
      if (payloadLength > 125) {
        throw new Error(
          `WebSocket protocol violation: control frame payload of ${payloadLength} bytes exceeds 125 bytes (RFC 6455 §5.5)`,
        );
      }
    }

    if (payloadLength > WS_MAX_PAYLOAD) {
      throw new Error(
        `WebSocket protocol violation: payload length ${payloadLength} exceeds the ${WS_MAX_PAYLOAD} byte limit`,
      );
    }

    const maskSize = masked ? 4 : 0;
    const size = headerSize + maskSize + payloadLength;
    if (available < size) return null;

    const maskStart = offset + headerSize;
    const payloadStart = maskStart + maskSize;
    const payload = Buffer.from(buf.subarray(payloadStart, payloadStart + payloadLength));

    if (masked) {
      const key = buf.subarray(maskStart, maskStart + 4);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= key[i & 3];
      }
    }

    return { frame: { fin, opcode, payload }, size };
  }
}
