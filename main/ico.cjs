'use strict';
// Builds multi-size .ico files from PNG/SVG/JPEG inputs (or copies existing .ico).
// Small sizes are embedded as 32bpp BMP DIBs, the 256px entry as a PNG payload —
// the layout Windows itself generates for high-quality icons.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6e9cff"/>
      <stop offset="1" stop-color="#9d6cff"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#g)"/>
  <path d="M78 76 L128 186 L178 76 H148 L128 124 L108 76 Z" fill="#ffffff"/>
</svg>`;

function dibFromRgba(rgba, size) {
  // BITMAPINFOHEADER + bottom-up BGRA rows + empty AND mask
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height doubled: XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const rowBytes = size * 4;
  const pixels = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const src = (srcY * size + x) * 4;
      const dst = (y * size + x) * 4;
      pixels[dst] = rgba[src + 2];     // B
      pixels[dst + 1] = rgba[src + 1]; // G
      pixels[dst + 2] = rgba[src];     // R
      pixels[dst + 3] = rgba[src + 3]; // A
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(entries) {
  // entries: [{size, blob}] ordered small -> large
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const base = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, base);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, base + 1);
    dir.writeUInt8(0, base + 2);
    dir.writeUInt8(0, base + 3);
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(e.blob.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += e.blob.length;
  });
  return Buffer.concat([header, dir, ...entries.map(e => e.blob)]);
}

async function buildIcoFromImage(srcPath, outIco) {
  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.ico') {
    fs.copyFileSync(srcPath, outIco);
    return outIco;
  }
  const base = sharp(srcPath, { density: 384 }).rotate();
  const entries = [];
  for (const size of [16, 32, 48, 256]) {
    if (size === 256) {
      const png = await base.clone().resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      entries.push({ size: 256, blob: png });
    } else {
      const { data } = await base.clone().resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      entries.push({ size, blob: dibFromRgba(data, size) });
    }
  }
  fs.writeFileSync(outIco, buildIco(entries));
  return outIco;
}

// Per-workspace default icon: a letter mark on a color derived from the name, so
// every workspace is distinguishable in the taskbar from the first second (a pin
// caches its icon at creation). Never the VibeSpace app logo — a new workspace
// wearing the app's own logo looked like VibeSpace itself (2026-09-28).
function letterMarkSvg(label) {
  const name = String(label || 'W').trim() || 'W';
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const letter = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || 'W';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},70%,58%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},70%,42%)"/>
  </linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#g)"/>
  <text x="128" y="172" font-family="Segoe UI, Arial, sans-serif" font-size="150" font-weight="700" fill="#ffffff" text-anchor="middle">${letter}</text>
</svg>`;
}

async function buildDefaultIco(outIco, label = null) {
  const svg = label ? letterMarkSvg(label) : DEFAULT_SVG;
  const png = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  return buildIcoFromImageViaBuffer(png, outIco);
}

async function buildIcoFromImageViaBuffer(pngBuffer, outIco) {
  const entries = [];
  for (const size of [16, 32, 48, 256]) {
    if (size === 256) {
      const p = await sharp(pngBuffer).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      entries.push({ size: 256, blob: p });
    } else {
      const { data } = await sharp(pngBuffer).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      entries.push({ size, blob: dibFromRgba(data, size) });
    }
  }
  fs.writeFileSync(outIco, buildIco(entries));
  return outIco;
}

// ---------- macOS: PNG for the Dock, .icns for the app bundle ----------
// nativeImage can't read .ico on macOS, so a workspace's icon there is a PNG.
// Apple's icon grid keeps a transparent margin (824 px of art on a 1024 canvas),
// so a full-bleed logo doesn't look oversized next to the other Dock tiles.
// (macOS 26 puts BUNDLE icons that aren't Apple's rounded-square shape on a gray
// plate; app.dock.setIcon of a running process is drawn as is.)
const DOCK_SIZE = 1024;
const DOCK_ART = 824;
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

// The best entry of an .ico as a PNG buffer: its PNG payload, or a 32-bit DIB
// converted. Largest first; other bit depths are refused (sharp can't read .ico).
async function pngFromIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an .ico file');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    if (base + 16 > buf.length) break;
    const size = buf.readUInt32LE(base + 8);
    const offset = buf.readUInt32LE(base + 12);
    if (offset + size > buf.length || size < 40) continue;
    entries.push({ w: buf.readUInt8(base) || 256, blob: buf.subarray(offset, offset + size) });
  }
  entries.sort((a, b) => b.w - a.w);
  for (const e of entries) {
    if (e.blob.readUInt32BE(0) === 0x89504e47) return Buffer.from(e.blob); // PNG payload
    const hdr = e.blob.readUInt32LE(0);
    const w = e.blob.readInt32LE(4);
    const h = Math.abs(e.blob.readInt32LE(8)) / 2; // XOR + AND masks
    if (e.blob.readUInt16LE(14) !== 32 || w <= 0 || h <= 0 || hdr + w * h * 4 > e.blob.length) continue;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = hdr + (h - 1 - y) * w * 4; // bottom-up BGRA rows
      for (let x = 0; x < w; x++) {
        const s = src + x * 4;
        const d = (y * w + x) * 4;
        rgba[d] = e.blob[s + 2];
        rgba[d + 1] = e.blob[s + 1];
        rgba[d + 2] = e.blob[s];
        rgba[d + 3] = e.blob[s + 3];
      }
    }
    return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  }
  throw new Error('unsupported .ico (needs a PNG or 32-bit entry): pick a PNG, SVG or JPEG logo');
}

async function buildDockPngFromInput(input, outPng) {
  const art = await sharp(input, { density: 384 }).rotate().resize(DOCK_ART, DOCK_ART, { fit: 'contain', background: CLEAR }).png().toBuffer();
  const pad = (DOCK_SIZE - DOCK_ART) / 2;
  await sharp(art).extend({ top: pad, bottom: pad, left: pad, right: pad, background: CLEAR }).png().toFile(outPng);
  return outPng;
}

async function buildPngFromImage(srcPath, outPng) {
  const input = path.extname(srcPath).toLowerCase() === '.ico' ? await pngFromIco(fs.readFileSync(srcPath)) : srcPath;
  return buildDockPngFromInput(input, outPng);
}

async function buildDefaultPng(outPng, label = null) {
  const svg = label ? letterMarkSvg(label) : DEFAULT_SVG;
  return buildDockPngFromInput(Buffer.from(svg), outPng);
}

// ICNS container: 'icns' + BE total length, then OSType + BE length (incl. its
// 8-byte header) + PNG payload per entry. Only the PNG-capable types are used.
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

// pngs: Map size -> PNG buffer (every size in ICNS_TYPES)
function buildIcns(pngs) {
  const chunks = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = pngs.get(size);
    if (!png) throw new Error(`icns: missing ${size}px PNG`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    chunks.push(head, png);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// rounded: clip the art to Apple's rounded square (corner ≈ 22.4 % of the side),
// for a full-bleed square logo like assets/logo.png
async function buildIcnsFromImage(srcPath, outIcns, { rounded = false } = {}) {
  const pngs = new Map();
  for (const size of new Set(ICNS_TYPES.map(([, s]) => s))) {
    const art = Math.round(size * DOCK_ART / DOCK_SIZE);
    const pad = size - art;
    let inner = await sharp(srcPath, { density: 384 }).rotate().resize(art, art, { fit: 'contain', background: CLEAR }).ensureAlpha().png().toBuffer();
    if (rounded) {
      const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${art}" height="${art}"><rect width="${art}" height="${art}" rx="${(art * 0.2237).toFixed(2)}" fill="#fff"/></svg>`);
      inner = await sharp(inner).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    }
    pngs.set(size, await sharp(inner).extend({ top: Math.floor(pad / 2), bottom: Math.ceil(pad / 2), left: Math.floor(pad / 2), right: Math.ceil(pad / 2), background: CLEAR }).png().toBuffer());
  }
  fs.writeFileSync(outIcns, buildIcns(pngs));
  return outIcns;
}

module.exports = {
  buildIcoFromImage, buildDefaultIco, buildIcoFromImageViaBuffer,
  buildPngFromImage, buildDefaultPng, pngFromIco, buildIcns, buildIcnsFromImage, ICNS_TYPES,
};
