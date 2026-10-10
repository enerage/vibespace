'use strict';
// Tracks which Claude Code session (the <uuid>.jsonl under ~/.claude/projects/<munged-repo>/)
// belongs to which terminal tab, so terminals can be killed and relaunched with
// `claude --resume <id>` after updates or restarts.
//
// Heuristic: when a terminal launches `claude` (we wrote the command ourselves),
// we record the timestamp; the session file created closest after that moment is
// that tab's session. Claude Code creates the main session file at startup, so
// the earliest file born inside the window wins (subagent files appear later).
// Terminals relaunched with a known --resume id get the id pinned directly.
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

const active = new Map(); // wsId -> { dir, watcher, timer, terms: Map(termId -> {startedAt, sessionId}) }
let sessionListener = () => {};

function onData(fn) { sessionListener = fn; }

function start(wsId, repoPath) {
  stop(wsId);
  const state = { repoPath, dir: U.resolveClaudeProjectDir(repoPath), watcher: null, timer: null, terms: new Map() };
  active.set(wsId, state);
  attachWatcher(state, wsId);
  // Always poll: the project dir may not exist yet for a fresh repo — Claude Code
  // creates it on the first message, and the tracker must pick it up then
  state.timer = setInterval(() => scan(wsId), 4000);
  state.timer.unref?.();
  scan(wsId);
  return state;
}

function attachWatcher(state, wsId) {
  if (!state.dir || state.watcher) return;
  try {
    state.watcher = fs.watch(state.dir, { persistent: false }, () => scheduleScan(wsId));
  } catch {}
}

function stop(wsId) {
  const state = active.get(wsId);
  if (!state) return;
  if (state.watcher) { try { state.watcher.close(); } catch {} }
  if (state.timer) clearInterval(state.timer);
  active.delete(wsId);
}

// offRepo: the tab's cwd is not the repo root (a worktree tab). Its transcript
// lives in munged(<cwd>), so the timing heuristic (repo dir only) must never
// hand it a repo-dir file; the feed pins it instead.
// feedLaunch: main says this claude got our --settings WITH the data feed in it
// (the feed server was listening when the pty's settings were written). Such a
// term is NEVER guessed by timing or mtime: only its own feed session_id pins
// it. The guess is wrong whenever two agents start close together: a transcript
// is born at the FIRST MESSAGE, so it lands in the window of whichever tab
// launched last, and agent-2 got agent-1's conversation until the feed fixed it
// (a restart in between = two claudes on one transcript).
function trackClaudeStart(wsId, termId, { picker = false, offRepo = false, feedLaunch = false } = {}) {
  const state = active.get(wsId);
  if (!state) return;
  const prev = state.terms.get(termId) || {};
  // a new claude: an older one's not-yet-written session will never be written
  state.terms.set(termId, { startedAt: Date.now(), sessionId: prev.sessionId, picker, feed: prev.feed, offRepo: Boolean(offRepo), feedLaunch: Boolean(feedLaunch), pending: null });
  scheduleScan(wsId);
}

// A tab launched via `claude --resume` (the interactive picker): whichever OLD
// session file (born well before the launch) starts receiving appends AFTER the
// launch is the conversation the user picked. Most-recent-mtime wins; files
// already pinned to other tabs are excluded.
function pickResumed(files, startedAt, takenIds) {
  const candidates = files.filter(f =>
    f.mtime > startedAt &&            // being written since the launch
    f.born < startedAt - 2000 &&      // genuinely old conversation, not a fresh one
    !takenIds.has(f.id));             // not owned by another tab
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}

function pinSession(wsId, termId, sessionId) {
  const state = active.get(wsId);
  if (!state) return;
  const prev = state.terms.get(termId) || { startedAt: 0 };
  // keeps how the claude was launched (offRepo/feedLaunch); the id is exact
  state.terms.set(termId, { startedAt: prev.startedAt || Date.now(), sessionId, offRepo: Boolean(prev.offRepo), feedLaunch: Boolean(prev.feedLaunch), pending: null });
}

// Exact mapping from the claude data feed: every statusLine/hook body carries
// session_id and arrives tagged with our term id (x-vs-term). Primary source for
// agents with a feed — it follows /clear, /resume and the picker. Marked `feed`
// so the timing heuristic below never reassigns the term. Only pinned once the
// transcript exists (claude writes it on the first message), so a restore never
// tries to resume a conversation that was never saved. Returns true on change.
// transcriptPath (the feed's transcript_path) counts wherever it lives: a
// worktree tab's transcript sits in munged(<worktree>), not the repo's dir.
function transcriptMatches(sessionId, transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return false;
  if (path.basename(transcriptPath).toLowerCase() !== `${sessionId}.jsonl`.toLowerCase()) return false; // stale path after /clear
  try { return fs.existsSync(transcriptPath); } catch { return false; }
}

// A subagent's own transcript (verified 2026-10-10, claude 2.1.295): the hook's
// agent_id names the file next to the conversation's transcript:
//   <dir>/<session>.jsonl → <dir>/<session>/subagents/agent-<agent_id>.jsonl
// (its lines carry "agentId": the same id; a .meta.json sits beside it).
// Accepts the subagent's file itself too. Pure; null for anything else.
function subagentTranscriptPath(transcriptPath, agentId) {
  const id = typeof agentId === 'string' ? agentId : (agentId == null ? '' : String(agentId));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null; // never a path piece from outside
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath)) return null;
  const base = path.basename(transcriptPath);
  if (base.toLowerCase() === `agent-${id}.jsonl`.toLowerCase()) return transcriptPath;
  if (/^agent-/i.test(base)) return null; // another agent's file
  return path.join(path.dirname(transcriptPath), base.slice(0, -'.jsonl'.length), 'subagents', `agent-${id}.jsonl`);
}

// Not written yet: the id is remembered as `pending` and scan() pins it once
// its file appears, so a claude that dies right after its first message (no
// tick after the transcript was born) still keeps that conversation. That pin
// is exact too (the feed named the id), just not announced with a family, so
// the next tick (if any) still goes through the full path (feed: 'scan').
function pinFromFeed(wsId, termId, sessionId, transcriptPath = null) {
  const state = active.get(wsId);
  if (!state || !sessionId) return false;
  const prev = state.terms.get(termId) || { startedAt: 0 };
  if (prev.sessionId === sessionId && prev.feed === true) {
    if (prev.pending) state.terms.set(termId, { ...prev, pending: null }); // back on it (/resume after a /clear never written)
    return false;
  }
  if (!sessionExists(wsId, sessionId) && !transcriptMatches(sessionId, transcriptPath)) {
    if (prev.sessionId !== sessionId) state.terms.set(termId, { ...prev, pending: { sessionId, transcriptPath: transcriptPath || null } });
    return false; // retried on the next tick (and by scan)
  }
  state.terms.set(termId, { ...prev, startedAt: prev.startedAt || Date.now(), sessionId, picker: false, feed: true, pending: null });
  return prev.sessionId !== sessionId || prev.feed === 'scan';
}

function getSession(wsId, termId) {
  return active.get(wsId)?.terms.get(termId)?.sessionId || null;
}

// Before auto-typing `claude --resume <id>` on restore: does the session file still
// exist? A dead id must open the interactive picker, not silently error out.
// cwd: the tab's folder; when it isn't the repo root (worktree tab) its own
// project dir is checked too.
function sessionExists(wsId, sessionId, cwd = null) {
  return transcriptFile(wsId, sessionId, cwd) !== null;
}

// the session's .jsonl (repo dir first, then the tab cwd's own dir), or null
function transcriptFile(wsId, sessionId, cwd = null) {
  const state = active.get(wsId);
  if (!state || !sessionId) return null;
  const dirs = [state.dir];
  if (cwd && path.resolve(cwd).toLowerCase() !== path.resolve(state.repoPath).toLowerCase()) dirs.push(U.resolveClaudeProjectDir(cwd));
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, `${sessionId}.jsonl`);
    try {
      if (fs.existsSync(file)) return file;
    } catch {}
  }
  return null;
}

// Parked agents: the last assistant TEXT of a transcript (tool-only and API
// error lines skipped), read from the tail only → { text (≤ maxChars), model } | null
function lastReplyOf(jsonlPath, { maxBytes = 512 * 1024, maxChars = 2000 } = {}) {
  let fd = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"assistant"') || line.includes('"isApiErrorMessage":true')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; } // the cut first line
      if (j.type !== 'assistant' || !j.message) continue;
      const c = j.message.content;
      const text = typeof c === 'string' ? c
        : (Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '');
      if (!text.trim()) continue;
      return { text: text.trim().slice(0, maxChars), model: typeof j.message.model === 'string' ? j.message.model : null };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function lastReply(wsId, sessionId, cwd = null) {
  const file = transcriptFile(wsId, sessionId, cwd);
  return file ? lastReplyOf(file) : null;
}

// The session's names as Claude records them in its transcript:
//   ai      Claude's own title ({"type":"ai-title","aiTitle":…}), written a few
//           lines after the first message and never changed afterwards
//   custom  the /rename name ({"type":"custom-title","customTitle":…}); ours
//           arrive as "<workspace> · <tab>"
// Both are re-appended as the file grows, so the tail usually has them; a short
// or young file is covered by the head. → { ai, custom } (either may be null)
function titlesOf(jsonlPath, { chunk = 256 * 1024 } = {}) {
  let fd = null;
  const out = { ai: null, custom: null };
  const scan = (text) => {
    for (const line of text.split('\n')) {
      const isAi = line.includes('"type":"ai-title"');
      if (!isAi && !line.includes('"type":"custom-title"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; } // a cut line at the chunk edge
      if (j.type === 'ai-title' && typeof j.aiTitle === 'string' && j.aiTitle.trim()) out.ai = j.aiTitle.trim();
      if (j.type === 'custom-title' && typeof j.customTitle === 'string' && j.customTitle.trim()) out.custom = j.customTitle.trim();
    }
  };
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b.toString('utf8'); };
    if (size > chunk) scan(read(0, chunk)); // head first, so the tail's (newer) values win
    scan(read(Math.max(0, size - chunk), Math.min(size, chunk)));
    return out;
  } catch {
    return out;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

// A tab name from those titles, for a tab still on its default "agent-N".
// The /rename name wins (minus our "<workspace> · " prefix) unless it is just a
// default name again; otherwise Claude's own title. Shortened at a word
// boundary, made unique among `taken`. → { name, from: 'custom' | 'ai' } | null
const DEFAULT_TAB_NAME = /^agent-\d+$/i;
const TAB_NAME_MAX = 30;
function tabNameFrom(titles, wsName = '', taken = []) {
  const loose = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  let base = '';
  let from = null;
  const custom = titles && titles.custom ? String(titles.custom) : '';
  if (custom) {
    let c = custom;
    const i = c.indexOf(' · ');
    if (i > 0 && loose(c.slice(0, i)) === loose(wsName)) c = c.slice(i + 3);
    c = c.trim();
    if (c && !DEFAULT_TAB_NAME.test(c)) { base = c; from = 'custom'; }
  }
  if (!base && titles && titles.ai) { base = String(titles.ai); from = 'ai'; }
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return null;
  if (base.length > TAB_NAME_MAX) {
    const cut = base.slice(0, TAB_NAME_MAX - 1);
    const sp = cut.lastIndexOf(' ');
    base = (sp >= 12 ? cut.slice(0, sp) : cut).trim() + '…';
  }
  const used = new Set((Array.isArray(taken) ? taken : []).map(n => String(n).toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return { name, from };
}

function tabNameFor(wsId, sessionId, cwd = null, wsName = '', taken = []) {
  const file = transcriptFile(wsId, sessionId, cwd);
  return file ? tabNameFrom(titlesOf(file), wsName, taken) : null;
}

// main's state merge: the renderer snapshot + tracked session ids. `parked`
// (stopped agents on the shelf) is carried as-is; a snapshot without the key
// (a renderer that predates it) keeps the previous list instead of wiping it.
function enrichState(wsId, state, prevParked = null) {
  const enriched = { ...state };
  if (Array.isArray(enriched.terminals)) {
    enriched.terminals = enriched.terminals.map(t => ({
      ...t,
      claudeSessionId: getSession(wsId, t.termId) || t.claudeSessionId || null,
    }));
  }
  if (!Array.isArray(enriched.parked)) enriched.parked = Array.isArray(prevParked) ? prevParked : [];
  return enriched;
}

function scheduleScan(wsId) {
  setTimeout(() => scan(wsId), 700).unref?.();
}

function listSessionFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          const born = st.birthtimeMs || st.mtimeMs;
          return { id: f.slice(0, -'.jsonl'.length), born, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scan(wsId) {
  const state = active.get(wsId);
  const dbg = process.env.VIBESPACE_DEBUG ? console.log.bind(console) : () => {};
  if (!state) { dbg('[sessions] scan skipped: no state'); return; }
  if (!state.dir) {
    // fresh repo: the Claude projects dir appears only after the first message
    state.dir = U.resolveClaudeProjectDir(state.repoPath);
    if (state.dir) attachWatcher(state, wsId);
    dbg(`[sessions] dir re-resolved: ${state.dir}`);
  }
  // the feed named a session before its transcript existed: pin it once it does
  // (exact, not a guess; works for worktree tabs too via the feed's path)
  let changed = false;
  for (const [termId, t] of state.terms) {
    const p = t.pending;
    if (!p || !p.sessionId) continue;
    if (!sessionExists(wsId, p.sessionId) && !transcriptMatches(p.sessionId, p.transcriptPath)) continue;
    state.terms.set(termId, { ...t, sessionId: p.sessionId, picker: false, feed: 'scan', pending: null });
    changed = true;
    sessionListener(wsId, termId, p.sessionId);
  }
  if (!state.dir) { dbg('[sessions] scan skipped: no dir yet'); return changed; }
  const files = listSessionFiles(state.dir);
  dbg(`[sessions] scan ws=${wsId} files=${files.length} dir=${state.dir}`);
  if (files.length === 0) return changed;

  // every id a tab already owns or that the feed named (about to be written)
  // belongs to that tab: the guesses below must never hand it to another one
  const takenIds = new Set();
  for (const t of state.terms.values()) {
    if (t.sessionId) takenIds.add(t.sessionId);
    if (t.pending && t.pending.sessionId) takenIds.add(t.pending.sessionId);
  }
  const terms = [...state.terms.entries()]
    .map(([termId, t]) => ({ termId, ...t }))
    .filter(t => t.startedAt && !t.offRepo) // worktree tabs: feed only (their files aren't here)
    .sort((a, b) => a.startedAt - b.startedAt);
  dbg(`[sessions] tracked terms=${terms.length} -> ${terms.map(t => `${t.termId}@${t.startedAt}${t.sessionId ? '+sess' : ''}`).join(', ')}`);
  if (terms.length === 0) return changed;

  // Claude Code creates the session .jsonl only when the first message is sent,
  // which can be minutes after launch. So: an unresolved terminal owns the earliest
  // session file born after its claude launched and before the next terminal's
  // claude launched (the last terminal's window is unbounded).
  // Picker-launched tabs are different: the user resumed an OLD conversation via
  // claude's interactive picker, so we pin the old file that came alive instead.
  // Both guesses are only for claudes WITHOUT a feed. A feed-launched term
  // still counts as a window boundary (a no-feed tab's window must not reach
  // into the files born after it launched) but is never assigned here.
  for (const term of terms) {
    if (term.sessionId || term.feedLaunch) continue;
    if (term.picker) {
      const match = pickResumed(files, term.startedAt, takenIds);
      if (match) {
        state.terms.set(term.termId, { startedAt: term.startedAt, sessionId: match.id, picker: true });
        takenIds.add(match.id);
        changed = true;
        sessionListener(wsId, term.termId, match.id);
      }
      continue;
    }
  }
  terms.forEach((term, i) => {
    if (term.sessionId || term.picker || term.feedLaunch) return; // resolved, handled above, or feed-only
    const windowStart = term.startedAt - 2000;
    const windowEnd = i + 1 < terms.length ? terms[i + 1].startedAt - 2000 : Infinity;
    const candidates = files
      .filter(f => f.born >= windowStart && f.born < windowEnd && !takenIds.has(f.id))
      .sort((a, b) => a.born - b.born);
    const match = candidates[0];
    if (match) {
      state.terms.set(term.termId, { startedAt: term.startedAt, sessionId: match.id });
      changed = true;
      sessionListener(wsId, term.termId, match.id);
    }
  });
  return changed;
}

function sessionIdsFor(wsId) {
  const state = active.get(wsId);
  const out = {};
  if (state) {
    for (const [termId, t] of state.terms) {
      if (t.sessionId) out[termId] = t.sessionId;
    }
  }
  return out;
}

module.exports = { start, stop, trackClaudeStart, pinSession, pinFromFeed, getSession, sessionExists, transcriptFile, subagentTranscriptPath, lastReply, lastReplyOf, titlesOf, tabNameFrom, tabNameFor, enrichState, sessionIdsFor, onData, _scan: scan, _pickResumed: pickResumed };
