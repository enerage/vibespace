'use strict';
// Tree file operations (new file / new folder / rename / delete), jailed to the
// workspace repo root via U.jailed so a renderer can never touch outside it.
// Pure-ish: repoRoot is passed explicitly (no IPC here) so smoke.cjs can drive
// these directly. Every guard failure throws (remove rejects) — that surfaces
// to the renderer as an invoke rejection with the message.
const path = require('node:path');
const fs = require('node:fs');
const { shell } = require('electron');
const U = require('./util.cjs');

// A plain entry name: no separators, no traversal, not empty.
function assertName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\')) {
    throw new Error(`bad name: ${JSON.stringify(name)}`);
  }
}

function create(repoRoot, dirPath, fileName) {
  const dir = U.jailed(repoRoot, dirPath);
  if (!dir) throw new Error('outside workspace');
  assertName(fileName);
  const target = U.jailed(repoRoot, path.join(dir, fileName));
  if (!target) throw new Error('outside workspace');
  if (fs.existsSync(target)) throw new Error(`already exists: ${fileName}`);
  fs.writeFileSync(target, '');
  return { path: target };
}

function mkdir(repoRoot, dirPath, name) {
  const dir = U.jailed(repoRoot, dirPath);
  if (!dir) throw new Error('outside workspace');
  assertName(name);
  const target = U.jailed(repoRoot, path.join(dir, name));
  if (!target) throw new Error('outside workspace');
  if (fs.existsSync(target)) throw new Error(`already exists: ${name}`);
  fs.mkdirSync(target);
  return { path: target };
}

function rename(repoRoot, from, to) {
  const src = U.jailed(repoRoot, from);
  if (!src) throw new Error('outside workspace');
  const dst = U.jailed(repoRoot, to);
  if (!dst) throw new Error('outside workspace');
  // dst is strictly inside root, so its dir is root-or-inside by construction —
  // jailed() alone would wrongly reject "root" itself (top-level renames).
  const dstDir = path.dirname(dst);
  const dirOk = U.jailed(repoRoot, dstDir) !== null
    || dstDir.toLowerCase() === path.resolve(repoRoot).toLowerCase();
  if (!dirOk || !fs.existsSync(dstDir)) throw new Error('destination folder missing');
  fs.renameSync(src, dst);
  return true;
}

// To the Recycle Bin, not unlink — tree deletes must be undoable.
function remove(repoRoot, target) {
  const t = U.jailed(repoRoot, target);
  if (!t) throw new Error('outside workspace');
  if (!fs.existsSync(t)) throw new Error(`not found: ${target}`);
  return shell.trashItem(t).then(() => true);
}

module.exports = { create, mkdir, rename, remove };
