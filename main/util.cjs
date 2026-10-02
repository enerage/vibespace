'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ROOT points into app.asar when packaged — every bundled-file READ works there
// (electron's fs is asar-aware), but a child process cannot use it as cwd
// (ConPTY: "Cannot create process, error code: 267"). BIN_ROOT is always a REAL
// directory: the install dir next to the exe when packaged, the repo in dev.
let BIN_ROOT = ROOT;
try {
  const { app } = require('electron');
  if (app && app.isPackaged) BIN_ROOT = path.dirname(process.execPath);
} catch {}

function dataRoot() {
  return process.env.VIBESPACE_HOME || path.join(os.homedir(), '.vibespace');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Claude Code stores sessions in ~/.claude/projects/<munged-path>/<uuid>.jsonl
// where every non-alphanumeric char of the project path becomes '-'
// e.g. D:\Repositories\PlacementFlow -> D--Repositories-PlacementFlow
function mungeClaudeDir(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function claudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolve the actual project dir for a repo path (case-insensitive fallback
// because drive letters can differ, e.g. d--Repositories-...)
function resolveClaudeProjectDir(repoPath) {
  const projects = claudeProjectsDir();
  if (!fs.existsSync(projects)) return null;
  const munged = mungeClaudeDir(path.resolve(repoPath));
  const exact = path.join(projects, munged);
  if (fs.existsSync(exact)) return exact;
  const lower = munged.toLowerCase();
  for (const name of fs.readdirSync(projects)) {
    if (name.toLowerCase() === lower) return path.join(projects, name);
  }
  return null;
}

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'workspace';
}

function randId(len = 4) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Crash-safe JSON files (state.json, workspaces.json, …). A PC reboot on
// 2026-10-01 left recruitica's state.json unreadable: the tmp file was renamed
// before its bytes reached the disk, so the window came back with defaults (no
// conversation, terminal at the bottom). Now: fsync the tmp BEFORE the rename,
// and keep the previous good copy as <file>.bak, which readJson falls back to.
function parsesOk(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd); // bytes on disk before the rename makes them "the" file
  } finally {
    fs.closeSync(fd);
  }
  // only a GOOD current file becomes the backup — never overwrite a valid
  // .bak with a corrupt leftover
  if (fs.existsSync(file) && parsesOk(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* backup is best-effort */ }
  }
  fs.renameSync(tmp, file);
}

// main sets this to its logger; util stays dependency-free
let corruptionReporter = () => {};
function onCorruptJson(fn) { corruptionReporter = typeof fn === 'function' ? fn : () => {}; }

function readJson(file, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // missing is normal (first run); an unreadable file still tries the backup
    return fs.existsSync(file + '.bak') && !fs.existsSync(file) ? readBackup(file, fallback, 'missing') : fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // keep the broken file for diagnosis, then fall back to the last good copy
    const kept = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, kept); } catch { /* leave it in place */ }
    const head = JSON.stringify(raw.slice(0, 40));
    return readBackup(file, fallback, `unreadable (${raw.length} bytes, starts ${head}: ${e.message}) — kept as ${path.basename(kept)}`);
  }
}

function readBackup(file, fallback, why) {
  try {
    const v = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    corruptionReporter(`${path.basename(file)} ${why} — restored from .bak`, file);
    return v;
  } catch {
    corruptionReporter(`${path.basename(file)} ${why} — no usable .bak, using defaults`, file);
    return fallback;
  }
}

// Shared ignore rules for the file tree, the Ctrl+P index, and the tree watcher.
const IGNORED_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '__pycache__', '.next', '.venv', 'venv', 'target', '.cache', '.turbo', '.parcel-cache', '.idea', '*.egg-info', 'playwright-report', 'test-results', '.nx', '.angular', '.sst', '.expo', '.output']);
const IGNORED_SUFFIXES = ['.tsbuildinfo', '.eslintcache', '.stackdump'];

// <repo>/.claude/worktrees holds the worktree tabs' checkouts (0.6.36): full copies
// of the repo that would show every file twice in the tree and Ctrl+P
const isAgentWorktrees = (parentName, name) => name === 'worktrees' && parentName === '.claude';

// 'src/node_modules/x' or 'foo.tsbuildinfo' -> ignored (slash-separated, relative)
function isIgnoredPath(rel) {
  const segs = rel.split('/');
  if (segs.some(s => IGNORED_NAMES.has(s))) return true;
  if (segs.some((s, i) => i > 0 && isAgentWorktrees(segs[i - 1], s))) return true;
  const last = segs[segs.length - 1];
  return IGNORED_SUFFIXES.some(s => last.endsWith(s));
}

// Copy a file into destDir without ever overwriting: "name (2).ext", "(3)"…
// Returns the final file name. Used by the tree's drag-and-drop.
function copyIn(source, destDir) {
  const base = path.basename(source);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let target = path.join(destDir, base);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(destDir, `${stem} (${i})${ext}`);
  fs.copyFileSync(source, target);
  return path.basename(target);
}

// Jail check for tree file operations: return the resolved absolute path only
// if it lives STRICTLY INSIDE repoRoot, else null. Compare is case-insensitive
// (Windows drive-letter casing varies); the +path.sep guard means a
// sibling-prefix path (root D:\a vs D:\ab\x) must NOT count as inside.
function jailed(repoRoot, p) {
  const r = path.resolve(p);
  const root = path.resolve(repoRoot);
  return r.toLowerCase().startsWith(root.toLowerCase() + path.sep) ? r : null;
}

// Windows keeps the REAL PATH in two registry values (machine + user). Processes
// spawned from stripped environments (agent shells etc.) inherit a gutted PATH —
// rebuilding it from the registry gives every pty and every spawned child the
// full user+machine PATH regardless of how the window was launched.
// reg.exe is called by ABSOLUTE path, never by name: under exactly the broken PATH
// this function exists to repair, a bare `reg` is not found, the read silently
// returns '' and the "rebuild" keeps only the mangled leftovers.
function regExe() {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
}

function readRegistryPath(key) {
  try {
    const out = execFileSync(regExe(), ['query', key, '/v', 'PATH'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const m = out.match(/^\s*PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)$/mi);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function expandEnvVars(s) {
  return String(s).replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole);
}

function rebuildPath(inherited = process.env.PATH || '') {
  const machine = expandEnvVars(readRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'));
  const user = expandEnvVars(readRegistryPath('HKCU\\Environment'));
  const parts = [];
  const seen = new Set();
  for (const p of `${machine};${user};${inherited}`.split(';')) {
    const t = p.trim();
    const key = t.toLowerCase().replace(/\\+$/, '');
    // "C:Windows" is drive-RELATIVE and statSync resolves it to C:\Windows, so the
    // exists-check alone would keep it — require a real absolute path first
    if (!t || seen.has(key) || !path.win32.isAbsolute(t)) continue;
    // drop entries that don't exist — mangled ones ("C:Windows", backslashes eaten
    // by an agent-spawned chain) and leftovers from unset %vars% die here
    try {
      const st = fs.statSync(t);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    parts.push(t);
  }
  return parts.join(';');
}

module.exports = {
  rebuildPath,
  copyIn,
  ROOT,
  BIN_ROOT,
  dataRoot,
  IGNORED_NAMES,
  IGNORED_SUFFIXES,
  isIgnoredPath,
  isAgentWorktrees,
  jailed,
  ensureDir,
  mungeClaudeDir,
  claudeProjectsDir,
  resolveClaudeProjectDir,
  slugify,
  randId,
  writeJsonAtomic,
  readJson,
  onCorruptJson,
};
