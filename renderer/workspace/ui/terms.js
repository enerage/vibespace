import { $, el, toast, confirmBox } from './common.js';
import { termTheme, onThemeChange } from './themes.js';
import { openTabMenu } from './tabmenu.js';
import * as feedui from './feedui.js';
import * as board from './board.js';

// terminal tabs: each hosts a PowerShell pty; "claude" tabs run Claude Code and
// get their session id tracked (main process) so they can be resumed after updates.

let wsId;
let repoPath;
let persist = () => {};
let openFile = null; // (path, name, line) — file:line links hand off to the viewer
let remote = () => false; // phone control pref (⚙): launch claude with --remote-control
let wsName = '';

const tabs = new Map(); // termId -> tab record
const feeds = new Map(); // termId -> latest claude feed snapshot (main/claudefeed.cjs)
let activeId = null;
let updating = false;
let counter = 0;
let updateSnapshot = null;

const TERM_OPTS = {
  fontSize: 13,
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  cursorBlink: true,
  scrollback: 6000,
  // theme comes from ui/themes.js per workspace (see createTab + onThemeChange)
  allowProposedApi: true,
};

export function init(opts) {
  wsId = opts.wsId;
  repoPath = opts.repoPath;
  persist = opts.persist || persist;
  openFile = opts.openFile || openFile;
  remote = opts.remote || remote;
  wsName = opts.wsName || '';

  // a theme switch repaints every live terminal in place (xterm v5 options setter)
  onThemeChange((t) => {
    for (const tab of tabs.values()) { try { tab.term.options.theme = t.term; } catch {} }
  });

  vs.onPtyData((termId, chunk) => {
    const tab = tabs.get(termId);
    if (tab) tab.term.write(chunk);
  });

  vs.onPtyExit((termId) => {
    const tab = tabs.get(termId);
    if (!tab) return;
    if (updating) {
      tab.dead = true;
      renderTabBar();
      return;
    }
    removeTab(termId, false);
  });

  vs.onSessionFound((termId, sessionId) => {
    const tab = tabs.get(termId);
    if (!tab || !sessionId || tab.sessionId === sessionId) return;
    tab.sessionId = sessionId;
    renderTabBar();
    persist();
  });

  // agent status lights, fed by injected claude hooks via main (status.cjs)
  vs.onTermStatus((termId, st) => {
    const tab = tabs.get(termId);
    if (!tab || tab.status === st) return;
    tab.status = st;
    if (st === 'done') { tab.doneAt = Date.now(); syncClaudeName(tab); }
    if ((st === 'waiting' || st === 'done') && activeId !== termId) tab.unread = true;
    renderTabBar();
  });
  vs.onTermFocus((termId) => { if (tabs.has(termId)) activateTab(termId); });

  // tabs wrap onto extra rows when they don't fit: the bar's height changes and
  // the terminal below shrinks or grows, so refit once (throttled) per change
  let barHeight = 0;
  new ResizeObserver(([entry]) => {
    const h = Math.round(entry.contentRect.height);
    if (h === barHeight) return;
    barHeight = h;
    scheduleRefit();
  }).observe($('#tabbar'));

  // claude data feed → context meter, light detail, task pill (all repainted IN
  // PLACE; a full renderTabBar per tick would churn the bar and kill a rename in
  // progress) + activity strip / peek card (ui/feedui.js). The snapshot covers a
  // reload: everything shows before the next tick arrives.
  feedui.init({ getTab: (id) => tabs.get(id), getFeed: (id) => feeds.get(id), activeId: () => activeId });
  board.init({ wsId }); // ▦ agent board (Ctrl+Shift+B) — reads tabs + feeds via the exports below
  vs.onTermFeed((termId, feed) => {
    if (!termId) return;
    feeds.set(termId, feed);
    const tab = tabs.get(termId);
    if (tab) paintMeter(tab);
    feedui.onFeed(termId);
    notifyAgents();
  });
  vs.feedSnapshot(wsId).then((snap) => {
    for (const [termId, feed] of Object.entries((snap && snap.terms) || {})) {
      if (feeds.has(termId)) continue; // a live tick already beat the snapshot
      feeds.set(termId, feed);
      const tab = tabs.get(termId);
      if (tab) paintMeter(tab);
    }
    feedui.refresh();
  }).catch(() => {});
  // the pill hides a minute after an all-done turn ends — no feed tick says so
  setInterval(() => { for (const tab of tabs.values()) paintMeter(tab); }, 30000);

  vs.onUpdaterStage((stage) => {
    if (stage === 'stopping-agents') $('#update-status').textContent = 'Closing agent terminals…';
    if (stage === 'updating') $('#update-status').textContent = 'Running claude update…';
    if (stage === 'relaunching') $('#update-status').textContent = 'Relaunching agents…';
  });
  vs.onUpdaterLine((line) => {
    const log = $('#update-log');
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  });
  vs.onUpdaterDone(async (info) => {
    if (!updating) return;
    $('#update-status').textContent = info.code === 0 ? 'Done — agents relaunching…' : `claude update exited with ${info.code} — relaunching anyway…`;
    await new Promise(r => setTimeout(r, 900));
    $('#update-modal').classList.add('hidden');
    updating = false;
    relaunchFromSnapshot(updateSnapshot || []);
  });

  $('#btn-new-claude').onclick = () => createTab({ name: nextName('agent'), cwd: repoPath, claude: true });
  // right-click + Claude: start from an EXISTING conversation — claude's own
  // resume picker opens in the new tab and the picked session gets pinned
  const resumePicker = () => createTab({ name: nextName('agent'), cwd: repoPath, pickSession: true });
  $('#btn-new-claude').oncontextmenu = (ev) => {
    ev.preventDefault();
    resumePicker();
  };
  $('#btn-resume').onclick = resumePicker; // the same, as a visible button
  $('#btn-new-term').onclick = () => createTab({ name: nextName('term'), cwd: repoPath });
  $('#btn-update').onclick = updateRestartAll;

  // the ⟳ button only exists when it has something to do: claude auto-updates in
  // the background, and the button restarts agents ONTO that new version — so it
  // stays hidden until the on-disk version differs from what these agents run
  const updateBtn = $('#btn-update');
  updateBtn.classList.add('hidden');
  vs.onUpdaterState((s) => {
    if (s && s.available && s.diskVersion) {
      updateBtn.classList.remove('hidden');
      updateBtn.title = `Claude Code ${s.diskVersion} is ready — restart all agents onto it (every conversation resumes)`;
    } else {
      updateBtn.classList.add('hidden');
    }
  });

  // ---- Ctrl+F: find inside the active terminal ----
  $('#term-find-next').onclick = () => termFind(false);
  $('#term-find-prev').onclick = () => termFind(true);
  $('#term-find-close').onclick = closeTermFind;
  $('#term-find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); termFind(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeTermFind(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      // Monaco has its own find — only handle when focus is NOT in the editor
      const ae = document.activeElement;
      if (ae && $('#monaco-host')?.contains(ae)) return;
      e.preventDefault();
      openTermFind();
    }
  }, true);

  // restore saved terminals (or start one fresh agent on first run).
  // A renderer reload leaves every pty alive in the main process — attach to them
  // (replaying their buffered output) instead of killing and re-spawning agents.
  const saved = Array.isArray(opts.savedTerminals) ? opts.savedTerminals.filter(t => t && t.name) : [];
  vs.ptyList().then(async live => {
    const liveByTerm = new Map(live.map(p => [p.termId, p]));
    if (saved.length === 0) createTab({ name: 'agent-1', cwd: repoPath, claude: true });
    let attached = 0;
    const deadSessions = [];
    for (const t of saved) {
      const isClaude = t.isClaude === undefined ? true : Boolean(t.isClaude); // legacy states predate the flag
      const p = liveByTerm.get(t.termId);
      if (p) {
        attached++;
        createTab({
          termId: t.termId,
          name: t.name,
          cwd: t.cwd || repoPath,
          attachBuffer: p.buffer,
          savedIsClaude: isClaude,
          savedSessionId: t.claudeSessionId || null,
        });
      } else if (opts.autoResume && isClaude && t.claudeSessionId && !(await vs.sessionCheck(wsId, t.claudeSessionId))) {
        // saved session file is gone — open claude's interactive picker instead of
        // typing a resume id that would silently error out
        deadSessions.push(t.name);
        createTab({ termId: t.termId || null, name: t.name, cwd: t.cwd || repoPath, pickSession: true });
      } else {
        createTab({
          termId: t.termId || null, // keep stable ids across restarts (sessions pin by termId)
          name: t.name,
          cwd: t.cwd || repoPath,
          claude: opts.autoResume && isClaude && !t.claudeSessionId,
          resumeId: opts.autoResume ? (t.claudeSessionId || null) : null,
        });
      }
    }
    if (deadSessions.length) toast(`${deadSessions.join(', ')}: saved session gone — resume picker opened in tab`, 'err');
    // safety net: a live pty with no saved tab (state lost mid-reload) still gets a tab
    for (const p of live) {
      if (!tabs.has(p.termId)) {
        attached++;
        createTab({ termId: p.termId, name: 'recovered', cwd: p.cwd || repoPath, attachBuffer: p.buffer, savedIsClaude: true, savedSessionId: null });
      }
    }
    if (!opts.quiet) {
      if (attached) toast(`Re-attached ${attached} live terminal${attached > 1 ? 's' : ''} — agents never stopped`, 'ok');
      else if (saved.length && opts.autoResume) toast(`Restored ${saved.length} agent terminal${saved.length > 1 ? 's' : ''} — conversations resumed`, 'ok');
      else if (saved.length) toast(`Restored ${saved.length} terminals (auto-resume off)`, '');
    }
  }).catch(() => {
    // pty:list failed — fall back to the classic spawn/resume path
    if (saved.length === 0) { createTab({ name: 'agent-1', cwd: repoPath, claude: true }); return; }
    for (const t of saved) {
      const isClaude = t.isClaude === undefined ? true : Boolean(t.isClaude);
      createTab({
        termId: t.termId || null,
        name: t.name,
        cwd: t.cwd || repoPath,
        claude: opts.autoResume && isClaude && !t.claudeSessionId,
        resumeId: opts.autoResume ? (t.claudeSessionId || null) : null,
      });
    }
  });
}

function openTermFind() {
  $('#term-find').classList.remove('hidden');
  const input = $('#term-find-input');
  input.focus();
  input.select();
}

function closeTermFind() {
  $('#term-find').classList.add('hidden');
  $('#term-find-input').value = '';
  const tab = tabs.get(activeId);
  if (tab?.search) { try { tab.search.clearDecorations(); } catch {} }
  if (tab) tab.term.focus();
}

function termFind(backwards) {
  const tab = tabs.get(activeId);
  const q = $('#term-find-input').value;
  if (!tab || !tab.search || !q) return;
  try {
    tab.search.findNext(q, {
      backwards: Boolean(backwards),
      caseSensitive: false,
      decorations: { matchOverviewRuler: '#6e9cff', activeMatchColorOverviewRuler: '#f0f6fc' },
    });
  } catch {}
}

function nextName(prefix) {
  let i = 1;
  const names = new Set([...tabs.values()].map(t => t.name));
  while (names.has(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}

function newTermId() {
  return 't' + (++counter) + '_' + Math.random().toString(36).slice(2, 6);
}

// ---- clipboard: Windows-Terminal-style copy/paste ----
async function copySelection(term) {
  const text = term.getSelection();
  if (text) await vs.writeClipboard(text);
}

async function pasteInto(term) {
  const text = await vs.readClipboard();
  if (text) term.paste(text);
}

function wireClipboard(term) {
  // Ctrl+C copies when something is selected, interrupts otherwise (pass through).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const key = ev.key.toLowerCase();
    if (key === 'insert') {
      if (ev.ctrlKey && term.hasSelection()) { ev.preventDefault(); copySelection(term); return false; }
      if (ev.shiftKey) { ev.preventDefault(); pasteInto(term); return false; }
      return true;
    }
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!ctrl) return true;
    if (key === 'c') {
      if (term.hasSelection()) { ev.preventDefault(); copySelection(term); return false; }
      // Ctrl+Shift+C is copy-only (Windows Terminal convention) — never an interrupt
      if (ev.shiftKey) { ev.preventDefault(); return false; }
      return true; // plain Ctrl+C, no selection: interrupt for the shell/claude
    }
    if (key === 'v') { // Ctrl+V and Ctrl+Shift+V both paste
      ev.preventDefault();
      pasteInto(term);
      return false;
    }
    return true;
  });

  // right-click: copy selection, or paste when nothing is selected.
  // When the program in the terminal has mouse tracking on (Claude Code does, once
  // past its trust screen), xterm forwards the right-click to it and IT pastes from
  // the clipboard — pasting here too doubled every right-click paste. So: leave
  // right-click to the app when it tracks the mouse.
  term.element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      copySelection(term);
      term.clearSelection();
      return;
    }
    const mouseMode = term.modes?.mouseTrackingMode || 'none';
    if (mouseMode !== 'none') return; // the app handles its own right-click paste
    pasteInto(term);
  });
}

// ---- drag-and-drop: Windows-Terminal-style path paste ----
// Dropping files from Explorer pastes their full paths (quoted when they contain
// spaces). Going through term.paste() keeps bracketed paste, so Claude Code sees
// a pasted image path and attaches the image itself.
const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);

function wireDrop(term, host) {
  host.addEventListener('dragover', (ev) => {
    const types = ev.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('text/plain')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  host.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const paths = [...ev.dataTransfer.files].map(f => vs.dropPath(f)).filter(Boolean);
    const text = paths.length ? paths.map(quotePath).join(' ') : ev.dataTransfer.getData('text/plain');
    if (!text) return;
    term.paste(text);
    term.focus();
  });
}

// ---- file:line links ---------------------------------------------------------
// Clicking D:\repo\src\app.js:42 (or src/app.js:42) in claude's output opens the
// file in the preview at that line. Uses xterm's core registerLinkProvider —
// no vendored addon. The lookbehinds keep URLs (https://host/x:1) and paths
// already matched as absolute from producing duplicate/false hits; the \d+
// anchor means a drive colon can never read as a line number.
const ABS_PATH_LINE = /(?<![\w./])([A-Za-z]:(?:[\\/][^\s:"'<>|]+)+):(\d+)(?::(\d+))?/g;
const REL_PATH_LINE = /(?<![\w.\\/:])([\w][\w.\-]*(?:[\\/][^\s:"'<>|]+)+):(\d+)(?::(\d+))?/g;
// quoted paths may contain spaces — claude quotes those; requires a separator
// so arbitrary quoted "text: 5" doesn't light up
const QUOTED_PATH_LINE = /"((?:[A-Za-z]:)?[^"]*?[\\/][^"]*?):(\d+)"/g;

const baseName = (p) => p.split(/[\\/]/).pop();

async function openPathAt(tab, rawPath, line) {
  const p = rawPath.replace(/^["']+|["']+$/g, ''); // claude quotes paths with spaces
  const isAbs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (isAbs) { if (openFile) openFile(p, baseName(p), line); return; }
  // relative: try the terminal's spawn cwd first, then the workspace root
  for (const base of [tab.cwd, repoPath]) {
    if (!base) continue;
    const cand = base.replace(/[\\/]+$/, '') + '/' + p;
    try { await vs.fsRead(cand); } catch { continue; } // existence check
    if (openFile) openFile(cand, baseName(p), line);
    return;
  }
  toast('Not found: ' + p, 'err');
}

function registerFileLinks(term, tab) {
  try {
    term.registerLinkProvider({
      provideLinks(lineNo, cb) {
        try {
          const row = term.buffer.active.getLine(lineNo);
          const text = row ? row.translateToString(true) : '';
          if (!text) return cb(undefined);
          const hits = [];
          const inHit = (i) => hits.some(h => i >= h.start && i < h.start + h.len);
          const add = (m) => hits.push({ start: m.index, len: m[0].length, path: m[1], line: +m[2] });
          for (const m of text.matchAll(QUOTED_PATH_LINE)) add(m); // quoted (spaces) first…
          for (const m of text.matchAll(ABS_PATH_LINE)) if (!inHit(m.index)) add(m); // …then unquoted
          for (const m of text.matchAll(REL_PATH_LINE)) if (!inHit(m.index)) add(m);
          if (!hits.length) return cb(undefined);
          cb(hits.map(h => ({
            range: { start: { x: h.start + 1, y: lineNo }, end: { x: Math.min(h.start + h.len, term.cols), y: lineNo } },
            text: text.slice(h.start, h.start + h.len),
            activate: () => openPathAt(tab, h.path, h.line),
          })));
        } catch { cb(undefined); }
      },
    });
  } catch {} // xterm without link-provider support — links simply don't light up
}

export function createTab({ name = 'agent', cwd = repoPath, claude = false, resumeId = null, activate = true, termId = null, attachBuffer = null, savedIsClaude = null, savedSessionId = null, pickSession = false, run = null } = {}) {
  const id = termId || newTermId();
  const host = el('div', 'term-host');
  host.style.display = 'none';
  $('#term-hosts').appendChild(host);

  const term = new window.Terminal({ ...TERM_OPTS, theme: termTheme() });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // Ctrl+F search addon (per terminal); the find bar drives the ACTIVE tab
  let search = null;
  const SearchCtor = window.SearchAddon?.SearchAddon;
  if (SearchCtor) {
    try {
      search = new SearchCtor();
      term.loadAddon(search);
    } catch {}
  }

  const tab = {
    id, name, cwd,
    sessionId: savedSessionId || resumeId || null,
    term, fit, host, dead: false, search,
    isClaude: savedIsClaude !== null ? Boolean(savedIsClaude) : Boolean(claude || resumeId || pickSession),
  };
  tabs.set(id, tab);
  registerFileLinks(term, tab);
  renderTabBar();
  if (activate || tabs.size === 1) activateTab(id);

  if (attachBuffer !== null) {
    // Layer 2: attach to a pty that survived a reload — never spawn, never type a
    // resume command; the agent process kept running the whole time.
    if (attachBuffer) term.write(attachBuffer);
    vs.ptyResize(id, Math.max(term.cols, 20), Math.max(term.rows, 10));
  } else {
    // rcLabel feeds the shell's `claude` wrapper (ptyhost), so a claude typed by
    // hand gets the same Remote Control name as one we launch
    vs.ptyCreate({ termId: id, wsId, cwd, cols: Math.max(term.cols, 20), rows: Math.max(term.rows, 10), rcLabel: remote() ? rcLabel(name) : null })
      .then(info => { tab.hookSettings = info && info.settingsPath; })
      .catch(e => toast('Terminal failed: ' + (e.message || e), 'err'));
  }

  term.onData(d => {
    // typed input marks "user may have a half-typed prompt" for syncClaudeName
    if (!/^\x1b\[(M|<|I$|O$)/.test(d)) tab.lastInputAt = Date.now(); // not mouse/focus reports
    vs.ptyWrite(id, d);
  });
  wireClipboard(term);
  wireDrop(term, host);
  term.onResize(({ cols, rows }) => vs.ptyResize(id, cols, rows));
  host.addEventListener('mousedown', () => activateTab(id), true);

  if (attachBuffer === null && (claude || resumeId || pickSession)) {
    setTimeout(() => {
      if (!tabs.has(id)) return;
      const cmd = claudeCommand(tab, pickSession ? '' : resumeId); // '' = picker: saved id is dead
      vs.ptyWrite(id, cmd + '\r');
      vs.claudeStarted(wsId, id, pickSession ? { picker: true } : undefined);
      if (resumeId) vs.sessionPinned(wsId, id, resumeId);
    }, 900);
  } else if (attachBuffer === null && run) {
    // a one-off command typed into a plain tab (board → background agent attach)
    setTimeout(() => { if (tabs.has(id)) vs.ptyWrite(id, run + '\r'); }, 900);
  }
  persist();
  return tab;
}

// The ONE builder for a new interactive claude:
//   claude [--resume [<id>]] [--remote-control "<label>"] [--settings "<path>"]
// resumeId: null = fresh, '' = the interactive picker, else that session.
// --remote-control lists the session in the Claude phone app; --settings
// injects the status hooks and merges with the user's own settings.
function claudeCommand(tab, resumeId = null) {
  let cmd = resumeId == null ? 'claude' : `claude --resume${resumeId ? ' ' + resumeId : ''}`;
  if (remote()) {
    const label = rcLabel(tab.name);
    if (label) cmd += ` --remote-control "${label}"`;
  }
  if (tab.hookSettings) cmd += ` --settings "${tab.hookSettings}"`;
  return cmd;
}

// "<workspace> · <tab>", safe inside a PowerShell double-quoted string: no
// quotes, $, backticks or other specials survive
function rcLabel(tabName) {
  return `${wsName} · ${tabName}`
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ._\-·()]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  for (const t of tabs.values()) t.host.style.display = 'none';
  activeId = id;
  tab.unread = false; // looking at it answers the attention signal
  tab.host.style.display = 'block';
  try { tab.fit.fit(); } catch {}
  tab.term.focus();
  renderTabBar();
  persist(); // main needs the active tab to decide whether a finish deserves a toast
}

// Ctrl+Shift+U: cycle to the next tab that needs you (waiting first, then finished)
export function jumpToAttention() {
  const order = [...tabs.keys()];
  if (!order.length) return false;
  const start = order.indexOf(activeId);
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length];
    const t = tabs.get(id);
    if (t && (t.status === 'waiting' || t.status === 'done')) { activateTab(id); return true; }
  }
  return false;
}

export function refitActive() {
  if (resizeDepth > 0) return; // mid-drag: scheduleRefit handles it, throttled
  const tab = tabs.get(activeId);
  if (tab) { try { tab.fit.fit(); } catch {} }
}

// Dragging resizes the pane on every pointer move; refitting xterm (and the pty)
// on each pixel thrashes ConPTY — so during drags we refit at most every 120ms.
let resizeDepth = 0;
let refitTimer = null;

export function beginResize() {
  resizeDepth++;
}

export function endResize() {
  resizeDepth = Math.max(0, resizeDepth - 1);
  if (resizeDepth === 0) refitActive();
}

export function scheduleRefit() {
  if (refitTimer) return;
  refitTimer = setTimeout(() => {
    refitTimer = null;
    if (resizeDepth > 0) {
      const tab = tabs.get(activeId);
      if (tab) { try { tab.fit.fit(); } catch {} }
    } else {
      refitActive();
    }
  }, 120);
}

function removeTab(termId, kill = true) {
  const tab = tabs.get(termId);
  if (!tab) return;
  if (kill) vs.ptyKill(termId);
  tab.term.dispose();
  tab.host.remove();
  tabs.delete(termId);
  feeds.delete(termId);
  if (activeId === termId) {
    const next = [...tabs.keys()][0];
    if (next) activateTab(next);
  }
  renderTabBar();
  persist();
}

function renderTabBar() {
  // mid-rename: rebuilding the bar would destroy the input (status changes and
  // session captures redraw constantly while agents run) — skip until committed
  if ($('#tabs .rename')) return;
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const tab of tabs.values()) {
    const t = el('div', 'tab' + (tab.id === activeId ? ' active' : '') + (tab.dead ? ' dead' : '') + (tab.unread ? ' unread' : ''));
    t.dataset.termId = tab.id; // drag-to-reorder reads the order back from the bar
    const st = tab.status || '';
    const status = el('span', 'status' + (tab.sessionId ? ' on' : '') + (st ? ' ' + st : ''));
    status.title = st === 'working' ? 'agent is working'
      : st === 'waiting' ? 'agent is asking for you — permission or question'
      : st === 'done' ? 'task completed — agent is idle'
      : (tab.sessionId ? `session ${tab.sessionId.slice(0, 8)}…` : 'no claude session yet');
    const label = el('span', 'label', tab.name);
    label.title = (tab.sessionId ? `${tab.name} — ${tab.sessionId}` : tab.name) + '  (double-click to rename · right-click for options)';
    const close = el('span', 'close', '✕');
    close.title = 'close terminal';
    const meter = el('span', 'ctx-meter hidden'); // context-window fill, bottom edge
    const pill = el('span', 'task-pill hidden'); // `3/7` tasks done (claude feed)
    tab.meterEl = meter;
    tab.labelEl = label;
    tab.labelTitle = label.title;
    tab.statusEl = status;
    tab.statusClass = status.className;
    tab.statusTitle = status.title;
    tab.pillEl = pill;

    t.append(status, label, pill, close, meter);
    paintMeter(tab);
    t.onclick = () => activateTab(tab.id);
    // right-click = options menu (rename, agent info, copy id/name/resume, close)
    t.oncontextmenu = (ev) => {
      ev.preventDefault();
      openTabMenu(ev, tab, { rename: () => startRename(t, label, tab), close: () => close.onclick(new MouseEvent('click')) });
    };
    close.onclick = async (ev) => {
      ev.stopPropagation();
      const hasAgent = tab.sessionId || !tab.dead;
      if (hasAgent && !(await confirmBox(`Close "${tab.name}"?\nIts claude conversation is saved and can be resumed later.`, { ok: 'Close', danger: true }))) return;
      removeTab(tab.id);
    };
    label.ondblclick = (ev) => {
      ev.stopPropagation();
      startRename(t, label, tab);
    };
    wireTabDrag(bar, t);

    bar.appendChild(t);
  }
  feedui.refresh(); // the strip follows the active tab + its base status
  notifyAgents(); // board: status changes, renames, tabs added/removed
}

// ---- context meter (claude data feed) ----------------------------------------
// Thin bar on the tab's bottom edge, width = context used %. Green < 60 %,
// amber < 85 %, red ≥ 85 %. No bar until the first model response (claude
// reports context % as null until then — "no data", never 0 %).
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

function feedSummary(f) {
  if (!f) return '';
  const parts = [];
  if (f.model && f.model.name) parts.push(f.model.name);
  const c = f.context;
  if (c && typeof c.pct === 'number') parts.push(`context ${Math.round(c.pct)}%` + (c.size ? ` (${fmtTokens(c.used || 0)}/${fmtTokens(c.size)})` : ''));
  if (typeof f.cost === 'number') parts.push('$' + f.cost.toFixed(2));
  if (f.linesAdded || f.linesRemoved) parts.push(`+${f.linesAdded || 0}/−${f.linesRemoved || 0}`);
  return parts.join(' · ');
}

// Also paints the feed's detail on the light (lock / ? / failed ✕ + reason
// tooltip) and the `3/7` task pill. Base classes come from renderTabBar; with no
// feed everything below is a no-op and the tab looks exactly as before.
function paintMeter(tab) {
  const m = tab.meterEl;
  if (!m) return;
  const f = feeds.get(tab.id);
  const c = f && f.context;
  if (c && typeof c.pct === 'number') {
    const pct = Math.max(0, Math.min(100, c.pct));
    m.className = 'ctx-meter ' + (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : 'ok');
    // measured against the whole tab (it is the positioned box), so the bar
    // spans the task pill too
    m.style.width = `calc((100% - 14px) * ${pct / 100})`;
  } else {
    m.className = 'ctx-meter hidden';
  }
  const line = feedSummary(f);
  m.title = line;
  if (tab.labelEl) tab.labelEl.title = tab.labelTitle + (line ? '\n' + line : '');
  if (tab.statusEl) {
    const d = feedui.lightDetail(f, tab.status);
    tab.statusEl.className = tab.statusClass + (d.cls ? ' ' + d.cls : '');
    tab.statusEl.title = d.title || tab.statusTitle;
  }
  if (tab.pillEl) {
    const p = feedui.pillText(f, tab.status);
    tab.pillEl.textContent = p;
    tab.pillEl.classList.toggle('hidden', !p);
    tab.pillEl.title = p ? `${p} tasks done` : '';
  }
}

// ---- drag to reorder tabs ----------------------------------------------------
// Follows the splitter drag rules: window-level capture listeners for the drag,
// absolute clientX, NO setPointerCapture (breaks under remote-control software).
// A 4 px threshold keeps plain clicks and the dblclick rename from ever
// triggering a drag. DOM order is committed into the tabs Map (insertion order
// = display order = persisted snapshot order) on release.
function wireTabDrag(bar, t) {
  t.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.close') || e.target.closest('.rename')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev) => {
      if (!dragging) {
        if (Math.max(Math.abs(ev.clientX - startX), Math.abs(ev.clientY - startY)) < 4) return;
        dragging = true;
        t.classList.add('dragging');
        document.body.classList.add('dragging'); // user-select: none while dragging
      }
      // the bar wraps into rows: drop before the first tab that sits in a row
      // below the pointer, or in the pointer's row past its midpoint
      for (const sib of bar.children) {
        if (sib === t) continue;
        const r = sib.getBoundingClientRect();
        if (ev.clientY < r.top || (ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2)) {
          bar.insertBefore(t, sib);
          return;
        }
      }
      bar.appendChild(t); // pointer is past everything
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      if (!dragging) return;
      t.classList.remove('dragging');
      document.body.classList.remove('dragging');
      const next = new Map();
      for (const el of bar.children) {
        const rec = tabs.get(el.dataset.termId);
        if (rec) next.set(el.dataset.termId, rec);
      }
      if (next.size !== tabs.size) return; // stale bar — next redraw fixes order
      tabs.clear();
      for (const [id, rec] of next) tabs.set(id, rec);
      persist();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  });
}

function startRename(tabEl, labelEl, tab) {
  if (tabEl.querySelector('.rename')) return; // already renaming this tab
  const input = el('input', 'rename');
  input.value = tab.name;
  // clicks inside the input must not bubble to the tab's onclick/oncontextmenu —
  // that runs activateTab → term.focus() and rips focus out mid-rename (double-
  // rename would also re-target a detached label)
  for (const evn of ['mousedown', 'click', 'contextmenu']) {
    input.addEventListener(evn, (e) => e.stopPropagation());
  }
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v && v !== tab.name && tab.isClaude) {
      tab.pendingRename = rcLabel(v); // phone + /resume list name: sent when the agent is idle
      tab.name = v;
      syncClaudeName(tab);
    } else if (v) tab.name = v;
    input.remove(); // redraws are skipped while .rename is live — clear it BEFORE rebuilding
    renderTabBar();
    persist();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = tab.name; input.blur(); }
    e.stopPropagation();
  };
}

export function snapshot() {
  return [...tabs.values()].map(t => ({
    termId: t.id,
    name: t.name,
    cwd: t.cwd,
    isClaude: t.isClaude,
    claudeSessionId: t.sessionId || null,
  }));
}

export function isActiveKnown() {
  return activeId !== null;
}

export function activeTermId() {
  return activeId;
}

// ---- read access for the agent board (ui/board.js) and the tab menu ----------
// The board only READS tab + feed state; the status files / feed stay the truth.
const agentListeners = [];
let agentsQueued = false;
export function onAgentsChanged(fn) { agentListeners.push(fn); }
function notifyAgents() {
  if (agentsQueued || !agentListeners.length) return;
  agentsQueued = true;
  queueMicrotask(() => { agentsQueued = false; for (const fn of agentListeners) { try { fn(); } catch {} } });
}

export function feedFor(termId) {
  return feeds.get(termId) || null;
}

export function agents() {
  return [...tabs.values()].map(t => ({
    id: t.id, name: t.name, status: t.status || null, isClaude: t.isClaude, dead: t.dead, feed: feeds.get(t.id) || null,
  }));
}

export function activate(id) {
  if (tabs.has(id)) activateTab(id);
}

// board → background agent: a new tab running `claude attach <id>`. A PLAIN
// tab: attach ignores --settings ("extra arguments ignored", verified 2.1.284),
// so no status hooks/feed; the session keeps its own. Ids come from main's
// JSON parse and are re-checked here before being typed into a shell.
export function attachBackground(bgId, name) {
  if (!/^[0-9a-f]{6,64}$/i.test(String(bgId))) return null;
  const label = 'bg-' + String(name || bgId).replace(/[^\w .-]/g, '').trim().slice(0, 18);
  return createTab({ name: nextName(label.replace(/\s+/g, '-')), cwd: repoPath, run: `claude attach ${bgId}` });
}

// A tab rename reaches the running claude as `/rename <ws · name>`, which also
// renames its Remote Control session on the phone (verified 2026-10-01). Only
// sent at a safe moment: the turn is done and nothing was typed since, so it
// never lands inside a half-typed prompt or a dialog. Otherwise it waits for the
// next `done`.
function syncClaudeName(tab) {
  if (!tab.pendingRename || tab.dead || tab.status !== 'done') return;
  if ((tab.lastInputAt || 0) > (tab.doneAt || 0)) return;
  const cmd = `/rename ${tab.pendingRename}`;
  tab.pendingRename = null;
  sendToAgent(tab.id, cmd);
}

// board quick reply: the same path as typing — term.paste (bracketed when the
// app asked for it, so claude takes it as one input), then Enter on its own
// write so it submits instead of landing inside the paste
export function sendToAgent(id, text) {
  const tab = tabs.get(id);
  if (!tab || tab.dead || !text) return false;
  tab.term.paste(text);
  setTimeout(() => { if (tabs.has(id)) vs.ptyWrite(id, '\r'); }, 120);
  return true;
}

async function updateRestartAll() {
  if (updating) return;
  const n = snapshot().length;
  if (!(await confirmBox(
    `Update Claude Code and restart all ${n} terminal${n > 1 ? 's' : ''}?\n\n` +
    'Every agent conversation is resumed automatically on the new version (claude --resume).',
    { ok: 'Update & restart' },
  ))) return;

  updating = true;
  updateSnapshot = snapshot();
  $('#update-log').textContent = '';
  $('#update-status').textContent = '';
  $('#update-modal').classList.remove('hidden');
  try {
    await vs.restartAll(wsId);
  } catch (e) {
    toast('Update failed: ' + (e.message || e), 'err');
    $('#update-modal').classList.add('hidden');
    updating = false;
  }
}

function relaunchFromSnapshot(snap) {
  // drop the dead tab UI, recreate each terminal resuming its conversation
  for (const tab of [...tabs.values()]) removeTab(tab.id, true);
  for (const t of snap) {
    createTab({
      name: t.name,
      cwd: t.cwd || repoPath,
      claude: t.isClaude && !t.claudeSessionId,
      resumeId: t.claudeSessionId || null,
    });
  }
  toast(`All agents relaunched on the updated Claude Code`, 'ok');
}
