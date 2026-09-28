'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, clipboard, Notification, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// FIRST: rebuild PATH from the registry (machine + user). Windows spawned from
// stripped environments (agent shells) otherwise break node/python/git for every
// terminal AND every process we spawn (git status, claude --version, builds).
const U = require('./util.cjs');
process.env.PATH = U.rebuildPath();
const logger = require('./logger.cjs');
const workspaces = require('./workspaces.cjs');
const shortcuts = require('./shortcuts.cjs');
const contextmenu = require('./contextmenu.cjs');
const ptyhost = require('./ptyhost.cjs');
const sessions = require('./sessions.cjs');
const status = require('./status.cjs');
const gitstatus = require('./gitstatus.cjs');
const gitdiff = require('./gitdiff.cjs');
const fsops = require('./fsops.cjs');
const srcstate = require('./srcstate.cjs');
const treewatch = require('./treewatch.cjs');
const updater = require('./updater.cjs');

// ---------- CLI args ----------
function parseArgv() {
  const argv = process.argv;
  let workspaceId = null;
  let smoke = false;
  let openRepoPath = null;
  let watch = false;
  let screenshotPath = null;
  let restarted = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) { workspaceId = argv[i + 1]; i++; }
    else if (argv[i].startsWith('--workspace=')) { workspaceId = argv[i].slice('--workspace='.length); }
    else if (argv[i] === '--smoke') { smoke = true; }
    else if (argv[i] === '--open-repo' && argv[i + 1]) { openRepoPath = argv[i + 1]; i++; }
    else if (argv[i].startsWith('--open-repo=')) { openRepoPath = argv[i].slice('--open-repo='.length); }
    else if (argv[i] === '--watch') { watch = true; }
    else if (argv[i].startsWith('--screenshot=')) { screenshotPath = argv[i].slice('--screenshot='.length); }
    else if (argv[i] === '--restarted') { restarted = true; }
  }
  return { workspaceId, smoke, openRepoPath, watch, screenshotPath, restarted };
}
const { workspaceId, smoke, openRepoPath, watch, screenshotPath, restarted } = parseArgv();
if (watch) process.env.VIBESPACE_WATCH = '1'; // opt-in dev hot reload (children inherit)

if (smoke) {
  process.env.VIBESPACE_HOME = path.join(require('node:os').tmpdir(), `vibespace-smoke-${Date.now()}`);
}

logger.init(workspaceId || 'launcher');
logger.teeConsole();

// ---------- per-workspace identity (must happen before app is ready) ----------
if (workspaceId) {
  app.setPath('userData', path.join(U.dataRoot(), 'instances', workspaceId));
  app.setAppUserModelId(shortcuts.aumidFor(workspaceId));
} else {
  app.setAppUserModelId('vibespace.app');
}

// Register the renderer protocol before ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// terminals and code panes don't need the GPU; software compositing is far more
// stable on remote-display setups (RDP / viewer software blanking the window)
app.disableHardwareAcceleration();

const gotLock = openRepoPath ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    }
  });
}

// ---------- window registry ----------
const winInfo = new Map(); // BrowserWindow.id -> { wsId }
const rendererState = new Map(); // wsId -> last state pushed by the renderer

function workspaceWindowsFor(wsId) {
  return [...winInfo.entries()]
    .filter(([, info]) => info.wsId === wsId)
    .map(([id]) => BrowserWindow.fromId(id))
    .filter(Boolean);
}

// ---------- new-VibeSpace-code detection (dev runs only) ----------
// Baseline fingerprint at boot; re-probed every 30 s. A mismatch means the source
// tree changed under a running window (agent edits, editor saves) — the window
// shows a ↻ restart button. Packaged builds skip this: asar never changes.
let srcBaseline = null;
let srcNotified = false;
let srcProbing = false;

function probeSrc() {
  if (app.isPackaged || srcProbing || !winInfo.size) return;
  srcProbing = true;
  setImmediate(() => {
    try {
      const fp = srcstate.fingerprint(U.ROOT);
      if (srcBaseline === null) srcBaseline = fp;
      else if (fp !== srcBaseline && !srcNotified) {
        srcNotified = true;
        logger.info(`vibespace source changed on disk (${srcBaseline} -> ${fp}) — restart available`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('app:updateAvailable', true);
        }
      }
    } catch {}
    srcProbing = false;
  });
}

// ---------- agent status supervision (RESEARCH-USER-PAIN shortlist #1-#3) ----------
// claude hooks are injected via `claude --settings <file>`; they append
// working|waiting|done to $VIBESPACE_TERM_STATUS, which ptyhost sets per terminal.
// main watches those files → tab status lights, unread markers, native toast with
// click-to-focus, and a taskbar overlay badge.
function ensureHookSettings(wsId) {
  const file = path.join(U.dataRoot(), 'instances', wsId, 'claude-hook-settings.json');
  // timeout 10s: UserPromptSubmit hooks BLOCK the prompt until they finish, and a
  // cold Git Bash start under load once took ~30s (Claude's default cap) —
  // delaying the user's message. Worst case now: one status update skipped.
  const hook = (s) => ({ hooks: [{ type: 'command', command: `echo ${s} >> "$VIBESPACE_TERM_STATUS"`, timeout: 10 }] });
  const settings = {
    hooks: {
      UserPromptSubmit: [hook('working')],
      PreToolUse: [hook('working')],
      // red ("waiting") only when claude actually demands input — permission,
      // question, choice. The idle "waiting for your input" nudge arrives on
      // stdin as JSON; grep drops it so finished agents stay green (done).
      // Anything unparseable/empty fails toward the old always-red behavior.
      Notification: [{
        hooks: [{
          type: 'command',
          command: `grep -qi 'waiting for your input' || echo waiting >> "$VIBESPACE_TERM_STATUS"`,
        }],
      }],
      Stop: [hook('done')],
    },
  };
  try {
    U.ensureDir(path.dirname(file));
    U.writeJsonAtomic(file, settings);
  } catch (e) {
    logger.warn('hook settings write failed: ' + e.message);
    return null;
  }
  return file;
}

const overlayIcons = {}; // status -> png path (built lazily with sharp)
async function ensureOverlayIcons() {
  const dir = path.join(U.dataRoot(), 'icons');
  const colors = { waiting: '#f85149', done: '#3fb950' };
  for (const [st, color] of Object.entries(colors)) {
    const file = path.join(dir, `status-${st}.png`);
    overlayIcons[st] = file;
    if (fs.existsSync(file)) continue;
    try {
      const sharp = require('sharp');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="#0d1117" stroke-width="2"/></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(file);
    } catch (e) {
      logger.warn(`overlay icon build failed: ${e.message}`);
    }
  }
}

const termStatus = new Map(); // termId -> last hook-reported status (working|waiting|done)

function termName(wsId, termId) {
  const terms = rendererState.get(wsId)?.terminals;
  const t = Array.isArray(terms) ? terms.find(x => x.termId === termId) : null;
  return (t && t.name) || termId;
}

function notifyAttention(wsId, termId, st) {
  if (st !== 'waiting' && st !== 'done') return;
  const wins = workspaceWindowsFor(wsId);
  if (!wins.length) return;
  // only skip when you're literally looking at THIS agent: focused window AND its
  // tab active. A different tab finishing in the window you're in still toasts.
  const activeTerm = rendererState.get(wsId)?.activeTerm;
  if (wins.some(w => w.isFocused()) && activeTerm === termId) return;
  const ws = workspaces.get(wsId);
  const agent = termName(wsId, termId);
  const title = `${(ws && ws.name) || 'VibeSpace'} · ${agent}`;
  const body = st === 'waiting' ? `${agent} needs your input` : `${agent} finished its turn`;
  try {
    const n = new Notification({ title, body, icon: ws && ws.iconPath && fs.existsSync(ws.iconPath) ? ws.iconPath : undefined });
    n.on('click', () => {
      for (const w of workspaceWindowsFor(wsId)) {
        if (!w.isDestroyed()) { w.show(); w.focus(); w.webContents.send('term:focus', termId); }
      }
    });
    n.show();
  } catch {}
  const icon = overlayIcons[st];
  if (icon && fs.existsSync(icon)) {
    for (const w of wins) { if (!w.isDestroyed()) { try { w.setOverlayIcon(icon, st); } catch {} } }
  }
}

// ---------- state persistence (enriched with tracked session ids) ----------
function stateFile(wsId) {
  return path.join(U.dataRoot(), 'instances', wsId, 'state.json');
}

function loadState(wsId) {
  return U.readJson(stateFile(wsId), {});
}

function persistState(wsId) {
  const state = rendererState.get(wsId);
  if (!state) return;
  const enriched = { ...state };
  if (Array.isArray(enriched.terminals)) {
    enriched.terminals = enriched.terminals.map(t => ({
      ...t,
      claudeSessionId: sessions.getSession(wsId, t.termId) || t.claudeSessionId || null,
    }));
  }
  try {
    U.ensureDir(path.dirname(stateFile(wsId)));
    U.writeJsonAtomic(stateFile(wsId), enriched);
  } catch (e) {
    console.error('[vibespace] state save failed:', e.message);
  }
}

// ---------- protocol ----------
function initProtocol() {
  const ROOT = U.ROOT;
  protocol.handle('app', async (request) => {
    const u = new URL(request.url);
    if (u.host !== 'local') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let full;
    if (rel.startsWith('vendor/')) full = path.join(ROOT, 'node_modules', rel.slice('vendor/'.length));
    else if (rel.startsWith('workspace/') || rel.startsWith('launcher/')) full = path.join(ROOT, 'renderer', rel);
    else if (rel.startsWith('assets/')) full = path.join(ROOT, rel);
    else if (rel.startsWith('icons/')) full = path.join(U.dataRoot(), rel);
    else return new Response('not found', { status: 404 });

    full = path.normalize(full);
    const roots = [
      path.normalize(path.join(ROOT, 'node_modules')),
      path.normalize(path.join(ROOT, 'renderer')),
      path.normalize(ROOT),
      path.normalize(path.join(U.dataRoot(), 'icons')),
    ];
    if (!roots.some(r => full.toLowerCase().startsWith(r.toLowerCase()))) {
      return new Response('forbidden', { status: 403 });
    }
    // serve directly from disk with no-store: net.fetch(file://…) caches
    // aggressively and hot reloads were serving stale bundles
    const MIME = {
      '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
      '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
      '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain',
    };
    try {
      const data = await fs.promises.readFile(full);
      const ext = path.extname(full).toLowerCase();
      return new Response(data, {
        headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// ---------- windows ----------
function securePrefs(preload) {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
  };
}

function harden(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => { if (e.url.startsWith('http')) { e.preventDefault(); shell.openExternal(e.url); } });
}

function createLauncherWindow() {
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 660,
    minHeight: 520,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    icon: path.join(U.ROOT, 'assets', 'app.ico'),
    webPreferences: securePrefs(path.join(U.ROOT, 'preload', 'launcher.cjs')),
  });
  harden(win);
  win.loadURL('app://local/launcher/index.html');
  return win;
}

// Pinning a RUNNING window whose AppID has no matching Start Menu shortcut makes
// Windows invent a junk "Electron.lnk" (bare electron.exe, no args, no icon) —
// the pin then shows the Electron logo and relaunches nothing useful. Three layers:
//  1. setAppDetails: the window itself carries its name, icon and relaunch command,
//     so pinning it directly produces a correct pin.
//  2. ensure the workspace's Start Menu shortcut exists (AppID -> name + icon).
//  3. delete junk Electron.lnk strays pointing at our exe with no arguments.
function workspaceLaunchSpec(ws) {
  const isDev = !app.isPackaged;
  return {
    targetPath: process.execPath,
    targetArgs: isDev ? `"${U.ROOT}" --workspace=${ws.id}` : `--workspace=${ws.id}`,
    workingDir: isDev ? U.ROOT : path.dirname(process.execPath),
  };
}

function claimTaskbarIdentity(win, ws) {
  const spec = workspaceLaunchSpec(ws);
  try {
    win.setAppDetails({
      appId: shortcuts.aumidFor(ws.id),
      appIconPath: ws.iconPath,
      appIconIndex: 0,
      relaunchCommand: `"${spec.targetPath}" ${spec.targetArgs}`,
      relaunchDisplayName: ws.name,
    });
  } catch (e) {
    logger.warn('setAppDetails failed: ' + e.message);
  }
  if (smoke || screenshotPath) return; // docs/test runs never touch the Start Menu
  setTimeout(async () => {
    try {
      const created = await shortcuts.ensureStartMenu({ workspace: ws, ...spec });
      if (created) logger.info(`start-menu shortcut created for ${ws.name} (taskbar identity)`);
      const removed = shortcuts.removeJunkElectronLinks(process.execPath);
      if (removed.length) logger.info(`removed junk Electron shortcuts: ${removed.join(', ')}`);
    } catch (e) {
      logger.warn('taskbar identity upkeep failed: ' + e.message);
    }
  }, 1500);
}

// ---------- window geometry memory ----------
// Per-workspace bounds + maximized state (instances/<id>/window.json), so reopening
// — and especially ↻ Restart, which relaunches the process — doesn't reset the
// window to a default-sized box somewhere behind everything.
function windowStateFile(wsId) {
  return path.join(U.dataRoot(), 'instances', wsId, 'window.json');
}

function loadWindowState(wsId) {
  const s = U.readJson(windowStateFile(wsId), null);
  if (!s || !s.bounds) return null;
  // ignore bounds that are no longer on any connected display (monitor unplugged)
  const b = s.bounds;
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y + 40;
  });
  return visible ? s : { maximized: s.maximized };
}

function saveWindowState(win) {
  const info = winInfo.get(win.id);
  if (!info || win.isDestroyed() || win.isMinimized()) return;
  try {
    U.ensureDir(path.dirname(windowStateFile(info.wsId)));
    U.writeJsonAtomic(windowStateFile(info.wsId), { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  } catch {}
}

// Bring a (re)launched window to the front. Windows' focus-stealing rules can
// leave a relaunched process behind the previous foreground window; the brief
// always-on-top toggle is the standard reliable nudge.
function bringToFront(win) {
  if (win.isDestroyed()) return;
  win.show();
  win.moveTop();
  win.focus();
  if (!win.isFocused()) {
    win.setAlwaysOnTop(true);
    win.focus();
    setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 400);
  }
}

function createWorkspaceWindow(ws, { shot = false } = {}) {
  const saved = shot ? null : loadWindowState(ws.id);
  const b = saved && saved.bounds;
  const win = new BrowserWindow({
    width: b ? b.width : 1480,
    height: b ? b.height : 940,
    ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: 1020,
    minHeight: 640,
    show: false, // shown on ready-to-show: no white flash, and we control max/focus
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    icon: ws.iconPath,
    title: ws.name,
    webPreferences: securePrefs(path.join(U.ROOT, 'preload', 'workspace.cjs')),
  });
  harden(win);
  winInfo.set(win.id, { wsId: ws.id });
  win.once('ready-to-show', () => {
    if (shot) return; // screenshot mode shows the window itself
    // after ↻ Restart: always maximized + focused (Valentin, 2026-09-29);
    // otherwise restore the remembered maximized state
    if (restarted || (saved && saved.maximized)) win.maximize();
    if (restarted) bringToFront(win);
    else win.show();
    logger.info(`window shown: maximized=${win.isMaximized()} focused=${win.isFocused()} restarted=${restarted}`);
  });
  let geomTimer = null;
  const saveSoon = () => { clearTimeout(geomTimer); geomTimer = setTimeout(() => saveWindowState(win), 500); };
  for (const evn of ['resize', 'move', 'maximize', 'unmaximize']) win.on(evn, saveSoon);
  win.on('close', () => saveWindowState(win));
  logger.info(`workspace window opened: ${ws.name} (${ws.id}) repo=${ws.repoPath}`);
  probeSrc(); // baseline = the code this window is actually running (dev only)
  claimTaskbarIdentity(win, ws);

  // renderer console warnings/errors go to the log too
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.args?.level;
    const message = e.message ?? e.args?.message;
    const source = e.sourceId ?? e.args?.source;
    const line = e.line ?? e.args?.line;
    if (level >= 2) logger.warn(`renderer: ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logger.error(`did-fail-load ${url} → ${code} ${desc}`);
  });

  win.loadURL(`app://local/workspace/index.html?id=${encodeURIComponent(ws.id)}${shot ? '&shot=1' : ''}`);
  sessions.start(ws.id, ws.repoPath);
  status.start(ws.id, path.join(U.dataRoot(), 'instances', ws.id, 'status'));
  treewatch.start(ws.id, ws.repoPath); // live file-tree refresh (agents write files)
  baselineClaudeFor(ws.id); // update-button baseline: the version these agents run

  // focusing the window answers the attention signal — clear the taskbar badge
  win.on('focus', () => { try { win.setOverlayIcon(null, ''); } catch {} });

  // if the renderer dies, bring it back WITHOUT killing the ptys — the reloaded
  // renderer re-attaches to the still-live agents (Layer 2)
  win.webContents.on('render-process-gone', (e, details) => {
    logger.error(`renderer gone (${details.reason}) — reloading (ptys preserved)`);
    if (!win.isDestroyed()) win.webContents.reload();
  });

  win.on('close', () => persistState(ws.id));
  win.on('closed', () => {
    winInfo.delete(win.id);
    sessions.stop(ws.id);
    status.stop(ws.id);
    treewatch.stop(ws.id);
    claudeBaselines.delete(ws.id);
    if (!workspaceWindowsFor(ws.id).length) {
      persistState(ws.id);
      ptyhost.killAll(); // MVP: one workspace window per process
    }
  });
  return win;
}

// ---------- launcher: spawn a separate process per workspace ----------
function launchWorkspaceProcess(wsId) {
  const isDev = !app.isPackaged;
  const args = isDev ? [U.ROOT, `--workspace=${wsId}`] : [`--workspace=${wsId}`];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: isDev ? U.ROOT : path.dirname(process.execPath),
    env: process.env,
  });
  child.unref();
}

// ---------- updater flow ----------
// Claude Code auto-updates in the background; the ⟳ button's job is the clean
// RESTART of all agents onto the new version (conversations resumed). It is only
// shown when the on-disk version differs from what a window's agents were started
// on (baseline captured at window open, disk re-probed every 5 min).
let updating = false;
let diskClaudeVersion = null; // last seen `claude --version` (fresh spawn = disk)
const claudeBaselines = new Map(); // wsId -> version its agents were started on

function pushUpdaterState(wsId) {
  const base = claudeBaselines.get(wsId);
  const available = Boolean(base && diskClaudeVersion && updater._versionChanged(base, diskClaudeVersion));
  for (const win of workspaceWindowsFor(wsId)) {
    if (!win.isDestroyed()) win.webContents.send('updater:state', { available, diskVersion: diskClaudeVersion, baseline: base || null });
  }
}

async function probeClaudeVersion() {
  const v = await updater.claudeVersion();
  if (!v) return;
  if (diskClaudeVersion && updater._versionChanged(diskClaudeVersion, v)) {
    logger.info(`claude auto-updated on disk: ${diskClaudeVersion} -> ${v}`);
  }
  diskClaudeVersion = v;
  for (const wsId of claudeBaselines.keys()) pushUpdaterState(wsId);
}

async function baselineClaudeFor(wsId) {
  if (!diskClaudeVersion) await probeClaudeVersion();
  claudeBaselines.set(wsId, diskClaudeVersion);
  pushUpdaterState(wsId);
}

ipcMain.handle('updater:restartAll', async (event, wsId) => {
  const wins = workspaceWindowsFor(wsId);
  if (updating) return { ok: false, error: 'update already running' };
  updating = true;
  const send = (channel, payload) => { for (const w of wins) { if (!w.isDestroyed()) w.webContents.send(channel, payload); } };

  try {
    send('updater:stage', 'stopping-agents');
    send('updater:line', '[vibespace] closing all agent terminals…');
    logger.info('update-restart: stopping all agents');
    ptyhost.killAll();
    await new Promise(r => setTimeout(r, 800));
    send('updater:stage', 'updating');
    const code = await updater.runClaudeUpdate(line => { send('updater:line', line); logger.info('[claude update] ' + line); });
    logger.info(`update-restart: claude update exit code ${code}`);
    send('updater:line', `[vibespace] claude update exited with code ${code}`);
    send('updater:stage', 'relaunching');
    send('updater:done', { code });
    // agents respawn on the new version moments after `done` — re-baseline so the
    // button hides again, then confirm with a fresh probe
    setTimeout(async () => {
      await probeClaudeVersion();
      for (const id of claudeBaselines.keys()) claudeBaselines.set(id, diskClaudeVersion);
      for (const id of claudeBaselines.keys()) pushUpdaterState(id);
    }, 5000);
    return { ok: code === 0 };
  } catch (e) {
    send('updater:done', { code: -1, error: String(e) });
    return { ok: false, error: String(e) };
  } finally {
    updating = false;
  }
});

// ---------- IPC ----------
function initIpc() {
  // launcher
  ipcMain.handle('launcher:list', () => workspaces.list());
  ipcMain.handle('launcher:create', async (e, { name, repoPath, logoPath }) => {
    if (!repoPath || !fs.existsSync(repoPath)) throw new Error('Repository folder does not exist');
    return workspaces.create({ name: name || path.basename(repoPath), repoPath, logoPath });
  });
  ipcMain.handle('launcher:remove', (e, id) => {
    const ws = workspaces.get(id);
    if (ws) shortcuts.removeShortcuts(ws);
    return workspaces.remove(id);
  });
  ipcMain.handle('dialog:pickRepo', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickLogo', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('app:openWorkspace', (e, id) => {
    if (!workspaces.get(id)) return { ok: false, error: 'unknown workspace' };
    launchWorkspaceProcess(id);
    return { ok: true };
  });

  // shortcuts
  ipcMain.handle('sc:create', async (e, id) => {
    const ws = workspaces.get(id);
    if (!ws) throw new Error('unknown workspace');
    const isDev = !app.isPackaged;
    return shortcuts.create({
      workspace: ws,
      targetPath: process.execPath,
      targetArgs: isDev ? `"${U.ROOT}" --workspace=${ws.id}` : `--workspace=${ws.id}`,
      workingDir: isDev ? U.ROOT : path.dirname(process.execPath),
    });
  });
  ipcMain.handle('sc:remove', (e, id) => {
    const ws = workspaces.get(id);
    if (ws) shortcuts.removeShortcuts(ws);
    return true;
  });
  ipcMain.handle('sc:launcherShortcut', () => {
    const isDev = !app.isPackaged;
    return shortcuts.createLauncherShortcut({
      targetPath: process.execPath,
      workingDir: isDev ? U.ROOT : path.dirname(process.execPath),
    });
  });

  // Explorer right-click menu ("Open with VibeSpace")
  ipcMain.handle('sc:contextMenu', async (e, action) => {
    const isDev = !app.isPackaged;
    const opts = { targetPath: process.execPath, rootDir: isDev ? U.ROOT : path.dirname(process.execPath) };
    if (action === 'install') return { installed: contextmenu.install(opts) };
    if (action === 'uninstall') return { installed: !contextmenu.uninstall() };
    return { installed: contextmenu.isInstalled() };
  });

  // workspace logo swap
  ipcMain.handle('ws:updateLogo', async (e, id, logoPath) => {
    const ws = await workspaces.updateLogo(id, logoPath);
    // re-write existing .lnk files + nudge the icon cache so pinned taskbar icons
    // refresh without a manual re-pin (the .ico rebuilt in place; Windows caches)
    try {
      const isDev = !app.isPackaged;
      await shortcuts.refreshIcons({
        workspace: ws,
        targetPath: process.execPath,
        targetArgs: isDev ? `"${U.ROOT}" --workspace=${ws.id}` : `--workspace=${ws.id}`,
        workingDir: isDev ? U.ROOT : path.dirname(process.execPath),
      });
    } catch (err) {
      logger.warn('shortcut refresh after logo swap failed: ' + (err && err.message ? err.message : err));
    }
    for (const win of workspaceWindowsFor(id)) {
      if (!win.isDestroyed()) {
        win.setIcon(ws.iconPath);
        claimTaskbarIdentity(win, ws); // re-announce: the shell cached the old icon at open
        // reload without killing: the renderer re-attaches to live ptys (Layer 2)
        win.reload(); // pick up the new logo in the top bar
      }
    }
    return ws;
  });

  // workspace
  ipcMain.handle('ws:get', (e, id) => workspaces.get(id));
  // one-click restart onto new code (same relaunch path devwatch uses for main/)
  ipcMain.handle('app:restart', () => {
    logger.info('app restart requested — relaunching to pick up new code');
    for (const w of BrowserWindow.getAllWindows()) saveWindowState(w);
    // --restarted: the relaunched window comes back maximized and focused
    const args = process.argv.slice(1).filter(a => a !== '--restarted');
    app.relaunch({ args: [...args, '--restarted'] });
    setTimeout(() => app.exit(0), 200);
    return true;
  });
  // "Are my agents busy?" for the restart confirm. Claude tabs trust their status
  // light (hook-reported): busy only while 'working' AND still producing output
  // (an interrupted turn can leave 'working' behind with no Stop hook). Plain
  // shells: recent OUTPUT only. Input never counts — with claude's mouse tracking
  // on, just moving the mouse toward the button sends input (the false alarm).
  ipcMain.handle('pty:busy', (e, wsId) => {
    const terms = rendererState.get(wsId)?.terminals || [];
    const names = [];
    for (const t of terms) {
      const age = ptyhost.outputAge(t.termId);
      // any tab with a hook-reported status is judged by it (also covers claude
      // typed by hand in a "+ Terminal" tab); status-less tabs by output alone
      const st = termStatus.get(t.termId);
      const busy = st ? st === 'working' && age < 15000 : age < 5000;
      if (busy) names.push(t.name || t.termId);
    }
    return { busy: names.length > 0, names };
  });
  ipcMain.handle('state:load', (e, id) => loadState(id));
  ipcMain.handle('state:save', (e, id, state) => {
    rendererState.set(id, state);
    persistState(id);
    return true;
  });

  // fs
  // The repo root of the window that sent the event — tree file ops are jailed
  // to it, so a renderer can only ever touch its own workspace's files.
  const repoFor = (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const wsId = win && winInfo.get(win.id)?.wsId;
    const ws = wsId && workspaces.get(wsId);
    return ws ? ws.repoPath : null;
  };
  ipcMain.handle('git:status', (e, repoPath) => (repoPath ? gitstatus.status(repoPath) : null));
  // Changes tab: HEAD-vs-worktree content pairs (null = no git / not a repo);
  // the requested repoPath must be the sender's own workspace (jailed)
  ipcMain.handle('git:diff', async (e, repoPath, opts) => {
    const root = repoFor(e);
    if (!root || !U.jailed(root, repoPath)) return null;
    return gitdiff.diff(root, opts);
  });
  ipcMain.handle('fs:list', (e, dir) => {
    if (!fs.existsSync(dir)) return { entries: [] };
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (U.IGNORED_NAMES.has(name)) continue;
      if (U.IGNORED_SUFFIXES.some(s => name.endsWith(s))) continue;
      const full = path.join(dir, name);
      let isDir = false;
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
      out.push({ name, path: full, dir: isDir });
    }
    out.sort((a, b) => (a.dir === b.dir) ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1));
    return { entries: out };
  });

  const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.zip', '.7z', '.gz', '.tar', '.pdf', '.mp4', '.mp3', '.wav', '.ogg', '.webm', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.psd', '.ai', '.sketch', '.db', '.sqlite', '.bin', '.wasm', '.class', '.jar', '.pyc', '.node', '.lockb']);
  const MAX_BYTES = 2 * 1024 * 1024;
  ipcMain.handle('fs:read', (e, file) => {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return { tooLarge: true, size: st.size };
    if (BIN_EXT.has(path.extname(file).toLowerCase())) return { binary: true, size: st.size };
    const buf = fs.readFileSync(file);
    for (let i = 0; i < Math.min(buf.length, 8192); i++) {
      if (buf[i] === 0) return { binary: true, size: st.size };
    }
    return { content: buf.toString('utf8'), size: st.size };
  });
  ipcMain.handle('fs:write', (e, file, content) => {
    const root = repoFor(e);
    const resolved = root && U.jailed(root, file);
    if (!resolved) throw new Error('outside workspace');
    fs.writeFileSync(resolved, content, 'utf8');
    return true;
  });
  // drag-and-drop into the tree: copy files into a folder, never overwriting.
  // Sources stay arbitrary absolute paths (that's the drag origin) — only the
  // destination folder is jailed to the workspace.
  ipcMain.handle('fs:copyInto', (e, { sources, destDir }) => {
    const dest = U.jailed(repoFor(e), destDir);
    if (!Array.isArray(sources) || !dest || !fs.existsSync(dest)) return { copied: [], error: 'bad args' };
    const copied = [];
    for (const s of sources) {
      try {
        if (typeof s === 'string' && fs.existsSync(s) && fs.statSync(s).isFile()) copied.push(U.copyIn(s, dest));
      } catch {}
    }
    return { copied };
  });
  // tree file operations: create / mkdir / rename / delete (to Recycle Bin).
  // Each busts the git-status cache so tree colors refresh right away.
  ipcMain.handle('fs:create', (e, { dirPath, fileName }) => {
    const root = repoFor(e);
    if (!root) throw new Error('no workspace');
    const res = fsops.create(root, dirPath, fileName);
    gitstatus.bust(root);
    gitdiff.bust(root);
    return res;
  });
  ipcMain.handle('fs:mkdir', (e, { dirPath, name }) => {
    const root = repoFor(e);
    if (!root) throw new Error('no workspace');
    const res = fsops.mkdir(root, dirPath, name);
    gitstatus.bust(root);
    gitdiff.bust(root);
    return res;
  });
  ipcMain.handle('fs:rename', (e, { from, to }) => {
    const root = repoFor(e);
    if (!root) throw new Error('no workspace');
    const res = fsops.rename(root, from, to);
    gitstatus.bust(root);
    gitdiff.bust(root);
    return res;
  });
  ipcMain.handle('fs:delete', async (e, { path }) => {
    const root = repoFor(e);
    if (!root) throw new Error('no workspace');
    const res = await fsops.remove(root, path);
    gitstatus.bust(root);
    gitdiff.bust(root);
    return res;
  });
  ipcMain.handle('fs:reveal', (e, file) => { shell.showItemInFolder(file); return true; });

  // Ctrl+P file finder: recursive walk honoring the same ignore rules as the tree.
  // Bounded (8000 files, depth 12) so huge repos can't stall the main process.
  const walkFiles = (dir, out, depth) => {
    if (out.length >= 8000 || depth > 12) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (U.IGNORED_NAMES.has(d.name)) continue;
      if (U.IGNORED_SUFFIXES.some(s => d.name.endsWith(s))) continue;
      if (d.isDirectory()) walkFiles(path.join(dir, d.name), out, depth + 1);
      else if (d.isFile()) out.push(path.join(dir, d.name));
    }
  };
  const fileIndexCache = new Map(); // repoPath -> { at, files }
  ipcMain.handle('fs:fileIndex', (e, repoPath) => {
    if (!repoPath || !fs.existsSync(repoPath)) return [];
    const c = fileIndexCache.get(repoPath);
    if (c && Date.now() - c.at < 5000) return c.files;
    const files = [];
    walkFiles(repoPath, files, 0);
    fileIndexCache.set(repoPath, { at: Date.now(), files });
    return files;
  });

  // ptys
  ipcMain.handle('pty:create', (e, { termId, wsId, cwd, cols, rows }) => {
    const settingsPath = ensureHookSettings(wsId);
    ptyhost.create(termId, cwd, cols, rows, wsId);
    return { settingsPath };
  });
  // live ptys + buffered output — a freshly loaded renderer uses this to re-attach
  // instead of re-spawning agents that survived its reload (Layer 2)
  ipcMain.handle('pty:list', () => {
    const live = ptyhost.list();
    if (live.length) logger.info(`pty attach candidates: ${live.map(p => p.termId).join(', ')}`);
    return live;
  });
  ipcMain.on('pty:write', (e, termId, data) => ptyhost.write(termId, data));
  ipcMain.on('pty:resize', (e, termId, cols, rows) => ptyhost.resize(termId, cols, rows));
  ipcMain.on('pty:kill', (e, termId) => ptyhost.kill(termId));
  ipcMain.on('pty:claudeStarted', (e, wsId, termId, opts) => sessions.trackClaudeStart(wsId, termId, opts || {}));
  ipcMain.on('pty:sessionPinned', (e, wsId, termId, sessionId) => sessions.pinSession(wsId, termId, sessionId));
  ipcMain.handle('sessions:check', (e, wsId, sessionId) => sessions.sessionExists(wsId, sessionId));

  // misc
  ipcMain.handle('util:claudeVersion', () => updater.claudeVersion());
  ipcMain.handle('util:openLogs', () => { shell.openPath(logger.logsDir()); return true; });
  ipcMain.handle('util:writeClipboard', (e, text) => { clipboard.writeText(String(text ?? '')); return true; });
  ipcMain.handle('util:readClipboard', () => clipboard.readText());
  ipcMain.handle('util:diagnostics', (e, wsId) => logger.diagnostics(wsId ? workspaces.get(wsId) : null));
  ipcMain.handle('util:copyDiagnostics', (e, wsId) => {
    const text = logger.diagnostics(wsId ? workspaces.get(wsId) : null);
    clipboard.writeText(text);
    return true;
  });
  const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.gif']);
  ipcMain.handle('util:imageDataUrl', (e, file) => {
    try {
      if (!IMG_EXT.has(path.extname(file).toLowerCase())) return null;
      const st = fs.statSync(file);
      if (st.size > 2 * 1024 * 1024) return null;
      const buf = fs.readFileSync(file);
      const ext = path.extname(file).slice(1).toLowerCase().replace('svg', 'svg+xml').replace('jpg', 'jpeg');
      return `data:image/${ext === 'svg+xml' ? 'svg+xml' : ext};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  // events main -> renderer
  ptyhost.onData((termId, chunk) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pty:data', termId, chunk);
    }
  });
  ptyhost.onExit((termId) => {
    termStatus.delete(termId);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pty:exit', termId);
    }
  });
  sessions.onData((wsId, termId, sessionId) => {
    logger.info(`session captured: ws=${wsId} term=${termId} session=${sessionId}`);
    for (const win of workspaceWindowsFor(wsId)) {
      if (!win.isDestroyed()) win.webContents.send('session:found', termId, sessionId);
    }
  });
  status.onData((wsId, termId, st) => {
    termStatus.set(termId, st);
    logger.info(`term status: ws=${wsId} term=${termId} ${st}`);
    for (const win of workspaceWindowsFor(wsId)) {
      if (!win.isDestroyed()) win.webContents.send('term:status', termId, st);
    }
    notifyAttention(wsId, termId, st);
  });
  treewatch.onData((wsId) => {
    logger.info(`tree changed: ws=${wsId}`);
    for (const win of workspaceWindowsFor(wsId)) {
      if (!win.isDestroyed()) win.webContents.send('tree:changed');
    }
  });
}

// periodic state save (captures session ids discovered after the last renderer push)
function initStateFlush() {
  setInterval(() => {
    for (const wsId of new Set([...winInfo.values()].map(v => v.wsId))) persistState(wsId);
  }, 10000);
  // background auto-update detection: cheap fresh `claude --version` probe
  setInterval(() => {
    if (claudeBaselines.size && !updating) probeClaudeVersion();
  }, 5 * 60 * 1000).unref?.();
  // new-VibeSpace-code detection (dev only; no-op packaged)
  probeSrc();
  setInterval(probeSrc, 30000).unref?.();
}

// ---------- boot ----------
app.whenReady().then(async () => {
  initProtocol();
  initIpc();
  initStateFlush();
  ensureOverlayIcons(); // fire-and-forget: taskbar badge icons for agent status

  // dev hot-reload: OPT-IN (--watch / VIBESPACE_WATCH=1) — normal windows never watch
  require('./devwatch.cjs').start({ app, BrowserWindow, ptyhost, logger, root: U.ROOT });

  // "Open with VibeSpace" from Explorer: ensure a workspace for the folder,
  // spawn its window as a detached process, and quit without ever showing UI
  if (openRepoPath) {
    try {
      const ws = await workspaces.findOrCreateByRepoPath(openRepoPath);
      const isDev = !app.isPackaged;
      const args = isDev ? [U.ROOT, `--workspace=${ws.id}`] : [`--workspace=${ws.id}`];
      spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: isDev ? U.ROOT : path.dirname(process.execPath), env: process.env }).unref();
      logger.info(`open-repo: ${openRepoPath} -> ${ws.id}`);
    } catch (e) {
      logger.error(`open-repo failed: ${e.message}`);
      dialog.showErrorBox('VibeSpace', `Could not open this folder as a workspace:\n${e.message}`);
    }
    setTimeout(() => app.exit(0), 400);
    return;
  }

  // ensure the launcher has an icon
  const appIco = path.join(U.ROOT, 'assets', 'app.ico');
  if (!fs.existsSync(appIco)) {
    try { await require('./ico.cjs').buildDefaultIco(appIco); } catch (e) { console.error('icon build failed:', e.message); }
  }

  if (smoke) {
    const runSmoke = require('./smoke.cjs');
    let ok = false;
    try {
      ok = await runSmoke();
    } catch (e) {
      console.error('SMOKE CRASHED:', e && e.stack ? e.stack : e);
      ok = false;
    }
    console.log('SMOKE_EXIT:' + (ok ? '0' : '1'));
    process.stdout?.write?.('');
    app.exit(ok ? 0 : 1);
    setTimeout(() => process.exit(ok ? 0 : 1), 1500).unref?.();
    return;
  }

  if (workspaceId) {
    const ws = workspaces.get(workspaceId);
    if (!ws) {
      dialog.showErrorBox('VibeSpace', `Workspace "${workspaceId}" not found. Open the launcher to create it.`);
      app.exit(1);
      return;
    }
    if (screenshotPath) {
      // Docs mode: seed a demo state, stage terminal content + status lights,
      // capture the window to PNG, exit. Used for README/screenshots:
      //   electron . --workspace=<id> --screenshot=out.png
      try {
        U.ensureDir(path.dirname(stateFile(ws.id)));
        U.writeJsonAtomic(stateFile(ws.id), {
          terminals: [
            { termId: 'demo1', name: 'agent-1', cwd: ws.repoPath, isClaude: true, claudeSessionId: null },
            { termId: 'demo2', name: 'agent-2', cwd: ws.repoPath, isClaude: true, claudeSessionId: null },
            { termId: 'demo3', name: 'agent-3', cwd: ws.repoPath, isClaude: true, claudeSessionId: null },
          ],
          autoResume: false,
          termPosition: 'right',
          treeWidth: 240,
        });
      } catch {}
      const shotWin = createWorkspaceWindow(ws, { shot: true });
      const statusDir = path.join(U.dataRoot(), 'instances', ws.id, 'status');
      const setStatus = (termId, st) => { try { fs.appendFileSync(path.join(statusDir, `${termId}.status`), st + '\n'); } catch {} };
      setTimeout(() => {
        ptyhost.write('demo1', 'git log --oneline --no-decorate -6\r');
        ptyhost.write('demo2', 'git status -s\r');
        ptyhost.write('demo3', 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\demo-claude.ps1\r');
      }, 3500);
      setTimeout(() => {
        setStatus('demo1', 'working'); // amber pulse
        setStatus('demo2', 'done');    // green
        setStatus('demo3', 'waiting'); // red pulse — the money shot
      }, 6500);
      setTimeout(async () => {
        try {
          // capturePage needs a painted, visible window (UnknownVizError otherwise)
          if (!shotWin.isDestroyed()) {
            shotWin.show();
            shotWin.focus();
          }
          let png = null;
          for (let i = 0; i < 4 && !png; i++) {
            await new Promise(r => setTimeout(r, i ? 600 : 0));
            try {
              const img = await shotWin.webContents.capturePage();
              const buf = img.toPNG();
              if (buf.length > 1000) png = buf;
            } catch {}
          }
          if (png) {
            fs.writeFileSync(screenshotPath, png);
            console.log('SCREENSHOT_SAVED: ' + screenshotPath);
          } else {
            console.error('SCREENSHOT_FAILED: capturePage never produced pixels');
          }
        } catch (e) {
          console.error('SCREENSHOT_FAILED: ' + e.message);
        }
        app.exit(0);
        setTimeout(() => process.exit(0), 400).unref?.();
      }, 10000);
      return;
    }
    createWorkspaceWindow(ws);
  } else {
    createLauncherWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (workspaceId) {
        const ws = workspaces.get(workspaceId);
        if (ws) createWorkspaceWindow(ws);
      } else {
        createLauncherWindow();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const wsId of new Set([...winInfo.values()].map(v => v.wsId))) persistState(wsId);
  ptyhost.killAll();
});
