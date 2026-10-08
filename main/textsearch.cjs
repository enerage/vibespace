'use strict';
// Full-text search for the left pane's Search tab (Ctrl+Shift+F). Read-only.
// Engine: `git grep` over tracked + untracked-not-ignored files (Git is a hard
// dependency, and it honours .gitignore for free). A folder that isn't a git
// repo falls back to a bounded async walk with the tree's ignore rules.
// Highlight ranges are computed here in JS (git's --column is a BYTE offset of
// the first match only; Monaco wants UTF-16 columns for every match).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

const DEFAULTS = { maxLines: 2000, maxFiles: 200, timeout: 8000 };
const MAX_TEXT = 300;          // characters of a hit line sent to the renderer
const WALK_MAX_BYTES = 1024 * 1024;
const WALK_MAX_FILES = 20000;  // files looked at by the fallback walk

// Same contract as githistory: never take .git/index.lock (agents commit in
// this repo), never prompt.
function readOnlyGitEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

// The tree's ignore list as git pathspecs (gitignored files are already out).
// '.git' is never searched; agent worktrees are full checkouts of the repo.
function excludePathspecs() {
  const out = [':(exclude).claude/worktrees'];
  for (const name of U.IGNORED_NAMES) {
    if (name === '.git') continue;
    out.push(`:(exclude,glob)**/${name}/**`);
  }
  for (const suf of U.IGNORED_SUFFIXES) out.push(`:(exclude,glob)**/*${suf}`);
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The JS twin of the git flags: fixed string by default, -E for regex, -w, -i.
// Throws on an invalid regex (the caller reports it).
function buildMatcher({ query, caseSensitive, wholeWord, regex }) {
  const src = regex ? query : escapeRe(query);
  const flags = caseSensitive ? 'g' : 'gi';
  try { // unicode mode first (letters beyond ASCII count as word characters)
    return new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, flags + 'u');
  } catch {
    // a user regex like \- is valid only without the u flag
    return new RegExp(wholeWord ? `(?<!\\w)(?:${src})(?!\\w)` : src, flags);
  }
}

// every match of re in line as [start, end) UTF-16 ranges (zero-length skipped)
function rangesIn(re, line) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
    if (out.length >= 50) break;
  }
  return out;
}

// One hit for the renderer: { line, col, len, text, ranges }. col/len point at
// the first match in the FULL line (1-based, for Monaco); text is trimmed to a
// window around it for very long lines and ranges are shifted to match.
function makeHit(lineNo, raw, re, gitCol) {
  const line = raw.replace(/\r$/, '');
  let ranges = re ? rangesIn(re, line) : [];
  if (!ranges.length && gitCol > 0) {
    // the JS regex disagrees with git's (POSIX ERE corner case): use git's byte column
    const start = Buffer.from(line, 'utf8').subarray(0, gitCol - 1).toString('utf8').length;
    ranges = [[start, Math.min(line.length, start + 1)]];
  }
  const first = ranges[0] || [0, 0];
  let text = line;
  let shift = 0;
  if (line.length > MAX_TEXT) {
    shift = Math.max(0, first[0] - 60);
    text = (shift ? '…' : '') + line.slice(shift, shift + MAX_TEXT) + (shift + MAX_TEXT < line.length ? '…' : '');
    const lead = shift ? 1 : 0;
    ranges = ranges
      .map(([s, e]) => [s - shift + lead, Math.min(e, shift + MAX_TEXT) - shift + lead])
      .filter(([s, e]) => s >= lead && e > s);
  }
  return { line: lineNo, col: first[0] + 1, len: first[1] - first[0], text, ranges };
}

class Collector {
  constructor(root, opts) {
    this.root = root;
    this.maxLines = opts.maxLines;
    this.maxFiles = opts.maxFiles;
    this.byRel = new Map();
    this.files = [];
    this.hitCount = 0;
    this.truncated = false;
  }
  // returns false once a cap is reached (the caller stops reading)
  add(abs, hit) {
    const rel = path.relative(this.root, abs).replace(/\\/g, '/');
    let f = this.byRel.get(rel);
    if (!f) {
      if (this.files.length >= this.maxFiles) { this.truncated = true; return false; }
      f = { rel, path: abs, hits: [] };
      this.byRel.set(rel, f);
      this.files.push(f);
    }
    f.hits.push(hit);
    this.hitCount++;
    if (this.hitCount >= this.maxLines) { this.truncated = true; return false; }
    return true;
  }
  result(engine, extra = {}) {
    // git grep's threads don't always keep path order: sort like git does (bytewise)
    this.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { engine, files: this.files,hitCount: this.hitCount, fileCount: this.files.length, truncated: this.truncated, ...extra };
  }
}

function runGit(cwd, args, { timeout, signal }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], { cwd, env: readOnlyGitEnv(), windowsHide: true, signal });
    } catch { return resolve(null); }
    const chunks = [];
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
}

// git grep, streamed: stdout is parsed record by record and the process is
// killed as soon as a cap (lines/files) or the deadline is hit.
function gitGrep(root, top, q, re, opts, signal) {
  return new Promise((resolve) => {
    const col = new Collector(root, opts);
    const args = ['grep', '-n', '-I', '--column', '--no-color', '--untracked', '--full-name', '-z'];
    if (!q.caseSensitive) args.push('-i');
    if (q.wholeWord) args.push('-w');
    args.push(q.regex ? '-E' : '-F', '-e', q.query, '--', '.', ...excludePathspecs());
    let proc;
    try {
      proc = spawn('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], { cwd: root, env: readOnlyGitEnv(), windowsHide: true, signal });
    } catch (e) {
      return resolve({ error: 'git failed to start: ' + (e.message || e) });
    }
    let done = false;
    let stopped = false;
    let timedOut = false;
    let pending = Buffer.alloc(0);
    const errChunks = [];
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const stop = () => { stopped = true; try { proc.kill(); } catch {} };
    const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeout);
    const parse = (buf) => {
      let at = 0;
      for (;;) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const rec = buf.subarray(at, nl).toString('utf8');
        at = nl + 1;
        // file \0 line \0 column \0 text
        const a = rec.indexOf('\0');
        const b = rec.indexOf('\0', a + 1);
        const c = rec.indexOf('\0', b + 1);
        if (a < 0 || b < 0 || c < 0) continue;
        const abs = path.join(top, rec.slice(0, a));
        const hit = makeHit(Number(rec.slice(a + 1, b)), rec.slice(c + 1), re, Number(rec.slice(b + 1, c)));
        if (!col.add(abs, hit)) { stop(); return buf.subarray(buf.length); }
      }
      return buf.subarray(at);
    };
    proc.stdout.on('data', (d) => {
      if (stopped) return;
      pending = parse(pending.length ? Buffer.concat([pending, d]) : d);
    });
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', (e) => {
      if (e && e.name === 'AbortError') return finish({ aborted: true });
      if (stopped) return; // the kill we asked for
      finish({ error: 'git grep failed: ' + (e.message || e) });
    });
    proc.on('close', (code) => {
      if (signal && signal.aborted) return finish({ aborted: true });
      if (!stopped && pending.length) parse(Buffer.concat([pending, Buffer.from('\n')]));
      // 1 = no match; anything else unrequested is an error (bad regex: 128)
      if (!stopped && code !== 0 && code !== 1) {
        const msg = Buffer.concat(errChunks).toString('utf8').trim().replace(/^fatal:\s*/i, '');
        return finish({ error: msg || `git grep exited with ${code}` });
      }
      finish(col.result('git', { timedOut, truncated: col.truncated || timedOut }));
    });
  });
}

// Not a git repo: bounded async walk (tree ignore rules, ≤ 1 MB, no NUL bytes).
async function walkSearch(root, re, opts, signal) {
  const col = new Collector(root, opts);
  const deadline = Date.now() + opts.timeout;
  let seen = 0;
  let timedOut = false;
  const queue = [root];
  outer:
  while (queue.length) {
    const dir = queue.shift();
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    ents.sort((x, y) => x.name.localeCompare(y.name));
    for (const d of ents) {
      if (signal && signal.aborted) return { aborted: true };
      if (Date.now() > deadline) { timedOut = true; break outer; }
      if (U.IGNORED_NAMES.has(d.name) || U.IGNORED_SUFFIXES.some(s => d.name.endsWith(s))) continue;
      if (U.isAgentWorktrees(path.basename(dir), d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { queue.push(full); continue; }
      if (!d.isFile()) continue;
      if (++seen > WALK_MAX_FILES) { col.truncated = true; break outer; }
      let buf;
      try {
        const st = await fs.promises.stat(full);
        if (st.size > WALK_MAX_BYTES || st.size === 0) continue;
        buf = await fs.promises.readFile(full);
      } catch { continue; }
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        if (!col.add(full, makeHit(i + 1, lines[i], re, 0))) break outer;
      }
    }
  }
  return col.result('walk', { timedOut, truncated: col.truncated || timedOut });
}

// q: { query, caseSensitive, wholeWord, regex }; opts: { maxLines, maxFiles, timeout, signal }
// → { engine, files: [{ rel, path, hits: [{ line, col, len, text, ranges }] }],
//     hitCount, fileCount, truncated, timedOut } | { error } | { aborted } | null
async function search(root, q, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const query = String((q && q.query) || '');
  if (!root || !query) return null;
  const qq = { query, caseSensitive: Boolean(q.caseSensitive), wholeWord: Boolean(q.wholeWord), regex: Boolean(q.regex) };
  let re;
  try { re = buildMatcher(qq); } catch (e) {
    if (!qq.regex) return { error: String(e.message || e) };
    re = null; // git's ERE may still accept it; hits then use git's column
  }
  const topOut = await runGit(root, ['rev-parse', '--show-toplevel'], { timeout: 4000, signal: o.signal });
  if (o.signal && o.signal.aborted) return { aborted: true };
  if (topOut && topOut.trim()) return gitGrep(root, path.resolve(topOut.trim()), qq, re, o, o.signal);
  if (!re) return { error: 'Invalid regular expression' };
  return walkSearch(root, re, o, o.signal);
}

module.exports = { search, _buildMatcher: buildMatcher, _makeHit: makeHit };
