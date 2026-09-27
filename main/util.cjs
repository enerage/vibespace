'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

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

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Shared ignore rules for the file tree, the Ctrl+P index, and the tree watcher.
const IGNORED_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '__pycache__', '.next', '.venv', 'venv', 'target', '.cache', '.turbo', '.parcel-cache', '.idea', '*.egg-info', 'playwright-report', 'test-results', '.nx', '.angular', '.sst', '.expo', '.output']);
const IGNORED_SUFFIXES = ['.tsbuildinfo', '.eslintcache', '.stackdump'];

// 'src/node_modules/x' or 'foo.tsbuildinfo' -> ignored (slash-separated, relative)
function isIgnoredPath(rel) {
  const segs = rel.split('/');
  if (segs.some(s => IGNORED_NAMES.has(s))) return true;
  const last = segs[segs.length - 1];
  return IGNORED_SUFFIXES.some(s => last.endsWith(s));
}

module.exports = {
  ROOT,
  BIN_ROOT,
  dataRoot,
  IGNORED_NAMES,
  IGNORED_SUFFIXES,
  isIgnoredPath,
  ensureDir,
  mungeClaudeDir,
  claudeProjectsDir,
  resolveClaudeProjectDir,
  slugify,
  randId,
  writeJsonAtomic,
  readJson,
};
