// Generate the PaperAI source icon (1024x1024 PNG) used by `tauri icon`.
// Pure Node (zlib only) so no extra dependency is needed.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = 1024;

const buf = Buffer.alloc(S * S * 4, 0); // RGBA, fully transparent

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const sa = a / 255;
  buf[i] = Math.round(r * sa + buf[i] * (1 - sa));
  buf[i + 1] = Math.round(g * sa + buf[i + 1] * (1 - sa));
  buf[i + 2] = Math.round(b * sa + buf[i + 2] * (1 - sa));
  buf[i + 3] = Math.max(buf[i + 3], a);
}

function rect(x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = Math.round(y0); y < Math.round(y1); y++)
    for (let x = Math.round(x0); x < Math.round(x1); x++) px(x, y, r, g, b, a);
}

const NAVY = [20, 48, 74];
const WHITE = [250, 251, 252];
const INK = [38, 50, 66];
const GOLD = [255, 199, 44];

// Rounded navy background
const RAD = 200;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = Math.min(x, S - 1 - x);
    const dy = Math.min(y, S - 1 - y);
    if (dx < RAD && dy < RAD) {
      const d = Math.hypot(RAD - dx, RAD - dy);
      if (d <= RAD) rect(x, y, x + 1, y + 1, ...NAVY);
    } else if (dx >= RAD || dy >= RAD) {
      rect(x, y, x + 1, y + 1, ...NAVY);
    }
  }
}

// Document sheet
const dx0 = 232, dy0 = 168, dx1 = 792, dy1 = 872;
rect(dx0, dy0, dx1, dy1, ...WHITE);
// Dog-eared corner
for (let y = dy0; y < dy0 + 120; y++) {
  for (let x = dx1 - 120; x < dx1; x++) {
    if (x - (dx1 - 120) > 120 - (y - dy0)) px(x, y, ...NAVY, 0);
  }
}
rect(dx1 - 120, dy0, dx1, dy0 + 8, 190, 196, 204);
rect(dx1 - 8, dy0, dx1, dy0 + 120, 190, 196, 204);

// Highlight bar behind the first text line
rect(dx0 + 64, dy0 + 96, dx0 + 452, dy0 + 168, ...GOLD);

// Text lines
const lines = [
  [64, 152, 452],
  [64, 216, 400],
  [64, 280, 436],
  [64, 344, 300],
];
for (const [ox, oy, w] of lines) rect(dx0 + ox, dy0 + oy, dx0 + ox + w, dy0 + oy + 26, ...INK);

// Pen stroke (ink) across the lower sheet
let t = 0;
for (let x = dx0 + 40; x < dx1 - 40; x++) {
  t += 0.11;
  const y = dy0 + 520 + Math.sin(t) * 46;
  for (let k = -9; k <= 9; k++) px(x, Math.round(y + k), 214, 40, 57, 255);
}

// --- PNG encode -----------------------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

let CRC_TABLE = null;
function crc32(b) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(join(root, "assets"), { recursive: true });
const out = join(root, "assets", "icon-source.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${S}x${S})`);
