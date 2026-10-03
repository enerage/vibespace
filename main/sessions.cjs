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
function trackClaudeStart(wsId, termId, { picker = false, offRepo = false } = {}) {
  const state = active.get(wsId);
  if (!state) return;
  const prev = state.terms.get(termId) || {};
  state.terms.set(termId, { startedAt: Date.now(), sessionId: prev.sessionId, picker, feed: prev.feed, offRepo: Boolean(offRepo) });
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
  state.terms.set(termId, { startedAt: prev.startedAt || Date.now(), sessionId });
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

function pinFromFeed(wsId, termId, sessionId, transcriptPath = null) {
  const state = active.get(wsId);
  if (!state || !sessionId) return false;
  const prev = state.terms.get(termId) || { startedAt: 0 };
  if (prev.sessionId === sessionId && prev.feed) return false;
  if (!sessionExists(wsId, sessionId) && !transcriptMatches(sessionId, transcriptPath)) return false; // not written yet — retried on the next tick
  state.terms.set(termId, { ...prev, startedAt: prev.startedAt || Date.now(), sessionId, picker: false, feed: true });
  return prev.sessionId !== sessionId;
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
  if (!state.dir) { dbg('[sessions] scan skipped: no dir yet'); return; }
  const files = listSessionFiles(state.dir);
  dbg(`[sessions] scan ws=${wsId} files=${files.length} dir=${state.dir}`);
  if (files.length === 0) return;

  const terms = [...state.terms.entries()]
    .map(([termId, t]) => ({ termId, ...t }))
    .filter(t => t.startedAt && !t.offRepo) // worktree tabs: feed only (their files aren't here)
    .sort((a, b) => a.startedAt - b.startedAt);
  dbg(`[sessions] tracked terms=${terms.length} -> ${terms.map(t => `${t.termId}@${t.startedAt}${t.sessionId ? '+sess' : ''}`).join(', ')}`);
  if (terms.length === 0) return;

  // Claude Code creates the session .jsonl only when the first message is sent,
  // which can be minutes after launch. So: an unresolved terminal owns the earliest
  // session file born after its claude launched and before the next terminal's
  // claude launched (the last terminal's window is unbounded).
  // Picker-launched tabs are different: the user resumed an OLD conversation via
  // claude's interactive picker, so we pin the old file that came alive instead.
  const takenIds = new Set(terms.filter(t => t.sessionId).map(t => t.sessionId));
  let changed = false;
  for (const term of terms) {
    if (term.sessionId) continue;
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
    if (term.sessionId || term.picker) return; // resolved, or handled above
    const windowStart = term.startedAt - 2000;
    const windowEnd = i + 1 < terms.length ? terms[i + 1].startedAt - 2000 : Infinity;
    const candidates = files
      .filter(f => f.born >= windowStart && f.born < windowEnd)
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

module.exports = { start, stop, trackClaudeStart, pinSession, pinFromFeed, getSession, sessionExists, transcriptFile, lastReply, lastReplyOf, enrichState, sessionIdsFor, onData, _scan: scan, _pickResumed: pickResumed };
