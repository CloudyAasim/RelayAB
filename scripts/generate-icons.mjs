// Rasterises the mark from src/app/icon.svg into the bitmap formats browsers
// and crawlers read.
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
// The drawing is the SVG's: a #3b82f6 outline on a transparent background.
// Bitmaps exist only because Google's favicon crawler ignores SVG and wants at
// least 48px; the shape stays identical to the vector.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "src", "app");

const BLUE = [0x3b, 0x82, 0xf6];

/* ---------- geometry, in the SVG's 56×56 viewBox units ------------------ */

const VIEWBOX = 56;
const HALF = 3.5 / 2; // stroke-width 3.5 is centred on the path

// Two 40×16 rounded rectangles with rx=3, stroked rather than filled.
const BARS = [
  { x: 8, y: 10, w: 40, h: 16, rx: 3 },
  { x: 8, y: 30, w: 40, h: 16, rx: 3 },
];
// The two zero-length, round-capped lines: circles of radius half the stroke.
const DOTS = [
  { cx: 16, cy: 18, r: HALF },
  { cx: 16, cy: 38, r: HALF },
];

function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  if (r <= 0) return px >= x0 && px <= x1 && py >= y0 && py <= y1;
  // Distance from the rounded rectangle: clamp the point to the inner box,
  // measure to it, then compare against the corner radius.
  const qx = Math.max(x0 + r, Math.min(px, x1 - r));
  const qy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - qx;
  const dy = py - qy;
  return dx * dx + dy * dy <= r * r;
}

function insideBar(px, py, bar) {
  const outerR = bar.rx + HALF;
  if (!insideRoundRect(px, py, bar.x - HALF, bar.y - HALF, bar.x + bar.w + HALF, bar.y + bar.h + HALF, outerR)) {
    return false;
  }
  // Subtracting the hole is what turns a stroked rect into an outline; its
  // corner radius is the outer one reduced by the stroke on both sides.
  const innerR = bar.rx - HALF;
  return !insideRoundRect(px, py, bar.x + HALF, bar.y + HALF, bar.x + bar.w - HALF, bar.y + bar.h - HALF, innerR);
}

function covered(px, py) {
  for (const bar of BARS) if (insideBar(px, py, bar)) return true;
  for (const dot of DOTS) {
    const dx = px - dot.cx;
    const dy = py - dot.cy;
    if (dx * dx + dy * dy <= dot.r * dot.r) return true;
  }
  return false;
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

function png(size, samples = 8) {
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
  const perPixel = samples * samples;
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const ux = (x + (sx + 0.5) / samples) * (VIEWBOX / size);
          const uy = (y + (sy + 0.5) / samples) * (VIEWBOX / size);
          if (covered(ux, uy)) hits++;
        }
      }
      // The ink is one flat colour, so the supersampled coverage is the alpha
      // and the RGB stays exact. Averaging RGB with it would darken the edges.
      const offset = y * (stride + 1) + 1 + x * 4;
      if (hits === 0) continue; // leaves the pixel transparent black
      raw[offset] = BLUE[0];
      raw[offset + 1] = BLUE[1];
      raw[offset + 2] = BLUE[2];
      raw[offset + 3] = Math.round((hits / perPixel) * 255);
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