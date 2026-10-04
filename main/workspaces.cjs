'use strict';
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');
const ico = require('./ico.cjs');

function registryFile() {
  return path.join(U.dataRoot(), 'workspaces.json');
}

function load() {
  const data = U.readJson(registryFile(), { version: 1, workspaces: [] });
  if (!Array.isArray(data.workspaces)) data.workspaces = [];
  return data;
}

function save(data) {
  U.ensureDir(U.dataRoot());
  U.writeJsonAtomic(registryFile(), data);
}

function list() {
  return load().workspaces;
}

function get(id) {
  return load().workspaces.find(w => w.id === id) || null;
}

async function create({ name, repoPath, logoPath }) {
  const data = load();
  const id = `${U.slugify(name)}-${U.randId()}`;
  U.ensureDir(path.join(U.dataRoot(), 'icons'));
  const iconPath = path.join(U.dataRoot(), 'icons', `${id}.ico`);
  if (logoPath && fs.existsSync(logoPath)) {
    await ico.buildIcoFromImage(logoPath, iconPath);
  } else {
    await ico.buildDefaultIco(iconPath, name);
  }
  const ws = {
    id,
    name: String(name).trim() || id,
    repoPath: path.resolve(repoPath),
    iconPath,
    hasCustomLogo: Boolean(logoPath && fs.existsSync(logoPath)),
    createdAt: new Date().toISOString(),
  };
  data.workspaces.push(ws);
  save(data);
  return ws;
}

// Windows caches a taskbar button's icon BY FILE PATH (the window's relaunch
// icon resource). Rebuilding the .ico at the same path left the button on the old
// picture until Explorer restarted, while the shortcut in the Start Menu folder
// already showed the new one (seen 2026-10-04). So every logo change gets a NEW
// file name; ids never contain a dot, so `<id>.v<stamp>.ico` can't collide with
// another workspace's icon.
function versionedIconPath(id, now = Date.now()) {
  return path.join(U.dataRoot(), 'icons', `${id}.v${now.toString(36)}.ico`);
}

// Drop this workspace's older versioned icons. `keep` = the new one and the one
// it replaced (a launcher window may still show that until it re-lists). The
// original `<id>.ico` is never deleted: an old pin may still point at it.
function pruneIcons(id, keep) {
  const dir = path.join(U.dataRoot(), 'icons');
  const prefix = id + '.v';
  const mine = (n) => n.startsWith(prefix) && n.endsWith('.ico') && /^[0-9a-z]+$/.test(n.slice(prefix.length, -4));
  const keepNames = new Set(keep.filter(Boolean).map(p => path.basename(p).toLowerCase()));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!mine(n) || keepNames.has(n.toLowerCase())) continue;
    try { fs.unlinkSync(path.join(dir, n)); } catch {}
  }
}

async function updateLogo(id, logoPath, now = Date.now()) {
  const data = load();
  const ws = data.workspaces.find(w => w.id === id);
  if (!ws) throw new Error(`workspace not found: ${id}`);
  U.ensureDir(path.join(U.dataRoot(), 'icons'));
  const next = versionedIconPath(ws.id, now);
  await ico.buildIcoFromImage(logoPath, next); // throws on a bad image: nothing changed yet
  const previous = ws.iconPath;
  ws.iconPath = next;
  ws.hasCustomLogo = true;
  save(data);
  pruneIcons(ws.id, [next, previous]);
  return ws;
}

function findByRepoPath(repoPath) {
  const resolved = path.resolve(repoPath).toLowerCase();
  return load().workspaces.find(w => w.repoPath.toLowerCase() === resolved) || null;
}

async function findOrCreateByRepoPath(repoPath) {
  const existing = findByRepoPath(repoPath);
  if (existing) return existing;
  if (!fs.existsSync(repoPath)) throw new Error(`folder does not exist: ${repoPath}`);
  const name = path.basename(path.resolve(repoPath));
  return create({ name, repoPath });
}

function remove(id) {
  const data = load();
  const idx = data.workspaces.findIndex(w => w.id === id);
  if (idx === -1) return false;
  const ws = data.workspaces[idx];
  data.workspaces.splice(idx, 1);
  save(data);
  try { fs.unlinkSync(ws.iconPath); } catch {}
  try { fs.rmSync(path.join(U.dataRoot(), 'instances', id), { recursive: true, force: true }); } catch {}
  return true;
}

module.exports = { list, get, create, updateLogo, remove, findByRepoPath, findOrCreateByRepoPath };
