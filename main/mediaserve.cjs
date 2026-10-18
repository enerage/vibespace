'use strict';
// Image / video / audio preview: the `vsfile://` scheme the workspace viewer's
// <img>/<video>/<audio> load from. URL shape (built by renderer/workspace/ui/
// mediaurl.js):
//
//   vsfile://ws/<wsId>/<abs path, one encodeURIComponent'd segment per part>?v=<mtime>
//
// Windows `D:\a\b.png` → `/D%3A/a/b.png`; macOS `/Users/x/b.png` → `/Users/x/b.png`.
// The renderer only NAMES its workspace: main accepts a wsId only when a window
// of that workspace lives in THIS process (`rootFor`), takes the repo from the
// registry, and serves media files strictly inside it (realpath, so a symlink or
// junction can't point out). Like app:// it reads from disk on every request
// with `Cache-Control: no-store` (never reintroduce caching), and streams ranges
// so videos seek without being loaded into memory.
//
// Everything except `handler` is pure and takes the path module as a parameter,
// so node tests can drive both the win32 and the posix variants on one machine.
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const MEDIA = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.svg': ['image', 'image/svg+xml'],
  '.bmp': ['image', 'image/bmp'],
  '.ico': ['image', 'image/x-icon'],
  '.avif': ['image', 'image/avif'],
  '.mp4': ['video', 'video/mp4'],
  '.m4v': ['video', 'video/mp4'], // Chromium plays m4v as mp4; video/x-m4v is not a type it knows
  '.webm': ['video', 'video/webm'],
  '.mov': ['video', 'video/quicktime'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.ogg': ['audio', 'audio/ogg'],
  '.m4a': ['audio', 'audio/mp4'],
};

// 'image' | 'video' | 'audio' | null (any other file keeps the text/binary path)
function kindOf(file) {
  const m = MEDIA[path.extname(String(file || '')).toLowerCase()];
  return m ? m[0] : null;
}

function mimeOf(file) {
  const m = MEDIA[path.extname(String(file || '')).toLowerCase()];
  return m ? m[1] : null;
}

// Range header → { start, end } (inclusive), null (no/ignored range: send the
// whole file, 200) or 'unsatisfiable' (416). One range only: a multi-range or
// malformed header is ignored, which RFC 9110 allows.
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') { // suffix: the last N bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  let end = m[2] === '' ? size - 1 : Number(m[2]);
  if (m[2] !== '' && end < start) return null; // invalid → ignored
  if (start >= size) return 'unsatisfiable';
  if (end >= size) end = size - 1;
  return { start, end };
}

// The absolute path a vsfile URL's path segments (after the wsId) name, or null.
// Segments are decoded one by one; any that could step out or smuggle a
// separator is refused (the URL parser already resolved literal and %2e dots).
function pathFromSegments(segs, p = path) {
  if (!Array.isArray(segs) || !segs.length) return null;
  const win = p.sep === '\\';
  const out = [];
  for (const raw of segs) {
    let s;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
    out.push(s);
  }
  if (win) {
    // drive-letter paths only (no UNC); a ':' anywhere else would be an NTFS stream
    if (!/^[A-Za-z]:$/.test(out[0]) || out.slice(1).some(s => s.includes(':'))) return null;
    return p.join(out[0] + p.sep, ...out.slice(1));
  }
  return p.join(p.sep, ...out);
}

// The inverse, for tests and the renderer twin (ui/mediaurl.js keeps the same rule).
function segmentsFor(absPath) {
  return String(absPath).split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
}

// Strictly inside root (root itself refused), case-insensitive like U.jailed.
function inside(root, file, p = path) {
  const r = p.resolve(root);
  const f = p.resolve(file);
  const base = r.endsWith(p.sep) ? r : r + p.sep;
  return f.toLowerCase().startsWith(base.toLowerCase()) ? f : null;
}

// URL → { wsId, file } or null (wrong host / shape).
function parseUrl(url, p = path) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'vsfile:' || u.host !== 'ws') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  let wsId;
  try { wsId = decodeURIComponent(parts[0]); } catch { return null; }
  const file = pathFromSegments(parts.slice(1), p);
  return file ? { wsId, file } : null;
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Accept-Ranges': 'bytes',
  'X-Content-Type-Options': 'nosniff',
  // an SVG opened as a document (not through <img>) must not run anything
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

// protocol.handle handler. rootFor(wsId) → that workspace's repo root, only if a
// window of it lives in this process (else null).
function handler(rootFor) {
  return async (request) => {
    const parsed = parseUrl(request.url);
    if (!parsed) return plain(404, 'not found');
    const root = rootFor(parsed.wsId);
    if (!root) return plain(404, 'not found');
    const mime = mimeOf(parsed.file);
    if (!mime) return plain(403, 'forbidden');
    if (!inside(root, parsed.file)) return plain(403, 'forbidden');
    let real, st;
    try {
      const realRoot = await fs.promises.realpath(root);
      real = await fs.promises.realpath(parsed.file);
      if (!inside(realRoot, real)) return plain(403, 'forbidden'); // symlink/junction escape
      st = await fs.promises.stat(real);
    } catch {
      return plain(404, 'not found');
    }
    if (!st.isFile()) return plain(404, 'not found');
    const size = st.size;
    const head = request.method === 'HEAD';
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...BASE_HEADERS, 'Content-Range': `bytes */${size}` } });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const headers = { ...BASE_HEADERS, 'Content-Type': mime, 'Content-Length': String(length) };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const body = head || length === 0 ? null : Readable.toWeb(fs.createReadStream(real, { start, end }));
    return new Response(body, { status: range ? 206 : 200, headers });
  };
}

module.exports = { MEDIA, kindOf, mimeOf, parseRange, pathFromSegments, segmentsFor, inside, parseUrl, handler };
