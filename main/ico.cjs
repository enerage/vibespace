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

module.exports = { buildIcoFromImage, buildDefaultIco, buildIcoFromImageViaBuffer };
