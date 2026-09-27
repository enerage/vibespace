import { $, el, toast } from './common.js';

// terminal tabs: each hosts a PowerShell pty; "claude" tabs run Claude Code and
// get their session id tracked (main process) so they can be resumed after updates.

let wsId;
let repoPath;
let persist = () => {};

const tabs = new Map(); // termId -> tab record
let activeId = null;
let updating = false;
let counter = 0;
let updateSnapshot = null;

const TERM_OPTS = {
  fontSize: 13,
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  cursorBlink: true,
  scrollback: 6000,
  theme: {
    background: '#0c0f14',
    foreground: '#d7dee8',
    cursor: '#6e9cff',
    selectionBackground: '#31456e',
    black: '#1a1f28', red: '#f85149', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7dee8',
    brightBlack: '#6b7683', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
  allowProposedApi: true,
};

export function init(opts) {
  wsId = opts.wsId;
  repoPath = opts.repoPath;
  persist = opts.persist || persist;

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
    if ((st === 'waiting' || st === 'done') && activeId !== termId) tab.unread = true;
    renderTabBar();
  });
  vs.onTermFocus((termId) => { if (tabs.has(termId)) activateTab(termId); });

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
      return true; // no selection: let Ctrl+C reach the shell/claude as interrupt
    }
    if (key === 'v') { // Ctrl+V and Ctrl+Shift+V both paste
      ev.preventDefault();
      pasteInto(term);
      return false;
    }
    return true;
  });

  // right-click: copy selection, or paste when nothing is selected
  term.element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      copySelection(term);
      term.clearSelection();
    } else {
      pasteInto(term);
    }
  });
}

export function createTab({ name = 'agent', cwd = repoPath, claude = false, resumeId = null, activate = true, termId = null, attachBuffer = null, savedIsClaude = null, savedSessionId = null, pickSession = false } = {}) {
  const id = termId || newTermId();
  const host = el('div', 'term-host');
  host.style.display = 'none';
  $('#term-hosts').appendChild(host);

  const term = new window.Terminal({ ...TERM_OPTS });
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
  renderTabBar();
  if (activate || tabs.size === 1) activateTab(id);

  if (attachBuffer !== null) {
    // Layer 2: attach to a pty that survived a reload — never spawn, never type a
    // resume command; the agent process kept running the whole time.
    if (attachBuffer) term.write(attachBuffer);
    vs.ptyResize(id, Math.max(term.cols, 20), Math.max(term.rows, 10));
  } else {
    vs.ptyCreate({ termId: id, wsId, cwd, cols: Math.max(term.cols, 20), rows: Math.max(term.rows, 10) })
      .then(info => { tab.hookSettings = info && info.settingsPath; })
      .catch(e => toast('Terminal failed: ' + (e.message || e), 'err'));
  }

  term.onData(d => vs.ptyWrite(id, d));
  wireClipboard(term);
  term.onResize(({ cols, rows }) => vs.ptyResize(id, cols, rows));
  host.addEventListener('mousedown', () => activateTab(id), true);

  if (attachBuffer === null && (claude || resumeId || pickSession)) {
    setTimeout(() => {
      if (!tabs.has(id)) return;
      // --settings injects the status hooks (working/waiting/done signal); it merges
      // with the user's own settings, never replaces them
      const withSettings = (base) => (tab.hookSettings ? `${base} --settings "${tab.hookSettings}"` : base);
      const cmd = pickSession
        ? withSettings('claude --resume') // saved id is dead — interactive picker
        : withSettings(resumeId ? `claude --resume ${resumeId}` : 'claude');
      vs.ptyWrite(id, cmd + '\r');
      vs.claudeStarted(wsId, id);
      if (resumeId) vs.sessionPinned(wsId, id, resumeId);
    }, 900);
  }
  persist();
  return tab;
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
    const st = tab.status || '';
    const status = el('span', 'status' + (tab.sessionId ? ' on' : '') + (st ? ' ' + st : ''));
    status.title = st === 'working' ? 'agent is working'
      : st === 'waiting' ? 'agent is asking for you — permission or question'
      : st === 'done' ? 'task completed — agent is idle'
      : (tab.sessionId ? `session ${tab.sessionId.slice(0, 8)}…` : 'no claude session yet');
    const label = el('span', 'label', tab.name);
    label.title = (tab.sessionId ? `${tab.name} — ${tab.sessionId}` : tab.name) + '  (double-click or right-click to rename)';
    const close = el('span', 'close', '✕');
    close.title = 'close terminal';

    t.append(status, label, close);
    t.onclick = () => activateTab(tab.id);
    t.oncontextmenu = (ev) => { ev.preventDefault(); startRename(t, label, tab); };
    close.onclick = (ev) => {
      ev.stopPropagation();
      const hasAgent = tab.sessionId || !tab.dead;
      if (hasAgent && !confirm(`Close "${tab.name}"?\nIts claude conversation is saved and can be resumed later.`)) return;
      removeTab(tab.id);
    };
    label.ondblclick = (ev) => {
      ev.stopPropagation();
      startRename(t, label, tab);
    };

    bar.appendChild(t);
  }
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
    if (v) tab.name = v;
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

async function updateRestartAll() {
  if (updating) return;
  const n = snapshot().length;
  if (!confirm(
    `Update Claude Code and restart all ${n} terminal${n > 1 ? 's' : ''}?\n\n` +
    'Every agent conversation is resumed automatically on the new version (claude --resume).'
  )) return;

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
