// Generates the bitmap icons search engines and touch screens actually read.
//
// Node has no image encoder here (no sharp/canvas), so this writes PNG by hand:
// zlib.deflateSync for the pixel data, our own CRC32 for the chunk trailers.
// Run it when the mark changes: `node scripts/generate-icons.mjs`.
//
// Outputs (committed):
//   src/app/icon.png         192×192  — metadata file convention
//   src/app/apple-icon.png   180×180  — apple-touch-icon
//   src/app/favicon.ico       48+96   — PNG payloads inside an ICO container
//
// A transparent, stroke-only SVG is why Google's results showed the generic
// globe: its favicon crawler wants an opaque bitmap of at least 48px. These do.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "src", "app");

const BLUE = [0x25, 0x63, 0xeb];
const WHITE = [0xff, 0xff, 0xff];

/* ---------- vector shape, described in unit coordinates (0..1) ---------- */

const BG_RADIUS = 0.22;
const BARS = [
  { x0: 0.16, y0: 0.2, x1: 0.84, y1: 0.42, r: 0.055 },
  { x0: 0.16, y0: 0.58, x1: 0.84, y1: 0.8, r: 0.055 },
];
const PIPS = [
  { cx: 0.293, cy: 0.31, r: 0.037 },
  { cx: 0.293, cy: 0.69, r: 0.037 },
];

function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  // Distance from the rounded rectangle: clamp the point to the inner box,
  // measure to it, then compare against the corner radius.
  const qx = Math.max(x0 + r, Math.min(px, x1 - r));
  const qy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - qx;
  const dy = py - qy;
  if (dx * dx + dy * dy <= r * r) return true;
  return px >= x0 && px <= x1 && py >= y0 + r && py <= y1 - r;
}

function sample(px, py) {
  if (!insideRoundRect(px, py, 0, 0, 1, 1, BG_RADIUS)) return [0, 0, 0, 0];
  let color = BLUE;
  for (const bar of BARS) {
    if (insideRoundRect(px, py, bar.x0, bar.y0, bar.x1, bar.y1, bar.r)) color = WHITE;
  }
  for (const pip of PIPS) {
    const dx = px - pip.cx;
    const dy = py - pip.cy;
    if (dx * dx + dy * dy <= pip.r * pip.r) color = BLUE;
  }
  return [color[0], color[1], color[2], 255];
}

/* ------------------------------- PNG ------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function png(size, samples = 4) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = sample((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = samples * samples;
      const offset = y * (stride + 1) + 1 + x * 4;
      raw[offset] = Math.round(r / n);
      raw[offset + 1] = Math.round(g / n);
      raw[offset + 2] = Math.round(b / n);
      raw[offset + 3] = Math.round(a / n);
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------- ICO ------------------------------------ */

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

/* ------------------------------- write ---------------------------------- */

mkdirSync(APP, { recursive: true });

writeFileSync(join(APP, "icon.png"), png(192));
writeFileSync(join(APP, "apple-icon.png"), png(180));
writeFileSync(
  join(APP, "favicon.ico"),
  ico([
    { size: 48, data: png(48) },
    { size: 96, data: png(96) },
  ]),
);

console.log("wrote src/app/{icon.png,apple-icon.png,favicon.ico}");
