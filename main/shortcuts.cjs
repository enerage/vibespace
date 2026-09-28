'use strict';
// Creates per-workspace .lnk shortcuts (Start Menu + Desktop) carrying a unique
// AppUserModelID so each repo pins as its own taskbar app, grouped with the
// running Electron window that sets the same AUMID at launch.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

const PS_SCRIPT = path.join(U.ROOT, 'assets', 'ps', 'set-shortcut.ps1');

function aumidFor(id) {
  return `vibespace.workspace.${id}`;
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '').trim() || 'workspace';
}

function runPs(args) {
  return new Promise((resolve) => {
    // absolute path: a workspace process spawned from a stripped-PATH chain
    // (e.g. an agent shell) can't resolve bare 'powershell.exe'
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(fs.existsSync(ps) ? ps : 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, ...args], {
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('error', err => resolve({ ok: false, detail: String(err) }));
    child.on('close', (code) => {
      const line = out.split(/\r?\n/).find(l => l.trim()) || '';
      resolve({ ok: code === 0 && line.startsWith('OK'), detail: line, full: out.trim() });
    });
  });
}

async function create({ workspace, targetPath, targetArgs, workingDir, startMenu = true, desktop = true }) {
  const name = sanitizeFileName(workspace.name);
  const aumid = aumidFor(workspace.id);
  const results = [];
  const paths = [];

  if (startMenu) {
    const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VibeSpace', `${name}.lnk`);
    paths.push(lnk);
    results.push(await runPs(['-LnkPath', lnk, '-TargetPath', targetPath, '-Arguments', targetArgs, '-WorkingDirectory', workingDir, '-IconPath', workspace.iconPath, '-Aumid', aumid, '-Name', `VibeSpace — ${workspace.name}`]));
  }
  if (desktop) {
    const desktopDir = process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop');
    if (desktopDir && fs.existsSync(desktopDir)) {
      const lnk = path.join(desktopDir, `${name}.lnk`);
      paths.push(lnk);
      results.push(await runPs(['-LnkPath', lnk, '-TargetPath', targetPath, '-Arguments', targetArgs, '-WorkingDirectory', workingDir, '-IconPath', workspace.iconPath, '-Aumid', aumid, '-Name', `VibeSpace — ${workspace.name}`]));
    }
  }

  const ok = results.length > 0 && results.every(r => r.ok);
  // readback=... inside detail tells us the AUMID really persisted; tolerate S_FALSE (0x1)
  const persisted = results.every(r => /readback=vibespace\./.test(r.detail || ''));
  return { ok, persisted, paths, details: results.map(r => r.detail), aumid };
}

async function createLauncherShortcut({ targetPath, workingDir }) {
  const lnkName = 'VibeSpace Launcher';
  const aumid = 'vibespace.app';
  const results = [];
  const paths = [];
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VibeSpace', `${lnkName}.lnk`);
  paths.push(startMenu);
  results.push(await runPs(['-LnkPath', startMenu, '-TargetPath', targetPath, '-Arguments', `"${workingDir}"`, '-WorkingDirectory', workingDir, '-IconPath', path.join(U.ROOT, 'assets', 'app.ico'), '-Aumid', aumid, '-Name', 'VibeSpace']));
  const desktopDir = process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop');
  if (desktopDir && fs.existsSync(desktopDir)) {
    const lnk = path.join(desktopDir, `${lnkName}.lnk`);
    paths.push(lnk);
    results.push(await runPs(['-LnkPath', lnk, '-TargetPath', targetPath, '-Arguments', `"${workingDir}"`, '-WorkingDirectory', workingDir, '-IconPath', path.join(U.ROOT, 'assets', 'app.ico'), '-Aumid', aumid, '-Name', 'VibeSpace']));
  }
  const ok = results.length > 0 && results.every(r => r.ok);
  const persisted = results.every(r => /readback=vibespace\./.test(r.detail || ''));
  return { ok, persisted, paths, details: results.map(r => r.detail), aumid };
}

function removeShortcuts(workspace) {
  const name = sanitizeFileName(workspace.name);
  const candidates = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VibeSpace', `${name}.lnk`),
    path.join(process.env.USERPROFILE || '', 'Desktop', `${name}.lnk`),
  ];
  for (const p of candidates) {
    try { fs.unlinkSync(p); } catch {}
  }
}

// After a logo swap the .ico is rebuilt at the SAME path the .lnk points at, but
// Windows caches shortcut icons aggressively — re-write the .lnk where it exists
// and nudge the icon cache, so taskbar pins refresh without a manual re-pin.
async function refreshIcons({ workspace, targetPath, targetArgs, workingDir }) {
  const name = sanitizeFileName(workspace.name);
  const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VibeSpace', `${name}.lnk`);
  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop', `${name}.lnk`);
  const wantStart = fs.existsSync(startMenu);
  const wantDesktop = fs.existsSync(desktop);
  if (!wantStart && !wantDesktop) return false;
  await create({ workspace, targetPath, targetArgs, workingDir, startMenu: wantStart, desktop: wantDesktop });
  const ie4u = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe');
  try {
    if (fs.existsSync(ie4u)) spawn(ie4u, ['-show'], { windowsHide: true }).unref?.();
  } catch {}
  return true;
}

function startMenuLinkPath(workspace) {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VibeSpace', `${sanitizeFileName(workspace.name)}.lnk`);
}

// Every open workspace guarantees its Start Menu shortcut exists: that .lnk is how
// Windows maps the window's AppID to a display name + icon. Without it, pinning
// the running window yields a junk "Electron" pin. Returns true if it created one.
async function ensureStartMenu({ workspace, targetPath, targetArgs, workingDir }) {
  if (fs.existsSync(startMenuLinkPath(workspace))) return false;
  const r = await create({ workspace, targetPath, targetArgs, workingDir, startMenu: true, desktop: false });
  return Boolean(r && r.ok);
}

// Junk left by Windows when a running window was pinned before its shortcut
// existed: "<Start Menu>\Programs\Electron*.lnk" targeting OUR exe with no
// arguments. Only those exact strays are deleted — never other apps' shortcuts.
function removeJunkElectronLinks(exePath) {
  const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (!/^Electron.*\.lnk$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const { shell } = require('electron');
      const info = shell.readShortcutLink(full);
      const sameExe = info.target && path.resolve(info.target).toLowerCase() === path.resolve(exePath).toLowerCase();
      if (sameExe && !String(info.args || '').trim()) {
        fs.unlinkSync(full);
        removed.push(name);
      }
    } catch {}
  }
  return removed;
}

module.exports = { create, createLauncherShortcut, removeShortcuts, refreshIcons, ensureStartMenu, removeJunkElectronLinks, startMenuLinkPath, aumidFor };
