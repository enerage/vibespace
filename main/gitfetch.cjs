'use strict';
// Background `git fetch` so the branch chip's ↓behind count is fresh (it is
// computed against the LOCAL remote-tracking ref, which only moves on a fetch).
// One schedule per workspace: first round ~30 s after the window opens, then
// every 5 min; 3 failures in a row back off to 30 min. Only when the current
// branch has an upstream on a real remote.
//
// Lock safety (agents commit in the same repo): fetch never touches the index,
// so it can't collide on index.lock. It writes objects and refs/remotes/<remote>/*
// only: FETCH_HEAD is not written (--no-write-fetch-head, an agent's `git pull`
// reads it right after its own fetch), tags are skipped, auto-gc/maintenance is
// off (it repacks and packs refs), submodules aren't recursed. A round is
// skipped while index.lock exists or a merge/rebase/cherry-pick/revert is in
// progress. GIT_OPTIONAL_LOCKS=0 is deliberately NOT set: fetch must write refs.
//
// Never interactive: no terminal prompt, no askpass (env AND core.askPass are
// emptied, so it holds whether or not an empty env value reaches git), GCM
// non-interactive, and ssh in BatchMode unless the user configured their own
// ssh command (GIT_SSH_COMMAND / GIT_SSH / core.sshCommand are left alone).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const githistory = require('./githistory.cjs');

const FIRST_MS = 30 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_MS = 30 * 60 * 1000;
const BACKOFF_AFTER = 3;          // consecutive failures
const FETCH_TIMEOUT_MS = 60 * 1000;
const BASE = ['-c', 'core.quotepath=off', '--no-pager'];

function taskkillExe() {
  const exe = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
  return fs.existsSync(exe) ? exe : 'taskkill.exe';
}

// `git` on PATH is usually Git\cmd\git.exe, a wrapper that runs the real
// git.exe, which runs git-remote-https / sh → ssh. Kill the whole tree, and
// only kill the wrapper itself AFTER taskkill walked it: killed first, the tree
// walk finds nothing and the real fetch keeps running (seen in testing).
function killTree(proc) {
  return new Promise((resolve) => {
    const last = () => { try { proc.kill(); } catch {} resolve(); };
    let child;
    try {
      child = spawn(taskkillExe(), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { last(); return; }
    child.on('error', last);
    child.on('close', last);
  });
}

// spawn git → { code, out, err, timedOut }; code null = could not run
function run(repoPath, args, { env, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('git', [...BASE, ...args], { cwd: repoPath, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, out: '', err: e.message, timedOut: false });
    }
    const out = [];
    const err = [];
    let timedOut = false;
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    // resolves only once the tree is dead, so the next round can't overlap it
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc).then(() => finish({ code: null, out: '', err: `timed out after ${Math.round(timeout / 1000)} s`, timedOut }));
    }, timeout);
    proc.stdout.on('data', (d) => { if (out.length < 256) out.push(d); });
    proc.stderr.on('data', (d) => { if (err.length < 64) err.push(d); });
    proc.on('error', (e) => { if (!timedOut) finish({ code: null, out: '', err: e.message, timedOut }); });
    proc.on('close', (code) => timedOut || finish({
      code, timedOut,
      out: Buffer.concat(out).toString('utf8'),
      err: Buffer.concat(err).toString('utf8'),
    }));
  });
}

const readEnv = () => githistory.readOnlyGitEnv();

// env for the fetch itself: inherits the user's credential helpers / proxies,
// but can never stop and wait for a human
function fetchEnv(ownSsh) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    // must write refs; and drop inherited askpass programs (an editor's helper
    // that's no longer running would hang or pop a window)
    if (u === 'GIT_OPTIONAL_LOCKS' || u === 'GIT_ASKPASS' || u === 'SSH_ASKPASS') delete env[k];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS_REQUIRE = 'never';
  if (!ownSsh) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

// the user's own ssh command wins over our BatchMode default
async function hasOwnSsh(repoPath) {
  for (const k of Object.keys(process.env)) {
    const u = k.toUpperCase();
    if ((u === 'GIT_SSH_COMMAND' || u === 'GIT_SSH') && process.env[k]) return true;
  }
  const r = await run(repoPath, ['config', '--get', 'core.sshCommand'], { env: readEnv() });
  return r.code === 0 && Boolean(r.out.trim());
}

async function remoteRefs(repoPath, remote) {
  const r = await run(repoPath, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/remotes/${remote}/`], { env: readEnv() });
  return r.code === 0 ? r.out : null;
}

function lastLine(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 200);
}

// One round. → { ok: true, changed, remote, ms } | { skipped: reason } |
// { ok: false, error, timedOut }
async function fetchOnce(repoPath, { timeout = FETCH_TIMEOUT_MS } = {}) {
  const b = await githistory.branch(repoPath);
  if (!b) return { skipped: 'not a repository' };
  if (!b.head || !b.upstream) return { skipped: 'no upstream' };
  if (b.operation) return { skipped: b.operation };
  const dir = await githistory.gitDir(repoPath);
  if (dir && fs.existsSync(path.join(dir, 'index.lock'))) return { skipped: 'index.lock present' };
  const rc = await run(repoPath, ['config', '--get', `branch.${b.head}.remote`], { env: readEnv() });
  const remote = rc.code === 0 ? rc.out.trim() : '';
  // '.' = upstream is a local branch, nothing to fetch; '-…' would read as an option
  if (!remote || remote === '.' || remote.startsWith('-')) return { skipped: 'no remote upstream' };
  const env = fetchEnv(await hasOwnSsh(repoPath));
  const before = await remoteRefs(repoPath, remote);
  const t0 = Date.now();
  const r = await run(repoPath, [
    '-c', 'core.askPass=', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    'fetch', '--quiet', '--no-tags', '--prune', '--no-write-fetch-head', '--recurse-submodules=no', remote,
  ], { env, timeout });
  const ms = Date.now() - t0;
  if (r.code !== 0) return { ok: false, error: lastLine(r.err) || `git exited ${r.code}`, timedOut: r.timedOut, ms };
  const after = await remoteRefs(repoPath, remote);
  return { ok: true, changed: before !== after, remote, ms };
}

// ---------- per-workspace schedule ----------

const active = new Map(); // wsId -> state
let listener = () => {};

// fn(wsId, result, info) after every round that wasn't skipped
function onResult(fn) { listener = fn; }

// opts.enabled(): the workspace's ⚙ switch, read at each round
function start(wsId, repoPath, { enabled = () => true, firstMs = FIRST_MS } = {}) {
  stop(wsId);
  const st = { repoPath, enabled, timer: null, running: false, failures: 0, at: null, error: null, stopped: false };
  active.set(wsId, st);
  schedule(wsId, st, firstMs);
  return st;
}

function schedule(wsId, st, ms) {
  clearTimeout(st.timer);
  if (st.stopped) return;
  st.timer = setTimeout(() => round(wsId, st), ms);
  if (st.timer.unref) st.timer.unref();
}

async function round(wsId, st) {
  if (st.running || st.stopped) return; // never two fetches at once
  let on = true;
  try { on = st.enabled() !== false; } catch {}
  if (!on) { schedule(wsId, st, INTERVAL_MS); return; }
  st.running = true;
  let r;
  try { r = await fetchOnce(st.repoPath); } catch (e) { r = { ok: false, error: e.message }; }
  st.running = false;
  if (st.stopped) return;
  if (r.skipped) { schedule(wsId, st, INTERVAL_MS); return; }
  const wasFailing = st.failures;
  if (r.ok) { st.failures = 0; st.at = Date.now(); st.error = null; } else { st.failures++; st.error = r.error; }
  try { listener(wsId, r, { ...info(wsId), recovered: r.ok && wasFailing > 0 }); } catch {}
  schedule(wsId, st, st.failures >= BACKOFF_AFTER ? BACKOFF_MS : INTERVAL_MS);
}

function stop(wsId) {
  const st = active.get(wsId);
  if (!st) return;
  st.stopped = true;
  clearTimeout(st.timer);
  active.delete(wsId);
}

// for the chip tooltip: { at (ms|null), failures, error, enabled }
function info(wsId) {
  const st = active.get(wsId);
  if (!st) return null;
  let on = true;
  try { on = st.enabled() !== false; } catch {}
  return { at: st.at, failures: st.failures, error: st.error, enabled: on, backoff: st.failures >= BACKOFF_AFTER };
}

module.exports = {
  start, stop, info, onResult, fetchOnce,
  INTERVAL_MS, BACKOFF_MS, BACKOFF_AFTER,
  _fetchEnv: fetchEnv,
};
