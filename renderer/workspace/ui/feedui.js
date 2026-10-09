import { $, el } from './common.js';

// Detail layer on top of the terminal tabs, fed by the claude data feed
// (main/claudefeed.cjs → term:feed). The status files stay the BASE state
// (working/waiting/done lights); everything here only adds detail, and a tab
// without a feed (plain terminal, agent started before the feed existed) looks
// exactly as before: no strip, no pill, no peek.
//   - activity strip: a status bar below the active terminal
//   - peek card: hover a tab ~350 ms (or click the strip's reply text)
//   - task checklist popover: click the strip's tasks part

let ctx = null; // { getTab(id), getFeed(id), activeId() } from terms.js
let stripEl = null;
let stripTimer = null;
let peekEl = null;
let peekId = null; // termId the peek card shows
let peekPinned = false; // opened by click: no hover-out close
let openTimer = null;
let closeTimer = null;
let listEl = null;
let listOpen = false;

// ---------- pure helpers (terms.js uses them for the light + pill) ----------
const DAY = 86400000;

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtAgo(at) {
  const ms = Date.now() - at;
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

// tasks (TaskCreate/Update) win over TodoWrite todos
export function taskItems(f) {
  if (!f) return [];
  if (Array.isArray(f.tasks) && f.tasks.length) {
    return f.tasks.map(t => ({ text: t.subject || `task ${t.id}`, status: t.status, activeForm: t.activeForm || null }));
  }
  return (f.todos || []).map(t => ({ text: t.content, status: t.status, activeForm: t.activeForm || null }));
}

// `3/7` pill: hidden with no tasks, or when all are done and the turn ended > 1 min ago
export function pillText(f, baseStatus) {
  const items = taskItems(f);
  if (!items.length) return '';
  const done = items.filter(t => t.status === 'completed').length;
  if (done === items.length && baseStatus !== 'working' && f.turnEndedAt && Date.now() - f.turnEndedAt > 60000) return '';
  return `${done}/${items.length}`;
}

// worktree tab line: `⎇ vs/agent-5 · from main` (a detached base shows its short sha)
export function wtText(wt) {
  if (!wt || !wt.branch) return '';
  const base = /^[0-9a-f]{40}$/i.test(wt.base || '') ? wt.base.slice(0, 7) : wt.base;
  return `⎇ ${wt.branch}` + (base ? ` · from ${base}` : '');
}

const reasonText = (f) => (f && f.reason ? f.reason.replace(/^is /, '') : '');

// ---------- background work (feed.background, from claude's Stop hook) ----------
// The turn can end while subagents or shell commands it started are still
// running. That is its own state: not working (the main thread is idle), not
// done (it continues by itself when they finish), and not waiting on the user.
export function bgTasks(f, baseStatus) {
  if (!f || f.failure || baseStatus !== 'done' || !Array.isArray(f.background)) return [];
  return f.background;
}
const bgOne = (t) => (t.type === 'shell'
  ? `shell: ${t.command || t.description || '?'}`
  : `${t.type === 'subagent' ? 'subagent' : t.type}: ${t.description || t.agentType || '?'}`);
// "2 in background: subagent: Research X, shell: npm test"
export function bgText(tasks, max = 2) {
  if (!tasks.length) return '';
  const shown = tasks.slice(0, max).map(bgOne).join(', ');
  return `${tasks.length} in background: ${shown}${tasks.length > max ? `, +${tasks.length - max} more` : ''}`;
}
// only shells: could be a test run (claude continues) or a dev server (it never ends)
export const bgOnlyShells = (tasks) => tasks.length > 0 && tasks.every(t => t.type === 'shell');
function bgTitle(tasks) {
  return 'Turn finished, still running in the background:\n'
    + tasks.slice(0, 8).map(t => '• ' + bgOne(t)).join('\n')
    + (bgOnlyShells(tasks)
      ? '\nClaude continues by itself when a command ends. A server that never ends keeps this light on.'
      : '\nClaude continues by itself when they finish. It is not waiting on you.');
}

// ---------- internet outage (feed.net, main/index.cjs netFailure) ----------
// The turn failed because the API can't be reached. Not a failure to act on:
// main probes the network and the tab continues by itself when it's back.
export const NET_TITLE = "Internet down — continues automatically when it's back";
export function netWaiting(f) {
  return Boolean(f && f.net);
}

// extra light class on top of the base status: failed regardless of base (a
// StopFailure fires no Stop hook), perm/question only while base says waiting,
// bg while the turn is done but background work is still running
export function lightDetail(f, baseStatus) {
  if (!f) return { cls: '', title: '' };
  if (f.net) return { cls: 'net', title: NET_TITLE };
  if (f.failure) return { cls: 'failed', title: reasonText(f) };
  const bg = bgTasks(f, baseStatus);
  if (bg.length) return { cls: 'bg', title: bgTitle(bg) };
  if (baseStatus === 'waiting') {
    if (f.attention === 'permission') return { cls: 'perm', title: reasonText(f) };
    if (f.attention === 'question') return { cls: 'question', title: reasonText(f) };
    if (f.reason) return { cls: '', title: reasonText(f) };
  }
  return { cls: '', title: '' };
}

// one state line, shared by the strip and the peek card
function stateLine(tab, f) {
  const st = tab.status || '';
  if (f.net) return { cls: 'net', text: "waiting for the internet · continues automatically when it's back", time: fmtAgo(f.net.failedAt || f.net.since || Date.now()) };
  if (f.failure) return { cls: 'failed', text: reasonText(f), time: fmtAgo(f.failure.at) };
  if (st === 'waiting') return { cls: 'waiting', text: reasonText(f) || 'needs your input', time: '' };
  if (f.compacting) return { cls: 'working', text: 'compacting context…', time: f.compacting.at ? fmtElapsed(Date.now() - f.compacting.at) : '' };
  if (st !== 'done' && (st === 'working' || f.nowDoing)) {
    const doing = f.nowDoing ? [f.nowDoing.tool, f.nowDoing.detail].filter(Boolean).join(' ') : 'thinking…';
    return { cls: 'working', text: doing, time: f.turnStartedAt ? fmtElapsed(Date.now() - f.turnStartedAt) : '' };
  }
  const bg = bgTasks(f, st);
  if (bg.length) {
    const now = f.bgNow ? ' · ' + [f.bgNow.tool, f.bgNow.detail].filter(Boolean).join(' ') : '';
    return { cls: 'bg', text: bgText(bg) + now, time: f.turnEndedAt ? fmtElapsed(Date.now() - f.turnEndedAt) : '' };
  }
  return { cls: 'done', text: f.turnEndedAt ? `done ${fmtAgo(f.turnEndedAt)}` : 'idle', time: '' };
}

// ---------- prompt cache (statusLine prompt_cache) ----------
// expires_at is an ABSOLUTE epoch-seconds deadline = the last API request + ttl
// (verified live: every request moves it to now + 3600 s on a 1 h-ttl account),
// so the countdown is plain client-side math, no refresh needed.
export function cacheInfo(pc, nowMs = Date.now()) {
  if (!pc || typeof pc.expiresAt !== 'number') return null;
  const left = Math.floor(pc.expiresAt - nowMs / 1000);
  if (!pc.warm || left <= 0) return { state: 'cold', left: 0, text: 'cache cold', amber: false };
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sec = String(left % 60).padStart(2, '0');
  return { state: 'warm', left, text: `cache warm · ${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${sec}`, amber: left <= 60 };
}

function paintCache(chip) {
  const info = cacheInfo({ warm: chip.dataset.warm === '1', expiresAt: Number(chip.dataset.exp) });
  if (!info) return;
  chip.textContent = info.text;
  chip.className = 'fu-cache ' + (info.state === 'cold' ? 'cold' : info.amber ? 'amber' : 'warm');
  chip.title = info.state === 'cold'
    ? 'Prompt cache expired: the next message re-reads the whole context (slower and costlier)'
    : `Prompt cache warm until ${new Date(Number(chip.dataset.exp) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: replying before then reuses the cached context (fast, cheap)`;
}

// chip for a finished agent's cache; null while it works or with no data.
// One global 1 s ticker repaints every chip in place (strip, peek, board).
export function cacheChip(f, working) {
  if (working || !f || !f.promptCache || typeof f.promptCache.expiresAt !== 'number') return null;
  const chip = el('span', 'fu-cache');
  chip.dataset.exp = String(f.promptCache.expiresAt);
  chip.dataset.warm = f.promptCache.warm ? '1' : '0';
  paintCache(chip);
  return chip;
}
if (typeof document !== 'undefined') { // (smoke imports the pure helpers in main)
  setInterval(() => { for (const c of document.querySelectorAll('.fu-cache[data-exp]')) paintCache(c); }, 1000);
}

// idle + context ≥ 85 %: claude will auto-compact (summarise) soon
export function compactSoon(f, working) {
  return Boolean(!working && f && !f.compacting && f.context && f.context.pct >= 85);
}

const firstLine = (s) => (s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
const level = (pct) => (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : 'ok');

function ctxBar(c) {
  const wrap = el('span', 'fu-ctx');
  const bar = el('span', 'lim-bar');
  const fill = el('span', 'lim-fill ' + level(c.pct));
  fill.style.width = Math.max(0, Math.min(100, c.pct)) + '%';
  bar.append(fill);
  wrap.append(bar, el('span', 'fu-pct', Math.round(c.pct) + '%'));
  return wrap;
}

function taskList(items, max) {
  const ul = el('div', 'fu-tasks');
  for (const t of items.slice(0, max)) {
    const row = el('div', 'fu-task ' + (t.status || 'pending'));
    const glyph = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○';
    row.append(el('span', 'fu-glyph', glyph), el('span', 'fu-ttext', t.status === 'in_progress' && t.activeForm ? t.activeForm : t.text));
    ul.append(row);
  }
  if (items.length > max) ul.append(el('div', 'fu-more', `+${items.length - max} more`));
  return ul;
}

// ---------- activity strip ----------
export function refresh() {
  if (!stripEl || !ctx) return;
  clearTimeout(stripTimer);
  const id = ctx.activeId();
  const tab = id && ctx.getTab(id);
  const f = tab && ctx.getFeed(id);
  // a tab without a feed has no strip, unless it carries a note (its
  // conversation runs as a Claude background job: terms.js noteBackground)
  const note = tab && !f ? tab.bgNote : null;
  // show/hide only on change: #term-hosts' ResizeObserver then refits xterm
  // once (throttled in terms.js) — never per feed tick
  const show = Boolean(f || note);
  if (stripEl.classList.contains('hidden') === show) stripEl.classList.toggle('hidden', !show);
  if (!show) { closeList(); return; }
  if (note) { closeList(); paintNote(tab, note); return; }
  const line = stateLine(tab, f);
  stripEl.className = 'st-' + line.cls;
  stripEl.innerHTML = '';
  stripEl.append(el('span', 'ts-dot'), el('span', 'ts-name', tab.name), el('span', 'ts-sep', '·'));
  if (tab.worktree) stripEl.append(el('span', 'ts-wt', wtText(tab.worktree)), el('span', 'ts-sep', '·'));
  const text = el('span', 'ts-text', line.text);
  stripEl.append(text);
  if (line.time) stripEl.append(el('span', 'ts-sep', '·'), el('span', 'ts-time', line.time));
  if (line.cls === 'bg') text.title = lightDetail(f, tab.status).title;
  if ((line.cls === 'done' || line.cls === 'bg') && f.lastMessage) {
    const reply = el('span', 'ts-reply', `“${firstLine(f.lastMessage)}”`);
    reply.title = 'Show the last reply';
    reply.onclick = (e) => { e.stopPropagation(); openPeek(id, { pinned: true }); };
    stripEl.append(el('span', 'ts-sep', '·'), reply);
  }
  stripEl.append(el('span', 'spacer'));
  const chip = cacheChip(f, line.cls === 'working' || line.cls === 'waiting');
  if (chip) stripEl.append(chip);
  if (compactSoon(f, line.cls === 'working')) {
    const hint = el('span', 'ts-hint', 'auto-compact soon');
    hint.title = 'Context is 85 %+ full: claude will soon compact it automatically (summarises the conversation so far)';
    stripEl.append(hint);
  }
  if (f.context && typeof f.context.pct === 'number') stripEl.append(ctxBar(f.context));
  if (f.model && f.model.name) stripEl.append(el('span', 'ts-model', f.model.name));
  const items = taskItems(f);
  if (items.length) {
    const done = items.filter(t => t.status === 'completed').length;
    const tasks = el('span', 'ts-tasks', `${done}/${items.length} tasks`);
    tasks.title = 'Show the task checklist';
    tasks.onclick = (e) => { e.stopPropagation(); toggleList(tasks); };
    stripEl.append(tasks);
    if (listOpen) renderList(tasks);
  } else {
    closeList();
  }
  if (f.subagents > 0) stripEl.append(el('span', 'ts-sub', `${f.subagents} subagent${f.subagents > 1 ? 's' : ''}`));
  // timers tick here, not per feed tick: 1 s while working (or background work runs), 30 s otherwise
  stripTimer = setTimeout(refresh, line.cls === 'working' || line.cls === 'bg' ? 1000 : 30000);
}

// note = { text, job }: job → an Attach link (the board's `claude attach` path)
function paintNote(tab, note) {
  stripEl.className = 'st-note';
  stripEl.innerHTML = '';
  const text = el('span', 'ts-text', note.text);
  text.title = note.text;
  stripEl.append(el('span', 'ts-dot'), el('span', 'ts-name', tab.name), el('span', 'ts-sep', '·'), text, el('span', 'spacer'));
  if (note.job && ctx.attach) {
    const a = el('span', 'ts-action', 'Attach');
    a.title = `Watch it in a new tab (claude attach ${note.job}); it keeps running when you close that tab`;
    a.onclick = (e) => { e.stopPropagation(); ctx.attach(note.job, tab.name); };
    stripEl.append(a);
  }
}

// ---------- task checklist popover ----------
function renderList(anchor) {
  const id = ctx.activeId();
  const f = id && ctx.getFeed(id);
  const items = taskItems(f);
  if (!items.length) { closeList(); return; }
  listEl.innerHTML = '';
  const done = items.filter(t => t.status === 'completed').length;
  listEl.append(el('div', 'fu-head', `Tasks · ${done}/${items.length} done`), taskList(items, 200));
  listEl.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = listEl.offsetWidth;
  listEl.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  // the strip is a bottom status bar: open upward when there's no room below
  const h = listEl.offsetHeight;
  const below = r.bottom + 4;
  listEl.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below) + 'px';
}

function toggleList(anchor) {
  if (listOpen) { closeList(); return; }
  listOpen = true;
  renderList(anchor);
}

function closeList() {
  listOpen = false;
  if (listEl) listEl.classList.add('hidden');
}

// ---------- peek card ----------
function renderPeek() {
  const tab = peekId && ctx.getTab(peekId);
  const f = tab && ctx.getFeed(peekId);
  if (!f) { closePeek(); return; }
  const line = stateLine(tab, f);
  peekEl.innerHTML = '';
  const head = el('div', 'fu-head');
  head.append(el('span', 'fu-dot st-' + line.cls), el('span', 'fu-name', tab.name), el('span', 'fu-state', line.text + (line.time ? ` · ${line.time}` : '')));
  peekEl.append(head);
  if (tab.worktree) peekEl.append(el('div', 'fu-wt', wtText(tab.worktree)));
  const meta = el('div', 'fu-meta');
  if (f.model && f.model.name) meta.append(el('span', '', f.model.name));
  if (f.context && typeof f.context.pct === 'number') meta.append(ctxBar(f.context));
  if (typeof f.cost === 'number') meta.append(el('span', '', '$' + f.cost.toFixed(2)));
  const pchip = cacheChip(f, line.cls === 'working' || line.cls === 'waiting');
  if (pchip) meta.append(pchip);
  if (meta.childNodes.length) peekEl.append(meta);
  if (f.nowDoing && line.cls !== 'done' && line.cls !== 'bg') peekEl.append(el('div', 'fu-doing', 'Now: ' + [f.nowDoing.tool, f.nowDoing.detail].filter(Boolean).join(' ')));
  if (line.cls === 'bg') {
    const box = el('div', 'fu-bg');
    for (const t of bgTasks(f, tab.status).slice(0, 8)) box.append(el('div', '', '• ' + bgOne(t)));
    peekEl.append(box);
  }
  const items = taskItems(f);
  if (items.length) peekEl.append(taskList(items, 8));
  if (f.lastMessage) {
    const lines = f.lastMessage.split(/\r?\n/);
    peekEl.append(el('pre', 'fu-reply', lines.slice(0, 12).join('\n') + (lines.length > 12 ? '\n…' : '')));
  }
  if (f.turnEndedAt) peekEl.append(el('div', 'fu-foot', `turn ended ${fmtAgo(f.turnEndedAt)}`));
}

function placePeek() {
  const tabEl = document.querySelector(`#tabs .tab[data-term-id="${CSS.escape(peekId)}"]`);
  const r = tabEl ? tabEl.getBoundingClientRect() : $('#tabbar').getBoundingClientRect();
  const w = peekEl.offsetWidth;
  const h = peekEl.offsetHeight;
  peekEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  // under the tab; flip above when there's no room (terminals docked low)
  const below = r.bottom + 4;
  peekEl.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below) + 'px';
}

function openPeek(id, { pinned = false } = {}) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  if (!ctx.getFeed(id)) return; // no feed → no card (pre-feed agents, plain shells)
  if (document.body.classList.contains('dragging') || document.querySelector('#tabs .rename')) return;
  peekId = id;
  peekPinned = pinned;
  renderPeek();
  if (!peekId) return;
  peekEl.classList.remove('hidden');
  placePeek();
}

function closePeek() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  peekId = null;
  peekPinned = false;
  if (peekEl) peekEl.classList.add('hidden');
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closePeek, 250); // grace: the pointer can travel into the card
}

// ---------- wiring ----------
export function onFeed(termId) {
  if (termId === ctx.activeId()) refresh();
  if (termId === peekId) { renderPeek(); if (peekId) placePeek(); }
}

export function init(opts) {
  ctx = opts;
  stripEl = $('#term-strip');
  peekEl = el('div', 'fu-pop fu-peek hidden');
  listEl = el('div', 'fu-pop fu-list hidden');
  document.body.append(peekEl, listEl);
  // popovers never take focus from the terminal
  for (const p of [peekEl, listEl]) p.addEventListener('mousedown', (e) => e.preventDefault());

  // hover a tab → peek. Delegated on #tabs: the bar is rebuilt often, so
  // per-element listeners would be lost mid-hover.
  const bar = $('#tabs');
  bar.addEventListener('mouseover', (e) => {
    const t = e.target.closest('.tab');
    if (!t || e.target.closest('.close')) return;
    const id = t.dataset.termId;
    if (id === peekId) { clearTimeout(closeTimer); return; }
    clearTimeout(openTimer);
    openTimer = setTimeout(() => openPeek(id), 350);
  });
  bar.addEventListener('mouseout', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    const to = e.relatedTarget;
    if (to && (t.contains(to) || peekEl.contains(to))) return;
    clearTimeout(openTimer);
    if (peekId && !peekPinned) scheduleClose();
  });
  // a tab click (or drag start) closes it — capture, before the tab handlers
  bar.addEventListener('mousedown', () => closePeek(), true);
  peekEl.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  peekEl.addEventListener('mouseleave', () => scheduleClose());

  // Escape closes an open popover and is consumed — otherwise it would also
  // reach claude in the focused terminal and interrupt the agent
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!peekId && !listOpen)) return;
    e.preventDefault();
    e.stopPropagation();
    closePeek();
    closeList();
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (listOpen && !listEl.contains(e.target) && !e.target.closest('.ts-tasks')) closeList();
    if (peekPinned && !peekEl.contains(e.target) && !e.target.closest('.ts-reply')) closePeek();
  }, true);
  window.addEventListener('resize', () => { closePeek(); closeList(); });
}
