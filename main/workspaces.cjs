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
    await ico.buildDefaultIco(iconPath);
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

async function updateLogo(id, logoPath) {
  const data = load();
  const ws = data.workspaces.find(w => w.id === id);
  if (!ws) throw new Error(`workspace not found: ${id}`);
  await ico.buildIcoFromImage(logoPath, ws.iconPath);
  ws.hasCustomLogo = true;
  save(data);
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
