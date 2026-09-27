'use strict';
// "Open with VibeSpace" in the Explorer right-click menu for folders.
// Per-user registry entries (HKCU, no admin needed). On Windows 11 the item
// lives in the classic menu (right-click → "Show more options" or Shift+F10).
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const U = require('./util.cjs');

const KEY_DIR = 'HKCU\\Software\\Classes\\Directory\\shell\\VibeSpace';
const KEY_BG = 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\VibeSpace';

function reg(args) {
  const r = spawnSync('reg.exe', args, { windowsHide: true });
  return r.status === 0;
}

function isInstalled() {
  return reg(['query', KEY_DIR]);
}

function install({ targetPath, rootDir }) {
  const iconPath = path.join(U.ROOT, 'assets', 'app.ico');
  // "%1" = the clicked folder; %V = the folder whose background was clicked
  const cmdFolder = `"${targetPath}" "${rootDir}" --open-repo="%1"`;
  const cmdBackground = `"${targetPath}" "${rootDir}" --open-repo="%V"`;

  reg(['add', KEY_DIR, '/ve', '/t', 'REG_SZ', '/d', 'Open with VibeSpace', '/f']);
  if (iconPath.toLowerCase().endsWith('.ico')) reg(['add', KEY_DIR, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconPath, '/f']);
  reg(['add', `${KEY_DIR}\\command`, '/ve', '/t', 'REG_SZ', '/d', cmdFolder, '/f']);

  reg(['add', KEY_BG, '/ve', '/t', 'REG_SZ', '/d', 'Open with VibeSpace', '/f']);
  reg(['add', KEY_BG, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconPath, '/f']);
  reg(['add', `${KEY_BG}\\command`, '/ve', '/t', 'REG_SZ', '/d', cmdBackground, '/f']);

  return isInstalled();
}

function uninstall() {
  reg(['delete', KEY_DIR, '/f']);
  reg(['delete', KEY_BG, '/f']);
  return !isInstalled();
}

module.exports = { install, uninstall, isInstalled };
