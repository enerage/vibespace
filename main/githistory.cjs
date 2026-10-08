'use strict';
// Git history for the Git pane: commit log (paged, searchable, per-file),
// one commit's changed files, file content at a revision, and branch/upstream
// info for the topbar chip. Read-only by design — nothing here writes to the
// repo. Graceful like gitstatus: no git on PATH, not a repo, or a timeout → null.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FS = '\x1f';   // field separator inside a log record
const RS = '\x1e';   // record separator between commits
const MAX_SHOW = 1024 * 1024; // file-at-revision cap, same as the Changes tab
// quotepath=off: non-ASCII paths come back as UTF-8, not "\303\251" octal escapes
const BASE = ['-c', 'core.quotepath=off', '-c', 'i18n.logOutputEncoding=UTF-8', '--no-pager'];

// Read-only git calls must never take .git/index.lock: `git status` refreshes
// the index opportunistically, and with agents committing in the same repo that
// races into "index.lock exists" failures on THEIR commits. No prompts either —
// a hidden credential prompt would hang the call until the timeout.
function readOnlyGitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function git(repoPath, args, { timeout = 8000, raw = false } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let proc;
    try {
      proc = spawn('git', [...BASE, ...args], { cwd: repoPath, env: readOnlyGitEnv(), windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, timeout);
    proc.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_SHOW * 8) { try { proc.kill(); } catch {} return; } // runaway output
      chunks.push(d);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const buf = Buffer.concat(chunks); // decode once — chunk-wise += splits UTF-8
      resolve(raw ? buf : buf.toString('utf8'));
    });
  });
}

// ---------- log ----------

// last field: Co-Authored-By trailer values — how we tell agent commits apart
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s', '%(trailers:key=Co-Authored-By,valueonly,separator=%x2C )'].join('%x1f') + '%x1e';

function isAgent(coauthors) { return /\bclaude\b|anthropic\.com/i.test(coauthors || ''); }

function parseLog(out) {
  const commits = [];
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\s+/, ''); // --follow/--name-only noise lands between records
    if (!r) continue;
    const f = r.split(FS);
    if (f.length < 8) continue;
    commits.push({
      sha: f[0], short: f[1],
      parents: f[2] ? f[2].split(' ') : [],
      author: f[3], email: f[4],
      time: Number(f[5]) * 1000,
      refs: f[6] ? f[6].split(', ').filter(Boolean) : [],
      subject: f[7],
      agent: isAgent(f[8]),
    });
  }
  return commits;
}

// opts: { skip, limit, path (repo-relative, forward slashes), query, all }
async function log(repoPath, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 150, 1), 1000);
  const skip = Math.max(Number(opts.skip) || 0, 0);
  const args = ['log', '--date-order', `--format=${LOG_FORMAT}`, '-n', String(limit + 1), '--skip', String(skip)];
  if (opts.all) args.push('--all');
  if (opts.query) {
    // message search, literal + case-insensitive. (--grep and --author AND
    // together, so an author box would need a second query — agents all commit
    // as the same user anyway.)
    args.push('-i', '-F', `--grep=${opts.query}`);
  }
  // --follow tracks renames but only works for a single FILE pathspec
  if (opts.path) args.push(...(opts.follow ? ['--follow'] : []), '--', opts.path);
  const out = await git(repoPath, args);
  if (out === null) {
    // a fresh repo with no commits exits non-zero; distinguish from "not a repo"
    const head = await git(repoPath, ['rev-parse', '--git-dir']);
    return head === null ? null : { commits: [], more: false, unpushed: [] };
  }
  const commits = parseLog(out);
  const more = commits.length > limit;
  if (more) commits.length = limit;
  // commits on HEAD that the upstream doesn't have yet — the "not pushed" marker
  const up = await git(repoPath, ['rev-list', '-n', '1000', '@{u}..HEAD']);
  const unpushed = up ? up.split('\n').filter(Boolean) : [];
  return { commits, more, unpushed };
}

// ---------- one commit ----------

// `diff-tree -z --name-status` → [{status, rel, from?}]; renames/copies carry
// the score (R087) and two paths.
function parseNameStatus(out) {
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const st = code[0];
    if (st === 'R' || st === 'C') {
      files.push({ status: st, from: parts[i + 1], rel: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: st, rel: parts[i + 1] });
      i += 1;
    }
  }
  return files;
}

// `diff-tree -z --numstat` → Map rel -> {add, del} ('-' = binary → null)
function parseNumstat(out) {
  const stats = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = p.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let rel = m[3];
    if (rel === '') { rel = parts[i + 2]; i += 2; } // rename: "a\td\t\0old\0new"
    stats.set(rel, m[1] === '-' ? null : { add: Number(m[1]), del: Number(m[2]) });
  }
  return stats;
}

async function commit(repoPath, sha) {
  if (!/^[0-9a-f]{4,64}$/i.test(String(sha))) return null;
  const head = await git(repoPath, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x2C )%x1f%B', sha]);
  if (head === null) return null;
  const f = head.split(FS);
  const parents = f[1] ? f[1].split(' ') : [];
  // merges diff against the FIRST parent (what the merge brought in), roots vs empty
  const range = parents.length ? [parents[0], sha] : ['--root', sha];
  const common = ['diff-tree', '-r', '-z', '-M', '--no-commit-id'];
  const [ns, num] = await Promise.all([
    git(repoPath, [...common, '--name-status', ...range]),
    git(repoPath, [...common, '--numstat', ...range]),
  ]);
  const stats = num ? parseNumstat(num) : new Map();
  const files = (ns ? parseNameStatus(ns) : []).map((x) => ({ ...x, stat: stats.get(x.rel) ?? null }));
  return {
    sha: f[0], parents,
    author: f[2], email: f[3], time: Number(f[4]) * 1000,
    refs: f[5] ? f[5].split(', ').filter(Boolean) : [],
    agent: isAgent(f[6]),
    message: f.slice(7).join(FS).trim(),
    files,
  };
}

// ---------- file content at a revision ----------

async function fileAt(repoPath, rev, rel) {
  if (!rev || !rel) return { content: '' };
  const buf = await git(repoPath, ['show', `${rev}:${rel.replace(/\\/g, '/')}`], { raw: true });
  if (buf === null) return { content: '', missing: true };
  if (buf.length > MAX_SHOW) return { content: '', tooLarge: true };
  if (buf.subarray(0, 8000).includes(0)) return { content: '', binary: true };
  return { content: buf.toString('utf8').replace(/\r\n/g, '\n') };
}

// before/after pair for one file of one commit (Monaco DiffEditor input)
async function commitFileDiff(repoPath, sha, file) {
  const c = await git(repoPath, ['rev-parse', `${sha}^@`]); // parents, one per line
  const parent = c ? c.split('\n').filter(Boolean)[0] : null;
  const [before, after] = await Promise.all([
    file.status === 'A' || !parent ? { content: '' } : fileAt(repoPath, parent, file.from || file.rel),
    file.status === 'D' ? { content: '' } : fileAt(repoPath, sha, file.rel),
  ]);
  return {
    original: before.content, modified: after.content,
    binary: Boolean(before.binary || after.binary),
    tooLarge: Boolean(before.tooLarge || after.tooLarge),
  };
}

// ---------- branch / upstream ----------

// `status --porcelain=v2 --branch` headers: one cheap call for branch name,
// upstream and ahead/behind. Untracked scan skipped — the tree has its own.
function parseBranch(out) {
  const b = { head: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false };
  for (const line of out.split('\0')) {
    if (!line.startsWith('# branch.')) continue;
    const [key, ...rest] = line.slice(9).split(' ');
    const val = rest.join(' ');
    if (key === 'oid') b.oid = val === '(initial)' ? null : val;
    else if (key === 'head') { b.detached = val === '(detached)'; b.head = b.detached ? null : val; }
    else if (key === 'upstream') b.upstream = val;
    else if (key === 'ab') {
      const m = val.match(/\+(\d+) -(\d+)/);
      if (m) { b.ahead = Number(m[1]); b.behind = Number(m[2]); }
    }
  }
  return b;
}

// A repo stuck mid-merge/rebase is the state agents most often leave behind
// and the one a supervisor most needs to see. --absolute-git-dir also handles
// worktrees, where .git is a FILE pointing elsewhere.
const gitDirs = new Map(); // repoPath -> absolute git dir
const OP_MARKERS = [
  ['rebase-merge', 'rebasing'], ['rebase-apply', 'rebasing'],
  ['MERGE_HEAD', 'merging'], ['CHERRY_PICK_HEAD', 'cherry-picking'], ['REVERT_HEAD', 'reverting'],
];

// absolute git dir (per worktree: index, index.lock and the op markers live here)
async function gitDir(repoPath) {
  if (!gitDirs.has(repoPath)) {
    const d = await git(repoPath, ['rev-parse', '--absolute-git-dir']);
    if (d) gitDirs.set(repoPath, d.trim());
  }
  return gitDirs.get(repoPath) || null;
}

async function branch(repoPath) {
  const out = await git(repoPath, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { timeout: 5000 });
  if (out === null) return null;
  const b = parseBranch(out);
  const dir = await gitDir(repoPath);
  b.operation = null;
  if (dir) for (const [marker, op] of OP_MARKERS) if (fs.existsSync(path.join(dir, marker))) { b.operation = op; break; }
  return b;
}

module.exports = {
  readOnlyGitEnv,
  log, commit, fileAt, commitFileDiff, branch, gitDir,
  _parseLog: parseLog, _parseNameStatus: parseNameStatus, _parseNumstat: parseNumstat, _parseBranch: parseBranch,
};
