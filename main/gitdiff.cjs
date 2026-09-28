'use strict';
// `git:diff` — uncommitted changes (HEAD vs worktree, staged included) as
// original/modified content pairs for the Monaco DiffEditor's Changes tab.
// Graceful like gitstatus: no git on PATH, not a repo, or a timeout → null.
// Per-file caps (size, binary ext, MAX_FILES) keep huge repos from stalling
// the window; spawns run in parallel but bounded by the file cap.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const gitstatus = require('./gitstatus.cjs');
const U = require('./util.cjs');

const cache = new Map(); // repoPath -> { at, result }
const TTL = 3000;
const MAX_FILES = 100;
const MAX_BYTES = 1024 * 1024; // per file — larger files are skipped, not truncated
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.zip', '.7z', '.gz', '.tar', '.pdf', '.mp4', '.mp3', '.wav', '.ogg', '.webm', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.psd', '.ai', '.sketch', '.db', '.sqlite', '.bin', '.wasm', '.class', '.jar', '.pyc', '.node', '.lockb']);

// Whole-file CRLF noise: `git show HEAD:x` returns the committed content (LF)
// while a worktree read returns disk CRLF — without normalizing both sides,
// every text file on a core.autocrlf=true checkout diffs whole-file.
function _normalize(s) {
  return s.replace(/\r\n/g, '\n');
}

function run(repoPath, args) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('git', args, { cwd: repoPath, env: process.env, windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 5000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

async function diff(repoPath, { refresh = false } = {}) {
  if (!repoPath || !fs.existsSync(repoPath)) return null;
  const cached = cache.get(repoPath);
  if (!refresh && cached && Date.now() - cached.at < TTL) return cached.result;

  // file list comes from the same porcelain source the tree colors use, so the
  // Changes tab and the tree always agree; refresh busts both caches together
  const st = await gitstatus.status(repoPath, refresh ? 0 : TTL);
  if (!st) return null;

  const entries = [];
  for (const rel of st.keys()) {
    if (entries.length >= MAX_FILES) break;
    if (BIN_EXT.has(path.extname(rel).toLowerCase())) continue;
    if (U.isIgnoredPath(path.join(repoPath, rel))) continue;
    entries.push({ rel, status: st.get(rel) });
  }

  const files = await Promise.all(entries.map(async ({ rel, status }) => {
    const abs = path.join(repoPath, rel);
    let original = '';
    if (status !== 'A' && status !== 'U') { // added/untracked have no HEAD version
      // null return covers "no HEAD yet" (fresh repo) and spawn trouble alike
      const head = await run(repoPath, ['show', `HEAD:${rel.replace(/\\/g, '/')}`]);
      original = head === null ? '' : _normalize(head);
    }
    let modified = '';
    if (status !== 'D') {
      try {
        if (fs.statSync(abs).size > MAX_BYTES) return null; // skip, don't truncate
        modified = _normalize(fs.readFileSync(abs, 'utf8'));
      } catch { /* vanished between status and read — treat as empty */ }
    }
    return { path: abs, rel, status, original, modified };
  }));

  const result = { files: files.filter(Boolean) };
  cache.set(repoPath, { at: Date.now(), result });
  return result;
}

function bust(repoPath) {
  cache.delete(repoPath);
}

module.exports = { diff, bust, _normalize };
