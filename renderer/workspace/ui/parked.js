import { el, showMenu, menuOpen } from './common.js';
import { wtText } from './feedui.js';

// Parked agents (0.6.38). Park stops an agent and keeps its conversation on ONE
// shelf (state.json `parked`, newest first); Unpark resumes that exact
// conversation in a new tab. terms.js owns the list and the park / unpark /
// forget flows. This module holds the pure helpers (smoke imports them) and the
// shelf's UI pieces: the 🅿 chip, the menu rows (caret menu's Resume section and
// the chip's list) and the hover card (also used by the board's Parked strip).

export const MAX_LAST = 2000; // chars of the last reply kept with an entry
export const MENU_MAX = 10; // rows in the caret menu, then "More parked…"

// ---------- pure helpers ----------
// a valid shelf: entries with a conversation id, one per conversation, newest first
export function normalizeParked(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.claudeSessionId !== 'string' || !e.claudeSessionId) continue;
    if (seen.has(e.claudeSessionId)) continue;
    seen.add(e.claudeSessionId);
    out.push({ ...e, id: String(e.id || 'p_' + e.claudeSessionId.slice(0, 8)), name: String(e.name || 'agent'), parkedAt: Number(e.parkedAt) || 0 });
  }
  return out.sort((a, b) => b.parkedAt - a.parkedAt);
}

// saved tabs to restore. Parked entries are never auto-resumed; a tab whose
// conversation is ALSO parked (a crash between "entry saved" and "tab
// killed") is skipped too: the shelf wins, so it can't come back twice.
export function restorable(terminals, parked) {
  const sids = new Set(normalizeParked(parked).map(e => e.claudeSessionId));
  return (Array.isArray(terminals) ? terminals : [])
    .filter(t => t && t.name && !(t.claudeSessionId && sids.has(t.claudeSessionId)));
}

// keep the parked name; -2, -3… only when an open tab already has it
export function uniqueName(name, taken) {
  const set = taken instanceof Set ? taken : new Set(taken || []);
  if (!set.has(name)) return name;
  let i = 2;
  while (set.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}

export function makeEntry(tab, { lastMessage = null, model = null, now = Date.now() } = {}) {
  return {
    id: 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: tab.name,
    cwd: tab.cwd,
    isClaude: true,
    claudeSessionId: tab.sessionId,
    worktree: tab.worktree || null,
    account: tab.account || null,
    accountAt: tab.accountAt || 0,
    family: tab.family || null, // the conversation's provider: unpark resumes only on that family
    parkedAt: now,
    lastMessage: typeof lastMessage === 'string' && lastMessage.trim() ? lastMessage.trim().slice(0, MAX_LAST) : null,
    model: model || null, // display name of the model it last ran on (card only)
    modelArg: tab.model || null, // the tab's chosen/switched model (terms.js tab.model): unpark keeps it
  };
}

// `5d` for menu rows
export function agoShort(at, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

// `parked 5 days ago` for the card
export function agoLong(at, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  const n = (v, unit) => `parked ${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (m < 1) return 'parked just now';
  if (m < 60) return n(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return n(h, 'hour');
  return n(Math.floor(h / 24), 'day');
}

export function metaText(e, now = Date.now()) {
  return (e.worktree && e.worktree.branch ? `⎇ ${e.worktree.branch} · ` : '') + agoShort(e.parkedAt, now);
}

// ---------- UI ----------
let ctx = null; // { list(), unpark(id), forget(id) } from terms.js
let chip = null;

// hover card: name, ⎇ branch, model, "parked 5 days ago", the last reply
export function cardFor(e) {
  const box = el('div', 'pk-card');
  const head = el('div', 'fu-head');
  head.append(el('span', 'pk-glyph', '🅿'), el('span', 'fu-name', e.name), el('span', 'fu-state', agoLong(e.parkedAt)));
  box.append(head);
  if (e.worktree) box.append(el('div', 'fu-wt', wtText(e.worktree)));
  if (e.model) {
    const meta = el('div', 'fu-meta');
    meta.append(el('span', '', e.model));
    box.append(meta);
  }
  // the whole reply (≤ 2000 chars); the box shows ~12 lines and scrolls
  if (e.lastMessage) box.append(el('pre', 'fu-reply pk-reply', e.lastMessage));
  else box.append(el('div', 'fu-foot', 'No reply recorded'));
  box.append(el('div', 'fu-foot', 'Click to resume it · ✕ forgets it (still in All conversations…)'));
  return box;
}

// rows for showMenu: click = unpark, ✕ = forget, hover = card
export function menuItems(list, { max = Infinity, more = null } = {}) {
  const rows = list.slice(0, max).map(e => ({
    label: `🅿 ${e.name}`,
    meta: metaText(e),
    card: () => cardFor(e),
    run: () => ctx.unpark(e.id),
    action: { label: '✕', hint: "Forget: take it off the shelf. The conversation stays in Claude's history (All conversations…)", run: () => ctx.forget(e.id) },
  }));
  if (list.length > max && more) rows.push({ label: `More parked… (${list.length - max})`, run: more });
  return rows;
}

export function openList(anchorRect, { hover = false } = {}) {
  const list = ctx ? ctx.list() : [];
  if (!list.length) return;
  const r = anchorRect || chip.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [{ section: `Parked · ${list.length}` }, ...menuItems(list)], hover ? { leaveClose: [chip] } : {});
}

export function chipEl() { return chip; }

export function paintChip() {
  if (!chip || !ctx) return;
  const n = ctx.list().length;
  chip.textContent = `🅿 ${n}`;
  chip.classList.toggle('hidden', n === 0);
}

export function init(opts) {
  ctx = opts;
  chip = el('span', 'parked-chip hidden');
  chip.title = 'Parked agents: stopped, conversation kept. Click one to resume it.';
  let hoverTimer = null;
  chip.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (!menuOpen()) openList(null, { hover: true }); }, 300);
  });
  chip.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
  chip.addEventListener('mousedown', (e) => e.stopPropagation()); // not a tab drag
  chip.addEventListener('click', (e) => { e.stopPropagation(); clearTimeout(hoverTimer); openList(); });
}
