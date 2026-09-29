'use strict';
// `git status --porcelain -z` for tree coloring. Graceful by design: no git on
// PATH, not a repo, or a timeout all resolve to null — the tree just shows no
// colors. 3 s cache so lazy folder loads don't re-spawn git per click.
const { spawn } = require('node:child_process');

const cache = new Map(); // repoPath -> { at, files }

// -z format: NUL-separated entries "XY path"; renames/copies are followed by a
// second record holding the OLD path. Maps to a single letter per path:
// M modified · A staged-add · D deleted · U untracked.
function parsePorcelain(out) {
  const files = new Map();
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip the old-path record
    const rel = p.slice(3).replace(/^"|"$/g, '');
    const st = xy[0] !== ' ' ? xy[0] : xy[1];
    files.set(rel, st === '?' ? 'U' : st === 'A' ? 'A' : st === 'D' ? 'D' : 'M');
  }
  return files;
}

function status(repoPath, ttlMs = 3000) {
  return new Promise((resolve) => {
    const cached = cache.get(repoPath);
    if (cached && Date.now() - cached.at < ttlMs) return resolve(cached.files);
    let out = '';
    let proc;
    try {
      proc = spawn('git', ['status', '--porcelain', '-z'], { cwd: repoPath, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(cached ? cached.files : null); }, 5000);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      const files = parsePorcelain(out);
      cache.set(repoPath, { at: Date.now(), files });
      resolve(files);
    });
  });
}

// Drop the cached entry for a repo (tree file ops just changed the worktree) so
// the next git:status re-spawns immediately instead of serving up to 3 s stale.
function bust(repoPath) {
  cache.delete(repoPath);
}

module.exports = { status, bust, _parsePorcelain: parsePorcelain };
