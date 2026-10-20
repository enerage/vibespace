'use strict';
// Inbox: the text that matters from every agent, across ALL workspaces — final
// replies, failed turns, open questions and permission prompts. A final reply
// otherwise gets buried in the terminal under tool lines, background wake-ups
// and turns another session started. Fed from the claude data feed's hooks
// (index.cjs claudefeed.onHook); the feed itself stays the live truth.
//   - <dataRoot>/inbox/<wsId>.json = { wsId, wsName, updatedAt, entries[] },
//     written only by the process that owns the workspace: atomic, at most once
//     per second, capped (300 entries, 30 days). Unlike board files these STAY
//     after the window closes: the inbox is history.
//   - <dataRoot>/inbox-read.json = { read: { [entryId]: atMs } }, machine-wide.
//     Every process may write it, so each write re-reads and merges first.
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');
const logger = require('./logger.cjs');

const MAX_ENTRIES = 300;
const MAX_AGE = 30 * 24 * 3600 * 1000;
const TEXT_MAX = 30000;
const PROMPT_MAX = 300;
const PREVIEW_MAX = 300;
const LIST_MAX = 500;
const MIN_GAP = 1000;

const dir = () => path.join(U.dataRoot(), 'inbox');
const fileFor = (wsId) => path.join(dir(), `${wsId}.json`);
const readFile = () => path.join(U.dataRoot(), 'inbox-read.json');

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (v) => (typeof v === 'string' ? v : '');

// ---------- pure: hook → entries ----------
// Who started the turn: claude waking itself for a finished background task,
// another claude session messaging this one, or you.
function originOf(prompt) {
  const p = str(prompt).trimStart();
  if (p.startsWith('<task-notification>')) return 'background';
  if (p.startsWith('<cross-session-message')) return 'peer';
  return 'you';
}

// the sender's name of a cross-session message (seen: from-name="vibespace-e2")
function peerName(prompt) {
  const m = /^\s*<cross-session-message\b[^>]*?\bfrom-name=\\?"([^"\\]{1,80})\\?"/.exec(str(prompt));
  return m ? m[1] : null;
}

// a failed turn: the error kind, its details, and claude's own message (a
// usage limit says "You've hit your weekly limit · resets …" there)
function failureText(body) {
  const kind = str(body.error) || str(body.error_type);
  const det = str(body.error_details).trim()
    || (body.error_details && typeof body.error_details === 'object' ? str(body.error_details.message).trim() : '');
  const msg = str(body.last_assistant_message).trim() || str(body.message).trim();
  const parts = [`Turn failed: ${kind ? kind.replace(/_/g, ' ') : 'unknown error'}`];
  for (const p of [det, msg]) if (p && !parts.includes(p)) parts.push(p);
  return clip(parts.join('\n\n'), TEXT_MAX);
}

// AskUserQuestion's tool_input: { questions: [{ question, header, options: [{ label }] }] }
function questionText(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  const out = qs.map((q) => {
    const head = str(q && q.question).trim() || str(q && q.header).trim() || 'Question';
    const opts = (q && Array.isArray(q.options) ? q.options : [])
      .map(o => str(o && o.label).trim()).filter(Boolean).map(l => `- ${l}`);
    return [head, ...opts].join('\n');
  });
  return clip(out.join('\n\n') || 'Asks you a question', TEXT_MAX);
}

// a permission prompt in one short line: the tool + its most telling input
function permissionText(body) {
  const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {};
  const what = str(input.command) || str(input.file_path) || str(input.notebook_path) || str(input.path)
    || str(input.url) || str(input.pattern) || str(input.query) || str(input.description);
  const detail = clip(what.replace(/\s+/g, ' ').trim(), 300);
  const tool = str(body.tool_name) || 'a tool';
  return detail ? `${tool}: ${detail}` : tool;
}

function newState() {
  return { entries: [], prompts: {} }; // prompts: termId -> { text, origin, from }
}

// drop entries older than 30 days, then keep the newest 300 (entries are in
// arrival order, oldest first)
function capEntries(entries, now) {
  const kept = entries.filter(e => now - e.at <= MAX_AGE);
  return kept.length > MAX_ENTRIES ? kept.slice(kept.length - MAX_ENTRIES) : kept;
}

// an answered / gone dialog is no longer news: its id goes to `into` (read)
function closeOpen(entries, termId, into = null) {
  let closed = false;
  const next = entries.map((e) => {
    if (!e.open || e.termId !== termId) return e;
    closed = true;
    if (into) into.push(e.id);
    return { ...e, open: false };
  });
  return closed ? next : entries;
}

let seq = 0;
const makeId = (wsId, now) => `${wsId}-${now.toString(36)}-${(seq++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ev = { wsId, wsName, termId, tabName, event, body, now, id? }
// → { state, read: [entry ids to mark read machine-wide], changed }
function reduce(state, ev) {
  const s = state || newState();
  const body = ev.body && typeof ev.body === 'object' ? ev.body : null;
  const same = { state: s, read: [], changed: false };
  const gone = []; // dialogs closed by this event → read
  // a subagent's events are never the tab's: its "final reply" goes to the
  // main agent, not to you
  if (!body || body.agent_id) return same;
  const now = typeof ev.now === 'number' ? ev.now : Date.now();
  const termId = String(ev.termId || '');
  const add = (kind, text, extra = {}) => {
    const p = s.prompts[termId] || null;
    const entry = {
      id: ev.id || makeId(ev.wsId, now),
      wsId: ev.wsId, wsName: ev.wsName || ev.wsId, termId, tabName: ev.tabName || termId,
      sessionId: str(body.session_id) || null,
      at: now, kind, text,
      prompt: p ? p.text : null, origin: p ? p.origin : 'you', from: p ? p.from : null,
      open: false, ...extra,
    };
    return capEntries([...closeOpen(s.entries, termId, gone), entry], now);
  };
  switch (ev.event) {
    case 'UserPromptSubmit': {
      const raw = str(body.prompt);
      const origin = originOf(raw);
      const prompts = { ...s.prompts, [termId]: { text: clip(raw.trim(), PROMPT_MAX), origin, from: origin === 'peer' ? peerName(raw) : null } };
      if (origin !== 'you') return { state: { ...s, prompts }, read: [], changed: false };
      // you typed into that tab, so you saw what it said before
      const read = s.entries.filter(e => e.termId === termId && e.wsId === ev.wsId).map(e => e.id);
      const entries = closeOpen(s.entries, termId);
      return { state: { entries, prompts }, read, changed: entries !== s.entries };
    }
    case 'Stop': {
      const text = str(body.last_assistant_message).trim();
      if (!text) {
        const entries = closeOpen(s.entries, termId, gone);
        return { state: { ...s, entries }, read: gone, changed: entries !== s.entries };
      }
      return { state: { ...s, entries: add('reply', clip(text, TEXT_MAX)) }, read: gone, changed: true };
    }
    case 'StopFailure':
      return { state: { ...s, entries: add('failed', failureText(body)) }, read: gone, changed: true };
    case 'PreToolUse': {
      if (body.tool_name === 'AskUserQuestion') {
        return { state: { ...s, entries: add('question', questionText(body.tool_input), { open: true }) }, read: gone, changed: true };
      }
      // a new tool call means the previous dialog is gone (a denied permission
      // fires no PostToolUse)
      const entries = closeOpen(s.entries, termId, gone);
      return { state: { ...s, entries }, read: gone, changed: entries !== s.entries };
    }
    case 'PermissionRequest': {
      // AskUserQuestion can ask for permission too: its question entry says it all
      if (body.tool_name === 'AskUserQuestion') return same;
      return { state: { ...s, entries: add('permission', permissionText(body), { open: true }) }, read: gone, changed: true };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const entries = closeOpen(s.entries, termId, gone);
      return { state: { ...s, entries }, read: gone, changed: entries !== s.entries };
    }
    default:
      return same;
  }
}

// ---------- pure: read marks ----------
// merge this writer's marks into what is on disk now; marks older than 30 days go
function mergeRead(onDisk, add = [], remove = [], now = Date.now()) {
  const read = {};
  const src = onDisk && typeof onDisk === 'object' ? onDisk : {};
  for (const [id, at] of Object.entries(src)) if (typeof at === 'number' && now - at <= MAX_AGE) read[id] = at;
  for (const id of add) if (typeof id === 'string' && id && !read[id]) read[id] = now;
  for (const id of remove) delete read[id];
  return read;
}

// ---------- read marks on disk (machine-wide) ----------
let readCache = { key: '', read: {} };
const listeners = [];
const changed = () => { for (const fn of listeners) { try { fn(); } catch (e) { logger.warn('inbox listener: ' + e.message); } } };

function statKey(file) {
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

function readMarks() {
  const key = statKey(readFile());
  if (key && key === readCache.key) return readCache.read;
  const j = key ? U.readJson(readFile(), null) : null;
  readCache = { key, read: (j && j.read && typeof j.read === 'object') ? j.read : {} };
  return readCache.read;
}

// re-read + merge right before the atomic write: another process may have
// written since we last looked. Two processes renaming the same .tmp at once
// make one rename fail: that one retries once.
function commitRead(add = [], remove = [], now = Date.now()) {
  if (!add.length && !remove.length) return false;
  for (let i = 0; i < 2; i++) {
    try {
      const j = U.readJson(readFile(), null);
      const read = mergeRead(j && j.read, add, remove, now);
      U.ensureDir(U.dataRoot());
      U.writeJsonAtomic(readFile(), { read });
      readCache = { key: statKey(readFile()), read };
      changed();
      return true;
    } catch (e) {
      if (i) logger.warn('inbox read marks write failed: ' + e.message);
    }
  }
  return false;
}

// ---------- this process's workspaces (writer) ----------
const stores = new Map(); // wsId -> { wsName, state, timer, lastAt }

function storeOf(wsId) {
  let st = stores.get(wsId);
  if (st) return st;
  const j = U.readJson(fileFor(wsId), null);
  const entries = j && Array.isArray(j.entries) ? j.entries.filter(e => e && typeof e.id === 'string' && typeof e.at === 'number') : [];
  // a question or permission dialog can't outlive the process that showed it
  // (and nobody can answer it any more: read, so the badge doesn't count it)
  const reopened = entries.filter(e => e.open).map(e => e.id);
  st = { wsName: (j && j.wsName) || wsId, state: { entries: entries.map(e => (e.open ? { ...e, open: false } : e)), prompts: {} }, timer: null, lastAt: 0 };
  stores.set(wsId, st);
  if (reopened.length) { touch(wsId); commitRead(reopened); }
  return st;
}

function writeNow(wsId) {
  const st = stores.get(wsId);
  if (!st) return;
  clearTimeout(st.timer);
  st.timer = null;
  st.lastAt = Date.now();
  try {
    U.ensureDir(dir());
    U.writeJsonAtomic(fileFor(wsId), { wsId, wsName: st.wsName, updatedAt: st.lastAt, entries: capEntries(st.state.entries, st.lastAt) });
  } catch (e) {
    logger.warn('inbox write failed: ' + e.message);
  }
}

// ≤ 1 write per second per workspace
function touch(wsId) {
  const st = stores.get(wsId);
  if (!st || st.timer) return;
  st.timer = setTimeout(() => writeNow(wsId), Math.max(0, MIN_GAP - (Date.now() - st.lastAt)));
}

// events that can add an entry: only these need the workspace/tab names
const ENTRY_EVENTS = new Set(['Stop', 'StopFailure', 'PreToolUse', 'PermissionRequest']);

// one feed hook for a term of this process. ctx = { wsName, tabName } or a
// function returning it, called only when an entry may be added (every tool
// call is a hook: the registry isn't read for each one)
function noteHook(wsId, termId, event, body, ctx = {}) {
  if (!wsId || !termId) return;
  const st = storeOf(wsId);
  if (typeof ctx === 'function') {
    const adds = ENTRY_EVENTS.has(event) && body && !body.agent_id && (event !== 'PreToolUse' || body.tool_name === 'AskUserQuestion');
    ctx = adds ? (ctx() || {}) : {};
  }
  if (ctx.wsName) st.wsName = ctx.wsName;
  const lastOf = (s) => s.entries[s.entries.length - 1] || null;
  const before = lastOf(st.state);
  const r = reduce(st.state, { wsId, wsName: st.wsName, termId, tabName: ctx.tabName, event, body, now: Date.now() });
  st.state = r.state;
  if (r.changed) {
    const last = lastOf(st.state);
    if (last && last !== before) logger.info(`inbox: ${last.kind} ws=${wsId} term=${termId} (${last.text.length} chars, ${last.origin})`);
    touch(wsId);
  }
  if (r.read.length) commitRead(r.read);
  else if (r.changed) changed();
}

// the window opened: load its store now, so dialogs left open by a crash are
// closed (and read) at once, not at this workspace's first hook
function openWorkspace(wsId) {
  if (wsId) storeOf(wsId);
}

// the window closed: its dialogs are gone with it; write now
function closeWorkspace(wsId) {
  const st = stores.get(wsId);
  if (!st) return;
  let entries = st.state.entries;
  const gone = [];
  for (const t of new Set(entries.filter(e => e.open).map(e => e.termId))) entries = closeOpen(entries, t, gone);
  st.state = { ...st.state, entries };
  writeNow(wsId);
  if (gone.length) commitRead(gone);
  stores.delete(wsId);
}

function flushAll() {
  for (const [wsId, st] of stores) if (st.timer) writeNow(wsId);
}

// ---------- reader (every workspace's file) ----------
const fileCache = new Map(); // file name -> { key, entries }

function allEntries() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir()); } catch {}
  const own = new Set([...stores.keys()].map(id => `${id}.json`));
  for (const n of names) {
    if (!n.endsWith('.json') || own.has(n)) continue;
    const file = path.join(dir(), n);
    const key = statKey(file);
    let c = fileCache.get(n);
    if (!c || c.key !== key) {
      // never U.readJson here: it renames a file it can't parse, and this one
      // belongs to another process
      let j = null;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      c = { key, entries: j && Array.isArray(j.entries) ? j.entries.filter(e => e && typeof e.id === 'string' && typeof e.at === 'number') : [] };
      fileCache.set(n, c);
    }
    out.push(...c.entries);
  }
  for (const st of stores.values()) out.push(...st.state.entries); // fresher than our own files
  return out;
}

const listItem = (e, read) => {
  const text = str(e.text);
  return { ...e, text: undefined, preview: clip(text, PREVIEW_MAX), long: text.length > PREVIEW_MAX, read };
};

// newest first, capped; open questions/permissions are always included.
// Texts are previews: inbox:get returns one entry in full.
function list(now = Date.now()) {
  const marks = readMarks();
  const all = allEntries().filter(e => now - e.at <= MAX_AGE).sort((a, b) => b.at - a.at);
  const unread = all.filter(e => !marks[e.id]).length;
  const top = all.slice(0, LIST_MAX);
  for (const e of all.slice(LIST_MAX)) if (e.open) top.push(e);
  return { entries: top.map(e => listItem(e, Boolean(marks[e.id]))), unread };
}

function unreadCount(now = Date.now()) {
  const marks = readMarks();
  return allEntries().filter(e => now - e.at <= MAX_AGE && !marks[e.id]).length;
}

function get(id) {
  const e = allEntries().find(x => x.id === id);
  return e ? { ...e, read: Boolean(readMarks()[e.id]) } : null;
}

const markRead = (ids) => commitRead((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string').slice(0, 5000));
const markUnread = (id) => commitRead([], typeof id === 'string' ? [id] : []);
function markAllRead() {
  const marks = readMarks();
  return commitRead(allEntries().map(e => e.id).filter(id => !marks[id]));
}

module.exports = {
  reduce, newState, mergeRead, originOf, peerName, capEntries, // pure (smoke)
  noteHook, openWorkspace, closeWorkspace, flushAll,
  list, unreadCount, get, markRead, markUnread, markAllRead, commitRead,
  onChange: (fn) => { listeners.push(fn); },
  MAX_ENTRIES, MAX_AGE,
  _file: fileFor, _readFile: readFile, _writeNow: writeNow, _forget: (wsId) => { const st = stores.get(wsId); if (st) clearTimeout(st.timer); stores.delete(wsId); },
};
