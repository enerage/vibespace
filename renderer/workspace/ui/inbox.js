import { $, el, modKey, osText, toast } from './common.js';
import { ago } from './history.js';
import * as terms from './terms.js';
import { renderMarkdown } from './minimd.js';

// Inbox (📥 / Ctrl+Shift+M): only the text that matters, from EVERY workspace —
// final replies, failed turns, open questions and permission prompts
// (main/inbox.cjs, fed by the claude data feed). An overlay INSIDE #term-hosts
// like the agent board: the terminals keep running and keep their size below.
// List on the left (open questions pinned under "Needs you"), reader on the right.
// Other workspaces' processes write their own files, so this window polls:
// the list every 5 s while open, the unread count every 10 s otherwise.

let wsId = null;
let root = null;
let open = false;
let listEl = null;
let readerEl = null;
let filtersEl = null;
let filter = 'all'; // all | unread | here
let entries = [];
let unread = 0;
let selId = null;
let readerKey = '';
let listKey = '';
let listAt = 0;
let pollTimer = null;
let pulling = false;
let again = false;
const full = new Map(); // id -> full text (list items carry previews)

const KIND = {
  reply: ['✓', 'Reply'],
  failed: ['✕', 'Failed'],
  question: ['?', 'Question'],
  permission: ['🔒', 'Permission'],
};

// ---------- pure helpers ----------
// the first non-empty line, without markdown markers
// (a heading like "## Summary" says nothing: the first line that isn't one)
export function firstLine(s) {
  const lines = String(s || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^(```|~~~|[-*_]{3,}$|\|?[\s:-]+\|)/.test(l));
  const line = lines.find(l => !/^#{1,6}\s/.test(l)) || lines[0] || '';
  return line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/\*\*|__|`/g, '');
}

// who started the turn this reply ends, when it was not you
export function originTag(e) {
  if (e.origin === 'background') return 'woke itself';
  if (e.origin === 'peer') return 'from ' + (e.from || 'another session');
  return '';
}

// open questions/permissions first, then everything else newest first. The
// selected entry stays listed under Unread after it was read.
export function arrange(list, { filter: f = 'all', wsId: here = null, selId: sel = null } = {}) {
  const shown = list.filter(e => (f !== 'unread' || !e.read || e.id === sel) && (f !== 'here' || e.wsId === here));
  const byTime = (a, b) => b.at - a.at;
  return { needs: shown.filter(e => e.open).sort(byTime), rest: shown.filter(e => !e.open).sort(byTime) };
}

const ordered = () => { const a = arrange(entries, { filter, wsId, selId }); return [...a.needs, ...a.rest]; };
const where = (e) => `${e.wsName || e.wsId} · ${e.tabName || e.termId}`;

// ---------- badge ----------
function setBadge(n) {
  unread = Math.max(0, n | 0);
  const b = $('#inbox-badge');
  if (!b) return;
  b.textContent = unread > 99 ? '99+' : String(unread);
  b.classList.toggle('hidden', unread === 0);
  $('#btn-inbox').title = osText(`Inbox — final replies, failures and open questions of every workspace${unread ? ` · ${unread} unread` : ''} (Ctrl+Shift+M)`);
}

// ---------- list ----------
function row(e) {
  const r = el('div', 'ib-row k-' + e.kind + (e.read ? '' : ' unread') + (e.id === selId ? ' sel' : ''));
  r.dataset.id = e.id;
  const [icon, label] = KIND[e.kind] || ['•', e.kind];
  const kind = el('span', 'ib-kind', icon);
  kind.title = label;
  const body = el('div', 'ib-rbody');
  const top = el('div', 'ib-top');
  top.append(el('span', 'ib-where', where(e)));
  const tag = originTag(e);
  if (tag) top.append(el('span', 'ib-tag', tag));
  const time = el('span', 'ib-time', ago(e.at));
  time.title = new Date(e.at).toLocaleString();
  top.append(time);
  body.append(top, el('div', 'ib-first', firstLine(e.preview) || (e.kind === 'reply' ? '(empty reply)' : label)));
  r.append(el('span', 'ib-dot'), kind, body);
  r.onclick = () => select(e.id);
  r.ondblclick = () => openEntry(e);
  return r;
}

function renderList() {
  listAt = Date.now();
  const { needs, rest } = arrange(entries, { filter, wsId, selId });
  listKey = keyOf();
  const top = listEl.scrollTop;
  listEl.innerHTML = '';
  if (needs.length) {
    listEl.append(el('div', 'ib-section needs', `Needs you · ${needs.length}`));
    for (const e of needs) listEl.append(row(e));
    if (rest.length) listEl.append(el('div', 'ib-section', 'Recent'));
  }
  for (const e of rest) listEl.append(row(e));
  if (!needs.length && !rest.length) {
    listEl.append(el('div', 'ib-empty', filter === 'unread' ? 'Nothing unread.' : filter === 'here' ? 'Nothing from this workspace yet.' : 'No replies yet. Agents’ final replies land here.'));
  }
  listEl.scrollTop = top;
  for (const b of filtersEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.f === filter);
}

const keyOf = () => `${filter}|${selId}|` + entries.map(e => `${e.id}${e.read ? 1 : 0}${e.open ? 1 : 0}`).join(',');

// ---------- reader ----------
async function renderReader() {
  const e = entries.find(x => x.id === selId);
  const key = e ? `${e.id}|${e.open ? 1 : 0}` : '';
  if (key === readerKey) return;
  readerKey = key;
  readerEl.innerHTML = '';
  if (!e) { readerEl.append(el('div', 'ib-empty', 'Select an entry to read it.')); return; }
  const [icon, label] = KIND[e.kind] || ['•', e.kind];
  const head = el('div', 'ib-rhead');
  const k = el('span', 'ib-kind k-' + e.kind, icon);
  k.title = label;
  const time = el('span', 'ib-time', ago(e.at));
  time.title = new Date(e.at).toLocaleString();
  head.append(k, el('span', 'ib-where', where(e)), time);
  const tag = originTag(e);
  if (tag) head.append(el('span', 'ib-tag', tag));
  // actions in the header: a long reply would push them out of sight
  const go = el('button', 'btn small primary', e.wsId === wsId ? 'Open tab' : `Open ${e.wsName || 'workspace'}`);
  go.title = 'Enter';
  go.onclick = () => openEntry(e);
  const un = el('button', 'btn small ghost', 'Mark unread');
  un.onclick = () => markUnread(e);
  head.append(el('span', 'spacer'), go, un);
  readerEl.append(head);
  if (e.origin === 'you' && e.prompt) {
    const asked = el('div', 'ib-asked');
    asked.append(el('span', 'ib-asked-label', 'You asked: '), el('span', '', firstLine(e.prompt)));
    asked.title = e.prompt;
    readerEl.append(asked);
  }
  if (e.open) readerEl.append(el('div', 'ib-wait', e.kind === 'permission' ? 'Waiting for your approval in the terminal' : 'Waiting for your answer in the terminal'));
  const text = el('div', 'ib-text md');
  // renderMarkdown escapes every piece of the text before adding its own tags
  text.innerHTML = renderMarkdown(full.get(e.id) ?? e.preview ?? '');
  readerEl.append(text);
  readerEl.scrollTop = 0;
  if (e.long && !full.has(e.id)) {
    const got = await vs.inboxGet(e.id).catch(() => null);
    if (!got || typeof got.text !== 'string') return;
    full.set(e.id, got.text);
    if (selId === e.id && text.isConnected) text.innerHTML = renderMarkdown(got.text);
  }
}

// ---------- actions ----------
// a click reads at once; arrowing past a row reads it only if you stay on it
let dwellTimer = null;
function markReadNow(e) {
  if (e.read) return;
  e.read = true;
  setBadge(unread - 1);
  vs.inboxMarkRead([e.id]).catch(() => {});
  if (open) renderList();
}

function select(id, { dwell = false } = {}) {
  const e = entries.find(x => x.id === id);
  if (!e) return;
  selId = id;
  clearTimeout(dwellTimer);
  if (!dwell) markReadNow(e);
  else if (!e.read) dwellTimer = setTimeout(() => { if (selId === id) markReadNow(e); }, 1500);
  renderList();
  renderReader();
  listEl.querySelector('.ib-row.sel')?.scrollIntoView({ block: 'nearest' });
}

function markUnread(e) {
  if (!e.read) return;
  e.read = false;
  setBadge(unread + 1);
  vs.inboxMarkUnread(e.id).catch(() => {});
  renderList();
}

async function markAll() {
  for (const e of entries) e.read = true;
  setBadge(0);
  renderList();
  await vs.inboxMarkAllRead().catch(() => {});
  pull();
}

function openEntry(e) {
  if (e.wsId === wsId) {
    if (!terms.agents().some(a => a.id === e.termId)) { toast(`${e.tabName || 'That tab'} is closed`, ''); return; }
    close();
    terms.activate(e.termId);
    return;
  }
  // another workspace: focus (or start) its window, the board's path
  vs.boardFocus(e.wsId).then((r) => {
    if (r && r.ok) toast(`Switching to ${e.wsName || e.wsId}…`, 'ok');
    else toast('That workspace no longer exists', 'err');
  }).catch(() => {});
  close();
}

function step(d) {
  const list = ordered();
  if (!list.length) return;
  const i = list.findIndex(e => e.id === selId);
  const next = i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d));
  select(list[next].id, { dwell: true });
}

// ---------- polling ----------
async function pull() {
  if (pulling) { again = true; return; }
  pulling = true;
  try {
    if (open) {
      const r = await vs.inboxList().catch(() => null);
      if (r && Array.isArray(r.entries)) {
        entries = r.entries;
        setBadge(r.unread);
        if (open && (keyOf() !== listKey || Date.now() - listAt > 30000)) renderList();
        if (open) renderReader();
      }
    } else {
      const r = await vs.inboxCount().catch(() => null);
      if (r && typeof r.unread === 'number') setBadge(r.unread);
    }
  } finally {
    pulling = false;
  }
  if (again) { again = false; pull(); }
}

// skips while the window is hidden (minimized OR occluded); visibilitychange
// runs it once when it shows again
function schedule() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await pull();
    schedule();
  }, open ? 5000 : 10000);
}

// ---------- open / close ----------
export function toggle() { if (open) close(); else show(); }

function show() {
  if (open) return;
  open = true;
  root.classList.remove('hidden');
  $('#btn-inbox')?.classList.add('active');
  listKey = '';
  readerKey = null; // never equal to a real key: the empty-reader hint renders too
  // the whole window below the top bar, not just the terminal pane
  root.style.top = Math.round($('#topbar').getBoundingClientRect().bottom) + 'px';
  renderList();
  renderReader();
  root.focus(); // keys work only while focus is in the inbox
  pull();
  schedule();
}

function close() {
  if (!open) return;
  open = false;
  root.classList.add('hidden');
  $('#btn-inbox')?.classList.remove('active');
  schedule();
  const id = terms.activeTermId();
  if (id) terms.activate(id); // focus back to the terminal
}

export function init(opts) {
  wsId = opts.wsId;
  root = $('#inbox');
  root.tabIndex = -1;
  const head = el('div', 'board-head');
  head.append(el('span', 'board-title', 'Inbox'));
  filtersEl = el('span', 'ib-filters');
  for (const [f, label] of [['all', 'All'], ['unread', 'Unread'], ['here', 'This workspace']]) {
    const b = el('button', 'btn small ghost', label);
    b.dataset.f = f;
    b.onclick = () => { filter = f; renderList(); root.focus(); };
    filtersEl.append(b);
  }
  head.append(filtersEl, el('span', 'board-hint', '↑/↓ select · Enter opens the tab · Esc closes'));
  const all = el('button', 'btn small ghost', 'Mark all read');
  all.onclick = markAll;
  const x = el('button', 'btn small ghost', '✕');
  x.title = osText('Close the inbox (Ctrl+Shift+M)');
  x.onclick = close;
  head.append(el('span', 'spacer'), all, x);
  const body = el('div', 'ib-body');
  listEl = el('div', 'ib-list');
  readerEl = el('div', 'ib-reader');
  body.append(listEl, readerEl);
  root.append(head, body);

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.target instanceof Element && e.target.closest('input, textarea, button')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Enter') {
      const sel = entries.find(x => x.id === selId);
      if (sel) { e.preventDefault(); openEntry(sel); }
    }
  });
  $('#btn-inbox').onclick = toggle;
  document.addEventListener('keydown', (e) => {
    // capture + stopPropagation: xterm must not also see the key
    if (modKey(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); e.stopPropagation(); toggle(); }
    // the board opens underneath the inbox: make way for it
    else if (open && modKey(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') close();
  }, true);
  $('#btn-board')?.addEventListener('click', () => close(), true);
  vs.onInboxChanged(() => { if (!document.hidden) pull(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  setBadge(0);
  pull(); // once at start, hidden or not
  schedule();
}
