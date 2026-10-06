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
// a JSON file (state/workspaces/…) that a crash or reboot left unreadable must
// never be swallowed silently — that cost a conversation + layout on 2026-10-01
U.onCorruptJson((msg) => logger.warn(`json: ${msg}`));
const workspaces = require('./workspaces.cjs');
const shortcuts = require('./shortcuts.cjs');
const contextmenu = require('./contextmenu.cjs');
const ptyhost = require('./ptyhost.cjs');
const sessions = require('./sessions.cjs');
const tablog = require('./tablog.cjs');
const lagmon = require('./lagmon.cjs');
const logoscan = require('./logoscan.cjs');
const notifyprefs = require('./notifyprefs.cjs');
const status = require('./status.cjs');
const gitstatus = require('./gitstatus.cjs');
const gitdiff = require('./gitdiff.cjs');
const githistory = require('./githistory.cjs');
const worktrees = require('./worktrees.cjs');
const fsops = require('./fsops.cjs');
const srcstate = require('./srcstate.cjs');
const treewatch = require('./treewatch.cjs');
const updater = require('./updater.cjs');
const claudefeed = require('./claudefeed.cjs');
const board = require('./board.cjs');
const attention = require('./attention.cjs');
const bgagents = require('./bgagents.cjs');
const presence = require('./presence.cjs');
const accounts = require('./accounts.cjs');

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

// --smoke shares the launcher's default userData, so it must not compete for (or
// be blocked by) a running launcher's lock — whenReady bails out without it
const gotLock = (openRepoPath || smoke) ? true : app.requestSingleInstanceLock();
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
  // With the claude data feed listening, main writes the status words itself
  // from the feed's HTTP hooks (status.wordForHook, wired next to claudefeed.onData) — no Git Bash spawn per
  // prompt/tool. Those command hooks BLOCK claude: under load a cold bash start
  // took >10 s and held Valentin's prompt ("hook timed out after 10s",
  // 2026-09-29). The Git Bash hooks remain only as the no-feed fallback.
  const settings = claudefeed.port() ? { hooks: {} } : {
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
          timeout: 10,
        }],
      }],
      Stop: [hook('done')],
    },
  };
  // claude data feed: statusLine + HTTP hooks on top (claudefeed.cjs); the port
  // changes every main start and this runs per pty create, so it is always live
  claudefeed.addSettings(settings);
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
const termAccount = new Map(); // termId -> account id its claude runs on (renderer sets it before launch)
const switchLog = new Map(); // termId -> [ms] of automatic account switches (loop guard)
const accountSince = new Map(); // termId -> ms its current account was set (older evidence belongs to the previous one)
const attnTerms = new Map(); // termId -> attention.cjs arbitration state (file vs instant feed)

function termName(wsId, termId) {
  const terms = rendererState.get(wsId)?.terminals;
  const t = Array.isArray(terms) ? terms.find(x => x.termId === termId) : null;
  return (t && t.name) || termId;
}

// agent board summary for other windows (main/board.cjs): renderer tab list +
// base status + feed detail, all read from where they already live
function boardSummary(wsId) {
  const ws = workspaces.get(wsId);
  return board.buildSummary({
    wsId,
    name: ws && ws.name,
    terminals: rendererState.get(wsId)?.terminals || [],
    statusOf: (termId) => termStatus.get(termId),
    feedOf: (termId) => claudefeed.stateOf(termId),
    reasonOf: claudefeed.attentionText,
  });
}

// st: working|waiting|done from the status files, or 'failed' from the claude feed
// (StopFailure fires no Stop hook, so the base light would never say so)
function notifyAttention(wsId, termId, st) {
  if (st !== 'waiting' && st !== 'done' && st !== 'failed') return;
  const wins = workspaceWindowsFor(wsId);
  if (!wins.length) return;
  // only skip when you're literally looking at THIS agent: focused window AND its
  // tab active. A different tab finishing in the window you're in still toasts.
  const activeTerm = rendererState.get(wsId)?.activeTerm;
  if (wins.some(w => w.isFocused()) && activeTerm === termId) return;
  const ws = workspaces.get(wsId);
  const agent = termName(wsId, termId);
  const title = `${(ws && ws.name) || 'VibeSpace'} · ${agent}`;
  // the feed's reason when it has one ("agent-2 needs permission: Bash — npm test");
  // pre-feed agents keep the generic text
  const reason = claudefeed.attentionText(claudefeed.stateOf(termId));
  const body = st === 'failed' ? `${agent} ${reason || 'turn failed'}`
    : st === 'waiting' ? `${agent} ${reason || 'needs your input'}`
    : `${agent} finished its turn`;
  // the toast is a user choice per event kind (⚙ Preferences → Notifications,
  // machine-wide); the taskbar badge below always shows
  if (notifyprefs.shouldToast(st)) {
    try {
      const n = new Notification({ title, body, icon: ws && ws.iconPath && fs.existsSync(ws.iconPath) ? ws.iconPath : undefined });
      n.on('click', () => {
        for (const w of workspaceWindowsFor(wsId)) {
          if (!w.isDestroyed()) { w.show(); w.focus(); w.webContents.send('term:focus', termId); }
        }
      });
      n.show();
    } catch {}
  } else {
    logger.info(`toast skipped (notifications: ${st} off): ws=${wsId} term=${termId}`);
  }
  const icon = overlayIcons[st === 'failed' ? 'waiting' : st]; // a failed turn needs you too: red badge
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

const lastStateJson = new Map(); // wsId -> last JSON written (skip identical writes)
const knownParked = new Map(); // wsId -> last parked list saved (a snapshot without `parked` keeps it)
let stateFrozen = false; // set on session-end / before-quit: the final save already happened

function persistState(wsId) {
  if (stateFrozen) return;
  const state = rendererState.get(wsId);
  if (!state) return;
  if (!knownParked.has(wsId)) knownParked.set(wsId, loadState(wsId).parked || null);
  const enriched = sessions.enrichState(wsId, state, knownParked.get(wsId));
  knownParked.set(wsId, enriched.parked);
  // the renderer pushes every ~5 s; only touch the disk when something changed —
  // fewer writes = fewer chances for a reboot to catch one mid-flight
  const json = JSON.stringify(enriched);
  if (lastStateJson.get(wsId) !== json) {
    try {
      U.ensureDir(path.dirname(stateFile(wsId)));
      U.writeJsonAtomic(stateFile(wsId), enriched);
      lastStateJson.set(wsId, json);
    } catch (e) {
      logger.warn(`state save failed: ws=${wsId} ${e.message}`);
    }
  }
  // audit trail: which tab holds which conversation, and tabs that look like
  // agents but would NOT resume on restart (main/tablog.cjs)
  try {
    for (const l of tablog.diff(wsId, enriched.terminals, Date.now(), enriched.parked)) logger.info(`tabs: ws=${wsId} ${l}`);
    const opts = { hasFeed: (id) => Boolean(claudefeed.stateOf(id)), alive: (id) => ptyhost.alive(id) };
    for (const l of tablog.audit(wsId, enriched.terminals, opts)) logger.warn(`tabs: ws=${wsId} ${l}`);
  } catch (e) {
    logger.warn('tab log failed: ' + e.message);
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

// The taskbar reads a window's icon ONCE, when it creates the window's button,
// and caches it by file path. A logo change therefore needs both a new icon
// path (workspaces.updateLogo) and a new button. Moving the window to a
// throwaway AppID and back makes the taskbar build one, with no visible blink.
// Verified live 2026-10-04 (taskbar screenshots): setAppDetails with the new
// path alone, setSkipTaskbar off/on, SHCNE_UPDATEITEM and SHCNE_ASSOCCHANGED
// all left the old icon; this and hide()/show() refreshed it.
function rebuildTaskbarButton(win, ws) {
  try {
    win.setAppDetails({ appId: shortcuts.aumidFor(ws.id) + '.refresh' });
  } catch (e) {
    logger.warn('taskbar button rebuild failed: ' + e.message);
  }
  setTimeout(() => { if (!win.isDestroyed()) claimTaskbarIdentity(win, ws); }, 300);
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
    // Electron 35+ reports level as a string; the old numeric form is 2=warning, 3=error
    if (level >= 2 || level === 'warning' || level === 'error') logger.warn(`renderer: ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logger.error(`did-fail-load ${url} → ${code} ${desc}`);
  });

  win.loadURL(`app://local/workspace/index.html?id=${encodeURIComponent(ws.id)}${shot ? '&shot=1' : ''}`);
  sessions.start(ws.id, ws.repoPath);
  status.start(ws.id, path.join(U.dataRoot(), 'instances', ws.id, 'status'));
  treewatch.start(ws.id, ws.repoPath); // live file-tree refresh (agents write files)
  board.start(ws.id, () => boardSummary(ws.id)); // other windows' boards read this
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
    tablog.forget(ws.id);
    status.stop(ws.id);
    treewatch.stop(ws.id);
    board.stop(ws.id); // deletes <dataRoot>/board/<wsId>.json
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
// Claude Code auto-updates itself in the background, so a newer version is
// already ON DISK when we notice it. A window's agents keep running the version
// they started on (baseline captured at window open, disk re-probed every 5 min).
// When they differ, `updater:state` lights the single ↻ Restart button: the
// restart relaunches every agent, and new processes start on the new version.
// (The old ⟳ flow also ran `claude update` — redundant, removed in 0.6.32.)
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
    // a workspace window starts in its own repo (the logo usually lives there);
    // the launcher has no repo, so Windows picks the folder as before
    const root = repoFor(e);
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp'] }],
      ...(root ? { defaultPath: root } : {}),
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // images in the sender's repo that could be its logo, best guess first (logoscan.cjs)
  ipcMain.handle('logo:candidates', async (e) => {
    const root = repoFor(e);
    if (!root) return [];
    const t0 = Date.now();
    const list = await logoscan.scan(root);
    logger.info(`logo scan: ${list.length} candidates in ${Date.now() - t0} ms`);
    return list.map(({ path: file, rel, w, h, thumb }) => ({ path: file, rel, w, h, thumb }));
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
        rebuildTaskbarButton(win, ws); // the taskbar cached the old icon when the button was made
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
      // typed by hand in a plain terminal tab); status-less tabs by output alone
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
    board.touch(id); // tab names / new or closed tabs
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
  // the requested repoPath must BE the sender's own workspace root. (U.jailed
  // is strictly-inside, so it rejected the root itself and the tab always said
  // "Not a git repository" — found 2026-09-29.)
  ipcMain.handle('git:diff', async (e, repoPath, opts) => {
    const root = repoFor(e);
    if (!root || typeof repoPath !== 'string' || path.resolve(repoPath).toLowerCase() !== path.resolve(root).toLowerCase()) return null;
    return gitdiff.diff(root, opts);
  });
  // History tab + branch chip — always the sender's own repo (no renderer path)
  const SHA = /^[0-9a-f]{4,64}$/i;
  ipcMain.handle('git:log', (e, opts) => {
    const root = repoFor(e);
    if (!root) return null;
    const o = opts || {};
    return githistory.log(root, {
      skip: o.skip, limit: o.limit, all: Boolean(o.all),
      query: typeof o.query === 'string' ? o.query.slice(0, 200) : '',
      path: typeof o.path === 'string' ? o.path.replace(/\\/g, '/') : '',
      follow: Boolean(o.follow),
    });
  });
  ipcMain.handle('git:commit', (e, sha) => {
    const root = repoFor(e);
    return root && SHA.test(String(sha)) ? githistory.commit(root, sha) : null;
  });
  ipcMain.handle('git:commitFileDiff', (e, sha, file) => {
    const root = repoFor(e);
    if (!root || !SHA.test(String(sha)) || !file || typeof file.rel !== 'string') return null;
    return githistory.commitFileDiff(root, sha, {
      status: String(file.status || 'M'), rel: file.rel,
      from: typeof file.from === 'string' ? file.from : undefined,
    });
  });
  ipcMain.handle('git:branch', (e) => {
    const root = repoFor(e);
    return root ? githistory.branch(root) : null;
  });
  ipcMain.handle('fs:list', (e, dir) => {
    if (!fs.existsSync(dir)) return { entries: [] };
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (U.IGNORED_NAMES.has(name)) continue;
      if (U.IGNORED_SUFFIXES.some(s => name.endsWith(s))) continue;
      if (U.isAgentWorktrees(path.basename(dir), name)) continue;
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
  // path.normalize: the tree builds 'D:\repo/sub/file' and Explorer wants backslashes
  ipcMain.handle('fs:reveal', (e, file) => { shell.showItemInFolder(path.normalize(file)); return true; });
  // Open a folder itself in Explorer. Jailed to the workspace (root included) and
  // folders only: shell.openPath on a file would RUN it.
  ipcMain.handle('fs:openFolder', async (e, dir) => {
    const root = repoFor(e);
    if (!root) throw new Error('no workspace');
    const r = path.resolve(dir);
    const inside = r.toLowerCase() === path.resolve(root).toLowerCase() || U.jailed(root, r);
    if (!inside || !fs.statSync(r).isDirectory()) throw new Error('not a workspace folder');
    const err = await shell.openPath(r);
    if (err) throw new Error(err);
    return true;
  });

  // Ctrl+P file finder: recursive walk honoring the same ignore rules as the tree.
  // Bounded (8000 files, depth 12) so huge repos can't stall the main process.
  const walkFiles = (dir, out, depth) => {
    if (out.length >= 8000 || depth > 12) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (U.IGNORED_NAMES.has(d.name)) continue;
      if (U.IGNORED_SUFFIXES.some(s => d.name.endsWith(s))) continue;
      if (U.isAgentWorktrees(path.basename(dir), d.name)) continue;
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
  ipcMain.handle('pty:create', (e, { termId, wsId, cwd, cols, rows, rcLabel }) => {
    const settingsPath = ensureHookSettings(wsId);
    ptyhost.create(termId, cwd, cols, rows, wsId, { settingsPath, rcLabel: typeof rcLabel === 'string' ? rcLabel : null });
    return { settingsPath };
  });
  // live ptys + buffered output — a freshly loaded renderer uses this to re-attach
  // instead of re-spawning agents that survived its reload (Layer 2)
  ipcMain.handle('pty:list', () => {
    const live = ptyhost.list();
    if (live.length) logger.info(`pty attach candidates: ${live.map(p => p.termId).join(', ')}`);
    return live;
  });
  ipcMain.on('pty:write', (e, termId, data) => { lagmon.noteInput(termId, data); ptyhost.write(termId, data); });
  // typing-lag evidence from the renderer (key→screen, blocked renderer); see lagmon.cjs
  ipcMain.on('diag:lag', (e, r) => { const line = lagmon.report(r); if (line) logger.warn(line); });
  ipcMain.on('pty:resize', (e, termId, cols, rows) => ptyhost.resize(termId, cols, rows));
  ipcMain.on('pty:kill', (e, termId) => ptyhost.kill(termId));
  ipcMain.on('pty:claudeStarted', (e, wsId, termId, opts) => {
    logger.info(`claude launch: ws=${wsId} term=${termId}${opts && opts.picker ? ' (resume picker)' : ''}`);
    sessions.trackClaudeStart(wsId, termId, opts || {});
  });
  ipcMain.on('pty:sessionPinned', (e, wsId, termId, sessionId) => {
    logger.info(`claude resume: ws=${wsId} term=${termId} session=${sessionId}`);
    sessions.pinSession(wsId, termId, sessionId);
  });
  // feed state for a (re)loaded renderer: meters show at once after a reload
  ipcMain.handle('feed:snapshot', (e, wsId) => claudefeed.snapshot(wsId));
  // agent board: other workspaces' summaries (read-only), a dir watch while a
  // board is open, and focus-a-workspace. Focusing reuses the launcher path:
  // spawning --workspace=<id> of a RUNNING workspace loses its single-instance
  // lock and quits at once; the running process gets 'second-instance' → focus.
  ipcMain.handle('board:others', (e, wsId) => board.readOthers(wsId));
  // background agents (claude --bg) started under this workspace's repo; the
  // board polls this every 15 s while open — never otherwise
  ipcMain.handle('bg:list', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const ws = win && workspaces.get(winInfo.get(win.id)?.wsId);
    return ws ? bgagents.list(ws.repoPath) : { ok: false, agents: [] };
  });
  ipcMain.on('board:watch', (e, on) => {
    const sender = e.sender;
    if (!on) { board.unwatch(); return; }
    board.watch(() => { if (!sender.isDestroyed()) sender.send('board:changed'); });
    sender.once('destroyed', () => board.unwatch());
  });
  ipcMain.handle('board:focus', (e, wsId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const self = win && winInfo.get(win.id)?.wsId;
    if (!wsId || wsId === self || !workspaces.get(wsId)) return { ok: false };
    launchWorkspaceProcess(wsId);
    return { ok: true };
  });
  ipcMain.handle('sessions:check', (e, wsId, sessionId, cwd) => sessions.sessionExists(wsId, sessionId, typeof cwd === 'string' ? cwd : null));
  // parking an agent with no feed: its last reply from the transcript tail
  ipcMain.handle('sessions:lastReply', (e, wsId, sessionId, cwd) => sessions.lastReply(wsId, String(sessionId || ''), typeof cwd === 'string' ? cwd : null));
  // auto-name for a tab still called agent-N: claude's own session title (or its
  // /rename name) from the transcript → { name, from } | null
  ipcMain.handle('sessions:tabName', (e, wsId, sessionId, cwd, taken) => {
    const ws = workspaces.get(wsId);
    return sessions.tabNameFor(wsId, String(sessionId || ''), typeof cwd === 'string' ? cwd : null, ws ? ws.name : '',
      Array.isArray(taken) ? taken.filter(n => typeof n === 'string').slice(0, 200) : []);
  });
  // worktree tabs (main/worktrees.cjs): the repo always comes from the SENDER's
  // own workspace, never from the renderer
  const wtRepo = (e, wsId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const self = win && winInfo.get(win.id)?.wsId;
    const ws = self && self === wsId && workspaces.get(self);
    return ws ? ws.repoPath : null;
  };
  ipcMain.handle('wt:create', async (e, wsId, name) => {
    const repo = wtRepo(e, wsId);
    if (!repo) return { ok: false, reason: 'no workspace' };
    const r = await worktrees.create(repo, String(name || 'agent'));
    logger.info(`worktree create: ws=${wsId} ${r.ok ? `${r.path} branch=${r.branch} base=${r.base}` : 'failed: ' + r.reason}`);
    if (r.ok) gitstatus.bust(repo);
    return r;
  });
  ipcMain.handle('wt:list', async (e, wsId) => {
    const repo = wtRepo(e, wsId);
    return repo ? worktrees.list(repo) : null;
  });
  ipcMain.handle('wt:remove', async (e, wsId, name, opts) => {
    const repo = wtRepo(e, wsId);
    if (!repo) return { ok: false, reason: 'no workspace' };
    const discard = Boolean(opts && opts.discard);
    const r = await worktrees.remove(repo, String(name || ''), { discard });
    logger.info(`worktree remove: ws=${wsId} ${name}${discard ? ' (discard)' : ''} -> ${r.ok ? 'removed' + (r.branchKept ? ', branch kept' : '') : (r.kept ? 'kept: ' : 'failed: ') + r.reason}`);
    if (r.ok) gitstatus.bust(repo);
    return r;
  });
  // away mode (machine-wide, presence.cjs): the renderer may only toggle the
  // manual modes; 'idle' is decided by lock/idle detection
  ipcMain.handle('presence:get', () => presence.get());
  ipcMain.handle('presence:set', (e, mode) => (mode === 'away' || mode === 'present' ? presence.set(mode, 'manual') : presence.get()));
  // claude accounts (machine-wide, main/accounts.cjs). The token goes renderer →
  // here → DPAPI on stdin; it is never logged and never sent back.
  ipcMain.handle('accounts:list', () => accounts.state());
  ipcMain.handle('accounts:add', (e, label, token) => accounts.add(label, token));
  ipcMain.handle('accounts:remove', (e, id) => accounts.remove(String(id || '')));
  ipcMain.handle('accounts:rename', (e, id, label) => accounts.rename(String(id || ''), label));
  ipcMain.handle('accounts:move', (e, id, delta) => accounts.move(String(id || ''), delta));
  ipcMain.handle('accounts:clear', (e, id) => accounts.clear(String(id || '')));
  ipcMain.handle('accounts:setTerm', (e, termId, accountId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const wsId = win && winInfo.get(win.id)?.wsId;
    const id = accounts.has(accountId) ? String(accountId) : accounts.LOGIN;
    if (id !== accountId) logger.warn(`account: term=${termId} asked for unknown account ${accountId}, using login`);
    ptyhost.setAccount(String(termId), id, wsId || null);
    if (termAccount.get(String(termId)) !== id) {
      // older limit windows / transcript errors belong to the previous account
      claudefeed.clearRateLimits(String(termId));
      accountSince.set(String(termId), Date.now());
    }
    termAccount.set(String(termId), id);
    logger.info(`account: term=${termId} -> ${id}`);
    return id; // the account actually used (unknown/removed ids fall back to login)
  });
  ipcMain.handle('pty:waitClaudeExit', (e, termId, timeoutMs) => ptyhost.waitClaudeExit(String(termId), Number(timeoutMs) || 15000));

  // misc
  ipcMain.handle('util:claudeVersion', () => updater.claudeVersion());
  ipcMain.handle('util:openLogs', () => { shell.openPath(logger.logsDir()); return true; });
  // which attention events toast — machine-wide (main/notifyprefs.cjs)
  ipcMain.handle('notify:get', () => notifyprefs.get());
  ipcMain.handle('notify:set', (e, patch) => {
    const next = notifyprefs.set(patch);
    logger.info(`notifications set: ${JSON.stringify(next)}`);
    return next;
  });
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
  lagmon.start((line) => logger.warn(line));
  ptyhost.onData((termId, chunk) => {
    lagmon.noteOutput(termId);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pty:data', termId, chunk);
    }
  });
  ptyhost.onExit((termId) => {
    lagmon.forget(termId);
    termStatus.delete(termId);
    attnTerms.delete(termId);
    termAccount.delete(termId); // ptyhost.create clears the account file too
    claudefeed.forget(termId);
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
  // ONE path for base-status changes — status files and the feed's instant
  // attention both land here, so lights, toasts, badge and the busy check move
  // together (main/attention.cjs arbitrates; toasts once per episode)
  const applyStatus = (wsId, termId, st, notify, via) => {
    termStatus.set(termId, st);
    logger.info(`term status: ws=${wsId} term=${termId} ${st}${via ? ' (' + via + ')' : ''}`);
    for (const win of workspaceWindowsFor(wsId)) {
      if (!win.isDestroyed()) win.webContents.send('term:status', termId, st);
    }
    if (notify) notifyAttention(wsId, termId, st);
    board.touch(wsId);
  };
  const attnOf = (termId) => {
    let t = attnTerms.get(termId);
    if (!t) { t = attention.newTerm(); attnTerms.set(termId, t); }
    return t;
  };
  status.onData((wsId, termId, st) => {
    const r = attention.fileStatus(attnOf(termId), st);
    if (r.apply) applyStatus(wsId, termId, r.apply, r.notify);
    else logger.info(`term status: ws=${wsId} term=${termId} ${st} ignored (feed: dialog still open)`);
  });
  // claude data feed: per-term snapshot to the owning window; the account-wide
  // 5h/7d limits to every workspace window
  const failureSeen = new Map(); // termId -> failure.at already toasted
  // status words from the feed's HTTP hooks — same words, same file, same
  // downstream (status.cjs → attention.fileStatus) as the Git Bash hooks they
  // replace; the idle "waiting for your input" nudge stays green like before
  claudefeed.onHook((wsId, termId, event, body) => {
    noteTurnForAccount(termId, event, body);
    const st = status.wordForHook(event, body);
    const file = st && ptyhost.statusFileOf(termId);
    if (!file) return;
    try { fs.appendFileSync(file, st + '\n'); } catch (e) { logger.warn('status write failed: ' + e.message); }
  });
  claudefeed.onData((wsId, termId, feed) => {
    for (const win of workspaceWindowsFor(wsId)) {
      if (!win.isDestroyed()) win.webContents.send('term:feed', { termId, feed });
    }
    // instant "needs you": PermissionRequest / question tool → base waiting now,
    // not ~6 s later when the permission_prompt Notification hook runs
    const r = attention.feedState(attnOf(termId), feed);
    if (r.apply) applyStatus(wsId, termId, r.apply, r.notify, 'feed');
    // exact session tracking: the feed's session_id IS this tab's conversation
    if (feed.sessionId && sessions.pinFromFeed(wsId, termId, feed.sessionId, feed.transcriptPath)) {
      logger.info(`session via feed: term=${termId} session=${feed.sessionId}`);
      for (const win of workspaceWindowsFor(wsId)) {
        if (!win.isDestroyed()) win.webContents.send('session:found', termId, feed.sessionId);
      }
    }
    // a failed turn (StopFailure) toasts + badges like a waiting agent — once.
    // A USAGE LIMIT instead moves the tab to the next available account
    // (handleFailure), which skips the toast when it switches.
    if (feed.failure && failureSeen.get(termId) !== feed.failure.at) {
      failureSeen.set(termId, feed.failure.at);
      const f = feed.failure;
      logger.info(`term failed: ws=${wsId} term=${termId} ${f.reason} [type=${f.type || '-'} message=${JSON.stringify(String(f.message || '').slice(0, 200))}]`);
      handleFailure(wsId, termId, feed).catch((err) => {
        logger.warn('account switch check failed: ' + err.message);
        notifyAttention(wsId, termId, 'failed');
      });
    }
    board.touch(wsId);
  });
  // accounts.json changed (here or in another workspace process) → every window
  accounts.onChange((st) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('accounts:changed', st);
    }
  });
  claudefeed.onLimits((limits) => {
    for (const [id] of winInfo) {
      const win = BrowserWindow.fromId(id);
      if (win && !win.isDestroyed()) win.webContents.send('account:limits', limits);
    }
  });
  // presence changes from ANY process (the state file is watched) → every window
  presence.onChange((p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('presence:changed', p);
    }
  });
  treewatch.onData((wsId) => {
    logger.info(`tree changed: ws=${wsId}`);
    for (const win of workspaceWindowsFor(wsId)) {
      if (!win.isDestroyed()) win.webContents.send('tree:changed');
    }
  });
}

// ---------- usage limit → continue on the next account ----------
const SWITCH_MIN_GAP_MS = 5 * 1000; // duplicate events only; the 3-in-10-min cap stops real loops
const SWITCH_WINDOW_MS = 10 * 60 * 1000;
const SWITCH_MAX_IN_WINDOW = 3;
const TRANSCRIPT_MAX_AGE_MS = 5 * 60 * 1000;

// the tab's transcript (<projects>/<munged cwd>/<session>.jsonl), or null
function transcriptOf(wsId, termId, feed) {
  const sessionId = sessions.getSession(wsId, termId) || (feed && feed.sessionId);
  if (!sessionId) return null;
  const t = (rendererState.get(wsId)?.terminals || []).find(x => x.termId === termId);
  const ws = workspaces.get(wsId);
  const cwd = (t && t.cwd) || (ws && ws.repoPath);
  const dir = cwd && U.resolveClaudeProjectDir(cwd);
  return dir ? path.join(dir, `${sessionId}.jsonl`) : null;
}

// the transcript's last API error line, only if it belongs to THIS failure: no
// older than the failure (minus slack; claude may write it just after the hook)
// and written on the current account. After a switch both accounts share one
// transcript, so the previous account's limit line must not blame the new one.
async function transcriptFallback(wsId, termId, feed) {
  const file = transcriptOf(wsId, termId, feed);
  if (!file) return null;
  const at = (feed.failure && Number(feed.failure.at)) || Date.now();
  const since = Math.max(at - 20000, accountSince.get(termId) || 0, Date.now() - TRANSCRIPT_MAX_AGE_MS);
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise(r => setTimeout(r, 1500));
    const tx = accounts.lastApiErrorText(file);
    if (tx && tx.timestamp && tx.timestamp >= since) return tx;
  }
  return null;
}

// An account marked "out until …" can come back early (a plan change, the
// "reset limits" offer on claude.ai). Proof = a main-thread turn on that account
// that started after the limit evidence and ended with Stop (a failed turn fires
// StopFailure instead). The tab's own reading must not still show a full window.
const promptAt = new Map(); // termId -> ms of its last UserPromptSubmit
function noteTurnForAccount(termId, event, body) {
  if (body && body.agent_id) return; // subagent events say nothing about the turn
  if (event === 'UserPromptSubmit') { promptAt.set(termId, Date.now()); return; }
  if (event !== 'Stop') return;
  const started = promptAt.get(termId);
  const acct = termAccount.get(termId) || accounts.LOGIN;
  const at = started ? accounts.exhaustedAt(acct) : null;
  if (at === null || !(started > at)) return;
  // the statusLine tick with the new reading can land just after Stop
  setTimeout(() => {
    const feed = claudefeed.stateOf(termId);
    if (feed && accounts.hasFullWindow(feed.rateLimits)) return;
    try { accounts.clearIfProven(acct, started); } catch (e) { logger.warn('clearIfProven: ' + e.message); }
  }, 3000);
}

async function handleFailure(wsId, termId, feed) {
  const f = feed.failure;
  const t = (rendererState.get(wsId)?.terminals || []).find(x => x.termId === termId);
  if (!((t && t.isClaude) || termAccount.has(termId))) { notifyAttention(wsId, termId, 'failed'); return; }
  const acct = termAccount.get(termId) || accounts.LOGIN;
  let type = f.type;
  // always read the transcript: its error line carries quotaLimits.resetsAt, the
  // exact reset time (the feed message has at most the "resets Oct 5, 3pm" text)
  let text = null;
  let quota = null;
  const tx = await transcriptFallback(wsId, termId, feed);
  if (tx) {
    text = tx.text || null;
    quota = tx.quota || null;
    // the transcript's error field is verified live; the StopFailure body isn't
    if (tx.error === 'rate_limit' || !type) type = tx.error;
    logger.info(`term failed: term=${termId} transcript says [error=${tx.error || '-'} quota=${quota ? `${quota.status}/${quota.type}/${quota.resetsAt}` : '-'} text=${JSON.stringify(String(tx.text || '').slice(0, 200))}]`);
  }
  const c = accounts.classifyFailure({ type, message: f.message }, feed.rateLimits, text, Date.now(), quota);
  if (!c.usageLimit) { notifyAttention(wsId, termId, 'failed'); return; }
  accounts.markExhausted(acct, c.until, c.reason);
  const now = Date.now();
  const log = (switchLog.get(termId) || []).filter(ts => now - ts < SWITCH_WINDOW_MS);
  switchLog.set(termId, log);
  if (log.length && now - log[log.length - 1] < SWITCH_MIN_GAP_MS) {
    logger.warn(`account switch skipped: term=${termId} switched < 5 s ago`);
    notifyAttention(wsId, termId, 'failed');
    return;
  }
  if (log.length >= SWITCH_MAX_IN_WINDOW) {
    logger.warn(`account switch stopped: term=${termId} switched ${log.length}x in 10 min`);
    notifyAttention(wsId, termId, 'failed');
    return;
  }
  const to = accounts.pick(acct);
  if (!to) {
    logger.warn(`account switch: all accounts exhausted (term=${termId} from=${acct} until=${new Date(c.until).toISOString()})`);
    notifyAttention(wsId, termId, 'failed');
    return;
  }
  log.push(now);
  const msg = { termId, from: acct, to, toLabel: accounts.labelOf(to), until: c.until, reason: c.reason };
  logger.info(`account switch: term=${termId} from=${acct} to=${to} until=${new Date(c.until).toISOString()} (${c.reason})`);
  for (const win of workspaceWindowsFor(wsId)) {
    if (!win.isDestroyed()) win.webContents.send('account:switch', msg);
  }
}

// periodic state save (captures session ids discovered after the last renderer push)
function initStateFlush() {
  setInterval(() => {
    for (const wsId of new Set([...winInfo.values()].map(v => v.wsId))) persistState(wsId);
  }, 10000);
  // background auto-update detection: cheap fresh `claude --version` probe
  setInterval(() => {
    if (claudeBaselines.size) probeClaudeVersion();
  }, 5 * 60 * 1000).unref?.();
  // new-VibeSpace-code detection (dev only; no-op packaged)
  probeSrc();
  setInterval(probeSrc, 30000).unref?.();
}

// ---------- boot ----------
app.whenReady().then(async () => {
  // lost the single-instance lock (this workspace is already open): app.quit()
  // above is async, and without this guard the duplicate still opened a window,
  // spawned ptys/agents and, on its way out, deleted the running window's board
  // file — for ~2 s, every time the launcher or the board "focused" a workspace
  if (!gotLock) return;
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
    // feed server up BEFORE any pty/agent exists (ensureHookSettings reads its
    // port; a missing listener = red ECONNREFUSED lines in claude's TUI)
    await claudefeed.start({ resolveTerm: ptyhost.wsOf });
    claudefeed.setAccountResolver((termId) => termAccount.get(termId) || accounts.LOGIN);
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
    // away mode: workspace processes only (not the launcher, smoke or screenshot
    // runs) — each one tracks lock/idle and keeps the shared marker in sync
    try { presence.start(); } catch (e) { logger.warn('presence start failed: ' + e.message); }
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

// Windows shutdown / restart / logoff. Save everything ONE last time (fsynced),
// then freeze the state files: Windows may kill the terminal processes before
// us, and the renderer would read those exits as "tabs closed" and save an
// empty tab list over the good state. A reboot then restores the state exactly
// as it was (2026-10-01: a reboot cost recruitica its conversation + layout).
app.on('session-end', () => {
  logger.info('windows session ending (shutdown/restart/logoff) — final state save, then frozen');
  for (const w of BrowserWindow.getAllWindows()) { try { saveWindowState(w); } catch {} }
  for (const wsId of new Set([...winInfo.values()].map(v => v.wsId))) persistState(wsId);
  stateFrozen = true;
});

app.on('before-quit', () => {
  for (const wsId of new Set([...winInfo.values()].map(v => v.wsId))) persistState(wsId);
  stateFrozen = true; // killAll below makes every pty "exit" — never save that churn
  board.stopAll();
  presence.stop();
  accounts.unwatch();
  ptyhost.killAll();
});
