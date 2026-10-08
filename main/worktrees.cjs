'use strict';
// Worktree tabs: an agent tab that works in its own git worktree, so parallel
// agents never touch each other's files. VibeSpace creates and owns the
// worktree (a plain `git worktree add`), never `claude -w`: claude's own
// worktrees MOVE the transcript between project dirs on /exit (and a hard kill
// strands it), and their cleanup half-fails on Windows. Ours keep the transcript
// at munged(<worktree path>) for good, and the tab's shell sits there too.
//
//   <repo>\.claude\worktrees\<name>   on branch vs/<name>, from the repo's HEAD
//
// The write calls (worktree add/remove, branch -d/-D) ARE the feature, not UI
// git buttons; merging back stays with the agents. Every call still runs with
// GIT_OPTIONAL_LOCKS=0 / GIT_TERMINAL_PROMPT=0 like the read-only ones, so our
// status probes never take index.lock under an agent's commit.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WT_REL = path.join('.claude', 'worktrees');
const BRANCH_PREFIX = 'vs/';
const BASE_KEY = 'vibespacebase'; // git config branch.vs/<name>.vibespacebase (dies with the branch)

function gitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

// → { ok, code, out, err } — never throws; no git on PATH = ok:false
function git(cwd, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    const out = [];
    const err = [];
    try {
      proc = spawn('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], { cwd, env: gitEnv(), windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, code: -1, out: '', err: e.message });
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out: '', err: e.message }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8').trim() });
    });
  });
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
const gitError = (r) => firstLine(r.err.replace(/^(fatal|error):\s*/i, '')) || `git exited ${r.code}`;
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// tab name → folder/branch name: lowercase [a-z0-9-]
function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

function rootOf(repo) { return path.join(path.resolve(repo), WT_REL); }

// `.claude/worktrees/` must be ignored LOCALLY (info/exclude, never .gitignore),
// or the main tree's git status and our Git pane list the worktree folders as
// untracked. Anchored to the repo's position inside the git toplevel.
async function ensureExcluded(repo) {
  const common = await git(repo, ['rev-parse', '--git-common-dir']);
  const prefix = await git(repo, ['rev-parse', '--show-prefix']);
  if (!common.ok || !prefix.ok) return false;
  const file = path.join(path.resolve(repo, firstLine(common.out)), 'info', 'exclude');
  const line = '/' + firstLine(prefix.out).replace(/\\/g, '/') + '.claude/worktrees/';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (text.split(/\r?\n/).some(l => l.trim() === line)) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
  return true;
}

// `git worktree list --porcelain` → [{ path, head, branch, locked, prunable }]
function parsePorcelain(out) {
  const list = [];
  let cur = null;
  for (const raw of String(out || '').split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (!l) { if (cur) list.push(cur); cur = null; continue; }
    const sp = l.indexOf(' ');
    const key = sp < 0 ? l : l.slice(0, sp);
    const val = sp < 0 ? '' : l.slice(sp + 1);
    if (key === 'worktree') { if (cur) list.push(cur); cur = { path: path.resolve(val), head: null, branch: null, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}

async function registered(repo) {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  return r.ok ? parsePorcelain(r.out) : null;
}

async function branchExists(repo, branch) {
  return (await git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch])).ok;
}

// The workspace's "copy .env* files" setting: untracked .env* files at the repo
// root go into the same folder of the new worktree. Never overwrites: a tracked
// one (.env.example) is already there from the checkout.
// prefix = the repo's folder inside the git toplevel ('' at the top).
function copyEnvFiles(repo, wtPath, prefix) {
  const to = path.join(wtPath, prefix || '');
  const copied = [];
  let names = [];
  try {
    names = fs.readdirSync(repo, { withFileTypes: true }).filter(d => d.isFile() && /^\.env/i.test(d.name)).map(d => d.name);
  } catch { return copied; }
  for (const n of names) {
    try { fs.copyFileSync(path.join(repo, n), path.join(to, n), fs.constants.COPYFILE_EXCL); copied.push(n); } catch {}
  }
  return copied;
}

// create(repo, name, { copyEnv }) → { ok: true, name, path, branch, base, copied } | { ok: false, reason }
// Works with a dirty main tree: the new worktree checks out HEAD, uncommitted
// changes stay where they are. copied = the .env* files copyEnv copied.
async function create(repo, name, { copyEnv = false } = {}) {
  const top = await git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, reason: /not a git repository/i.test(top.err) ? 'not a git repository' : gitError(top) };
  const head = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head.ok) return { ok: false, reason: 'the repository has no commits yet' };
  const sym = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const base = sym.ok && firstLine(sym.out) ? firstLine(sym.out) : firstLine(head.out); // branch, or the commit when detached
  const wts = (await registered(repo)) || [];
  const stem = slug(name);
  let n = stem;
  for (let i = 2; ; i++) {
    const p = path.join(rootOf(repo), n);
    const taken = fs.existsSync(p) || wts.some(w => sameDir(w.path, p)) || await branchExists(repo, BRANCH_PREFIX + n);
    if (!taken) break;
    n = `${stem}-${i}`;
    if (i > 200) return { ok: false, reason: 'no free worktree name' };
  }
  try {
    if (!(await ensureExcluded(repo))) return { ok: false, reason: 'could not read the git dir' };
  } catch (e) {
    return { ok: false, reason: 'info/exclude: ' + e.message };
  }
  const p = path.join(rootOf(repo), n);
  const branch = BRANCH_PREFIX + n;
  fs.mkdirSync(rootOf(repo), { recursive: true });
  const add = await git(repo, ['worktree', 'add', '-b', branch, p, 'HEAD'], { timeout: 120000 });
  if (!add.ok) return { ok: false, reason: gitError(add) };
  await git(repo, ['config', `branch.${branch}.${BASE_KEY}`, base]);
  let copied = [];
  if (copyEnv) {
    const prefix = await git(repo, ['rev-parse', '--show-prefix']);
    if (prefix.ok) copied = copyEnvFiles(repo, p, firstLine(prefix.out));
  }
  return { ok: true, name: n, path: p, branch, base, copied };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "2 commits not merged · 3 uncommitted files" ('' = nothing would be lost).
// Fails CLOSED: a count we couldn't get (null) is reported as a loss, so a safe
// remove never deletes a worktree or branch whose state is unknown.
function lossText(w) {
  const parts = [];
  if (w.ahead === null) parts.push("couldn't check for unmerged commits");
  else if (w.ahead > 0 && !w.merged) parts.push(plural(w.ahead, 'commit', 'commits') + ' not merged');
  if (w.dirty === null) parts.push("couldn't check for uncommitted files");
  else if (w.dirty > 0) parts.push(plural(w.dirty, 'uncommitted file', 'uncommitted files'));
  return parts.join(' · ');
}

// one worktree's state; base from our branch config, else the main tree's branch
async function describe(repo, w, mainBranch) {
  const name = path.basename(w.path);
  const exists = fs.existsSync(w.path);
  const cfg = w.branch ? await git(repo, ['config', '--get', `branch.${w.branch}.${BASE_KEY}`]) : { ok: false };
  const base = (cfg.ok && firstLine(cfg.out)) || mainBranch || null;
  // null = couldn't tell → lossText reports it, so a safe remove keeps the worktree
  let dirty = 0;
  if (exists) {
    const st = await git(w.path, ['status', '--porcelain']);
    dirty = st.ok ? st.out.split(/\r?\n/).filter(Boolean).length : null;
  }
  let ahead = w.branch ? null : 0; // a detached worktree has no branch to lose
  let merged = false;
  if (w.branch && base) {
    const cnt = await git(repo, ['rev-list', '--count', `${base}..${w.branch}`]);
    const n = cnt.ok ? Number(firstLine(cnt.out)) : NaN;
    ahead = Number.isFinite(n) ? n : null;
    merged = (await git(repo, ['merge-base', '--is-ancestor', w.branch, base])).ok;
  }
  const out = { name, path: w.path, branch: w.branch, base, head: w.head, dirty, ahead, merged, locked: w.locked, exists };
  out.loss = lossText(out);
  return out;
}

// list(repo) → our worktrees (under .claude/worktrees) | null (not a git repo)
async function list(repo) {
  const wts = await registered(repo);
  if (!wts) return null;
  const root = rootOf(repo).toLowerCase() + path.sep;
  const ours = wts.filter(w => w.path.toLowerCase().startsWith(root));
  if (!ours.length) return [];
  const sym = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const mainBranch = sym.ok ? firstLine(sym.out) : null;
  return Promise.all(ours.map(w => describe(repo, w, mainBranch)));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0; } catch { return false; }
}

// remove(repo, name, { discard }) → { ok: true, branchKept? } | { ok: false, reason, kept? }
//   safe (default): only with no uncommitted files and nothing unmerged; else
//     refuses with kept: true and the reason ("2 commits not merged · …")
//   discard: --force + branch -D (the renderer confirms what is lost first)
// Windows: a closing tab's shell may still hold the folder for a moment, so the
// remove is retried; a half-done remove is pruned and an empty leftover deleted.
async function remove(repo, name, { discard = false } = {}) {
  const all = await list(repo);
  if (!all) return { ok: false, reason: 'not a git repository' };
  const w = all.find(x => x.name === String(name || ''));
  if (!w) return { ok: false, reason: `no worktree named ${name}` };
  if (!discard) {
    if (w.loss) return { ok: false, kept: true, reason: w.loss };
    if (w.locked) return { ok: false, kept: true, reason: 'the worktree is locked' };
  }
  let lastErr = '';
  if (w.exists) {
    const args = ['worktree', 'remove'];
    if (discard) args.push('--force');
    if (discard && w.locked) args.push('--force'); // twice: also removes a locked one
    args.push(w.path);
    for (let i = 0; i < 4; i++) {
      if (i) await sleep(1200);
      const r = await git(repo, args, { timeout: 60000 });
      if (r.ok) { lastErr = ''; break; }
      lastErr = gitError(r);
      // half-done: git deleted the .git file but not the folder → stop retrying
      if (!fs.existsSync(path.join(w.path, '.git'))) break;
    }
  }
  await git(repo, ['worktree', 'prune']); // drops the admin entry of a half-removed or vanished worktree
  if (isEmptyDir(w.path)) { try { fs.rmdirSync(w.path); } catch {} }
  if (fs.existsSync(w.path)) return { ok: false, reason: `could not remove the folder: ${lastErr || 'files still in use'}` };
  let branchKept = false;
  if (w.branch) {
    let br = await git(repo, ['branch', discard ? '-D' : '-d', w.branch]);
    // -d checks against the main tree's CURRENT branch; we already verified the
    // branch is fully in its base, so a moved HEAD must not strand it
    if (!br.ok && !discard && w.ahead === 0) br = await git(repo, ['branch', '-D', w.branch]);
    branchKept = !br.ok && (await branchExists(repo, w.branch));
  }
  return { ok: true, branchKept };
}

module.exports = { create, list, remove, slug, lossText, _parsePorcelain: parsePorcelain, WT_REL };
