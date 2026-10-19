'use strict';
// "⬇ Update" in the top bar (0.7.3): bring the commits the background fetch
// found (main/gitfetch.cjs) into the working tree. It is the ONE git write
// VibeSpace does itself (Valentin, 2026-10-19; every other git write is an
// agent's job), so it only ever does the move that can't go wrong:
//
// - a FAST-FORWARD only (`merge --ff-only @{upstream}`). Git applies the whole
//   update or refuses and changes nothing; there is never a half-done merge
//   or a conflict to resolve.
// - a preflight refuses first, with the file list, when local work would be in
//   the way: a tracked file changed here AND in the update, an untracked file
//   the update would create, or commits here that GitHub doesn't have. Judged
//   from git's state, not from its (translatable) error text.
// - never while an agent commits (index.lock) or a merge/rebase is open.
//
// Everything it refuses goes to an agent (the renderer offers "Ask an agent").
const fs = require('node:fs');
const path = require('node:path');
const githistory = require('./githistory.cjs');
const gitfetch = require('./gitfetch.cjs');

const MERGE_TIMEOUT_MS = 60 * 1000; // a post-merge hook may run (npm install…)
const LIST_MAX = 20;

const readEnv = () => githistory.readOnlyGitEnv();

// the merge must take index.lock: drop GIT_OPTIONAL_LOCKS; never prompt
function writeEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'GIT_OPTIONAL_LOCKS') delete env[k];
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

const split0 = (s) => String(s || '').split('\0').filter(Boolean);

// porcelain v1 -z → [{ xy, path }]; a rename/copy entry carries its source
// path as the NEXT field, which is skipped (the new path is what's on disk)
function parseStatus(out) {
  const fields = split0(out);
  const list = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const xy = f.slice(0, 2);
    list.push({ xy, path: f.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return list;
}

// What's waiting on the upstream: { count, subjects[] } (newest first), or
// null when there is no upstream / git failed
async function incoming(repoPath, max = 8) {
  const [n, log] = await Promise.all([
    gitfetch.run(repoPath, ['rev-list', '--count', 'HEAD..@{upstream}'], { env: readEnv() }),
    gitfetch.run(repoPath, ['log', '--format=%s', '-n', String(max), 'HEAD..@{upstream}'], { env: readEnv() }),
  ]);
  if (n.code !== 0 || log.code !== 0) return null;
  return { count: Number(n.out.trim()) || 0, subjects: log.out.split(/\r?\n/).filter(Boolean) };
}

// Local work the update would run into → { tracked[], untracked[] } (paths
// relative to the repo root, capped), or null when git failed
async function blockers(repoPath) {
  const [diff, st] = await Promise.all([
    gitfetch.run(repoPath, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '@{upstream}'], { env: readEnv() }),
    gitfetch.run(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env: readEnv() }),
  ]);
  if (diff.code !== 0 || st.code !== 0) return null;
  const touched = new Set(split0(diff.out));
  const tracked = [];
  const untracked = [];
  for (const e of parseStatus(st.out)) {
    if (!touched.has(e.path)) continue;
    (e.xy === '??' ? untracked : tracked).push(e.path);
  }
  return { tracked: tracked.slice(0, LIST_MAX), untracked: untracked.slice(0, LIST_MAX), more: Math.max(0, tracked.length + untracked.length - LIST_MAX) };
}

// → { ok: true, count, from, to } | { ok: true, upToDate: true }
//   | { ok: false, reason, … } with reason one of:
//     'no-upstream' | 'operation' (+ operation) | 'busy' (index.lock)
//     | 'diverged' (+ ahead, behind) | 'local-changes' (+ tracked, untracked, more)
//     | 'error' (+ error)
async function fastForward(repoPath, { fetch = true } = {}) {
  let b = await githistory.branch(repoPath);
  if (!b) return { ok: false, reason: 'error', error: 'not a git repository' };
  if (!b.head || !b.upstream) return { ok: false, reason: 'no-upstream' };
  if (b.operation) return { ok: false, reason: 'operation', operation: b.operation };
  const dir = await githistory.gitDir(repoPath);
  const locked = () => Boolean(dir && fs.existsSync(path.join(dir, 'index.lock')));
  if (locked()) return { ok: false, reason: 'busy' };
  // newest state first; a failed fetch still leaves what the background
  // fetch saw, so it isn't an error here
  let fetchError = null;
  if (fetch) {
    const f = await gitfetch.fetchOnce(repoPath);
    if (f && f.ok === false) fetchError = f.error || 'fetch failed';
    gitfetch.noteManual(repoPath, f);
    b = (await githistory.branch(repoPath)) || b;
  }
  if (!b.behind) return { ok: true, upToDate: true, fetchError };
  if (b.ahead) return { ok: false, reason: 'diverged', ahead: b.ahead, behind: b.behind, fetchError };
  const bl = await blockers(repoPath);
  if (!bl) return { ok: false, reason: 'error', error: "couldn't compare local changes with the update" };
  if (bl.tracked.length || bl.untracked.length) return { ok: false, reason: 'local-changes', ...bl, behind: b.behind };
  if (locked()) return { ok: false, reason: 'busy' };
  const from = b.oid;
  const r = await gitfetch.run(repoPath, ['merge', '--ff-only', '--quiet', '@{upstream}'], { env: writeEnv(), timeout: MERGE_TIMEOUT_MS });
  if (r.code !== 0) {
    const lines = String(r.err || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return { ok: false, reason: 'error', error: lines.slice(0, 4).join(' · ').slice(0, 300) || `git exited ${r.code}` };
  }
  const after = await githistory.branch(repoPath);
  return { ok: true, count: b.behind, from, to: after ? after.oid : null };
}

// a background fetch failure that means "can't sign in" (vs offline etc.)
function isAuthError(text) {
  return /could not read (username|password)|authentication failed|terminal prompts disabled|permission denied \(publickey|repository not found|returned error: 40[13]|invalid username or (password|token)|access denied/i.test(String(text || ''));
}

module.exports = { incoming, fastForward, isAuthError, _parseStatus: parseStatus };
