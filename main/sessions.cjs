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

function trackClaudeStart(wsId, termId) {
  const state = active.get(wsId);
  if (!state) return;
  const prev = state.terms.get(termId) || {};
  state.terms.set(termId, { startedAt: Date.now(), sessionId: prev.sessionId });
  scheduleScan(wsId);
}

function pinSession(wsId, termId, sessionId) {
  const state = active.get(wsId);
  if (!state) return;
  const prev = state.terms.get(termId) || { startedAt: 0 };
  state.terms.set(termId, { startedAt: prev.startedAt || Date.now(), sessionId });
}

function getSession(wsId, termId) {
  return active.get(wsId)?.terms.get(termId)?.sessionId || null;
}

// Before auto-typing `claude --resume <id>` on restore: does the session file still
// exist? A dead id must open the interactive picker, not silently error out.
function sessionExists(wsId, sessionId) {
  const state = active.get(wsId);
  if (!state || !state.dir || !sessionId) return false;
  try {
    return fs.existsSync(path.join(state.dir, `${sessionId}.jsonl`));
  } catch {
    return false;
  }
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
    .filter(t => t.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  dbg(`[sessions] tracked terms=${terms.length} -> ${terms.map(t => `${t.termId}@${t.startedAt}${t.sessionId ? '+sess' : ''}`).join(', ')}`);
  if (terms.length === 0) return;

  // Claude Code creates the session .jsonl only when the first message is sent,
  // which can be minutes after launch. So: an unresolved terminal owns the earliest
  // session file born after its claude launched and before the next terminal's
  // claude launched (the last terminal's window is unbounded).
  let changed = false;
  terms.forEach((term, i) => {
    if (term.sessionId) return; // already resolved (pinned on resume or discovered)
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

module.exports = { start, stop, trackClaudeStart, pinSession, getSession, sessionExists, sessionIdsFor, onData, _scan: scan };
