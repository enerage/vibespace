'use strict';
// Finds images inside a repo that could be its logo, for the "change logo"
// picker: the workspace logo is nearly always already in the repo
// (public/logo.png, favicon, app icon), so offer those before a file dialog.
//
//   scan(root) -> [{ path, rel, w, h, bytes, thumb }]   best guess first
//
// Bounded on purpose (dirs, depth, time, file size): a repo can be huge, and
// node_modules / build output / caches hold thousands of images that are never
// the logo. Those are skipped through the same ignore list the file tree uses.

const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

const EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.svg', '.webp']);
const MAX_BYTES = 2 * 1024 * 1024; // a logo is small; photos and exports are not
const MIN_BYTES = 80;
const MAX_DEPTH = 7;
const MAX_DIRS = 4000;
const MAX_MS = 1500;
const MAX_RANKED = 90;   // name-ranked images that get a thumbnail
const MAX_RESULTS = 48;  // shown in the picker
const THUMB = 96;

// Never the logo's home, on top of U.IGNORED_NAMES (node_modules, .git, dist, …)
const SKIP_DIRS = new Set(['vendor', 'bower_components', 'pods', 'site-packages', 'tmp', 'temp', 'logs']);
const GOOD_DIRS = new Set(['public', 'static', 'assets', 'asset', 'brand', 'branding', 'images', 'image', 'img', 'icons', 'icon', 'logo', 'logos', 'media', 'resources', 'res', 'app']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__snapshots__', 'fixtures', 'e2e', 'cypress', 'playwright', 'stories', 'screenshots', 'mocks', '__mocks__', 'examples', 'example', 'samples']);
const NOT_LOGO = /screen-?shot|banner|hero|background|(^|[-_.])bg([-_.]|$)|og[-_]?image|opengraph|twitter[-_]?card|preview|cover|thumb|sprite|placeholder|mock|demo|example|sample|diagram|chart|avatar-\d|photo/;

// Higher = more likely the logo. Pure (rel is slash-separated, repo-relative).
function score(rel) {
  const segs = rel.toLowerCase().split('/');
  const file = segs.pop();
  const ext = path.extname(file);
  const name = file.slice(0, file.length - ext.length);
  let s = 0;
  if (name.includes('logo')) s += 100;
  else if (name.includes('favicon')) s += 70;
  else if (/apple-touch-icon|android-chrome|mstile|app-?icon|launcher/.test(name)) s += 60;
  else if (/(^|[-_.])icon([-_.]|\d|$)/.test(name)) s += 55;
  else if (/brand|emblem|wordmark|logomark|(^|[-_.])mark([-_.]|$)/.test(name)) s += 45;
  if (NOT_LOGO.test(name)) s -= 60;
  if (segs.some(d => GOOD_DIRS.has(d))) s += 25;
  if (segs.some(d => TEST_DIRS.has(d))) s -= 40;
  if (segs.length === 0) s += 15;
  s -= segs.length * 4;
  s += ext === '.svg' ? 8 : ext === '.png' ? 6 : ext === '.ico' ? 5 : 0;
  return s;
}

function skipDir(parentName, name) {
  const low = name.toLowerCase();
  if (U.IGNORED_NAMES.has(name) || SKIP_DIRS.has(low)) return true;
  if (U.isAgentWorktrees(parentName, name)) return true;
  // dot-folders are tooling (.git, .next, .venv, .claude, .idea…); .github may hold a logo
  return name.startsWith('.') && low !== '.github';
}

// Breadth-first, so when a budget runs out it is the deep folders that are missed.
async function walk(root, { maxDirs = MAX_DIRS, maxDepth = MAX_DEPTH, maxMs = MAX_MS } = {}) {
  const found = [];
  const queue = [{ dir: root, rel: '', depth: 0 }];
  const t0 = Date.now();
  let dirs = 0;
  while (queue.length) {
    if (++dirs > maxDirs || Date.now() - t0 > maxMs) break;
    const { dir, rel, depth } = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        if (depth < maxDepth && !skipDir(path.basename(dir), d.name)) queue.push({ dir: path.join(dir, d.name), rel: childRel, depth: depth + 1 });
      } else if (d.isFile() && EXT.has(path.extname(d.name).toLowerCase())) {
        found.push(childRel);
      }
    }
  }
  return found;
}

async function thumbFor(file, ext, bytes) {
  if (ext === '.ico') {
    // sharp can't read .ico; Chromium can, so hand the file itself over (small ones only)
    if (bytes > 400 * 1024) return null;
    return { thumb: 'data:image/x-icon;base64,' + (await fs.promises.readFile(file)).toString('base64'), w: 0, h: 0 };
  }
  const sharp = require('sharp');
  const img = sharp(file, { density: 192 }).rotate();
  const meta = await img.metadata();
  const png = await img.resize(THUMB, THUMB, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return { thumb: 'data:image/png;base64,' + png.toString('base64'), w: meta.width || 0, h: meta.height || 0 };
}

async function scan(root, opts) {
  const rels = await walk(root, opts);
  const ranked = rels.map(rel => ({ rel, score: score(rel) })).sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).slice(0, MAX_RANKED);
  const out = [];
  const one = async (r) => {
    const file = path.join(root, r.rel);
    try {
      const st = await fs.promises.stat(file);
      if (st.size > MAX_BYTES || st.size < MIN_BYTES) return;
      const t = await thumbFor(file, path.extname(file).toLowerCase(), st.size);
      if (!t) return; // unreadable image: it couldn't become the icon either
      let s = r.score;
      if (t.w && t.h) {
        const ratio = Math.max(t.w, t.h) / Math.min(t.w, t.h);
        if (ratio > 3) s -= 50;        // banners, strips
        else if (ratio <= 1.2) s += 10; // icons are square
        if (Math.max(t.w, t.h) < 24) s -= 20; // too small to make a taskbar icon
      }
      out.push({ path: file, rel: r.rel, w: t.w, h: t.h, bytes: st.size, thumb: t.thumb, score: s });
    } catch { /* unreadable or broken image: skip it */ }
  };
  // thumbnails 6 at a time: one by one took 3.4 s on a repo with 90 candidates
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < ranked.length) await one(ranked[next++]); }));
  out.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  return out.slice(0, MAX_RESULTS);
}

module.exports = { scan, walk, score };
