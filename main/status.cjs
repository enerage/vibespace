'use strict';
// Watches per-workspace status files that claude hooks append to (the hooks are
// injected via `claude --settings` and write to $VIBESPACE_TERM_STATUS, which
// ptyhost sets per terminal). One file per terminal; the LAST non-empty line is
// the current status: working | waiting | done.
const fs = require('node:fs');
const path = require('node:path');

const active = new Map(); // wsId -> { dir, watcher, pending: Set, timer }
let listener = () => {};

function onData(fn) { listener = fn; }

function readStatus(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    return lines.length ? lines[lines.length - 1].trim() : null;
  } catch { return null; }
}

function start(wsId, dir) {
  stop(wsId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const state = { dir, watcher: null, pending: new Set(), timer: null };
  try {
    state.watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.status')) return;
      state.pending.add(filename);
      clearTimeout(state.timer);
      state.timer = setTimeout(() => flush(wsId), 200);
    });
  } catch {}
  active.set(wsId, state);
  return state;
}

function flush(wsId) {
  const state = active.get(wsId);
  if (!state) return;
  for (const filename of state.pending) {
    const status = readStatus(path.join(state.dir, filename));
    if (!status) continue;
    listener(wsId, filename.slice(0, -'.status'.length), status);
  }
  state.pending.clear();
}

function stop(wsId) {
  const state = active.get(wsId);
  if (!state) return;
  if (state.watcher) { try { state.watcher.close(); } catch {} }
  clearTimeout(state.timer);
  active.delete(wsId);
}

// Status word for a claude hook event received over HTTP (claude data feed),
// mirroring the Git Bash hooks: prompt/tool → working, turn end → done, a
// Notification → waiting unless it's the idle "waiting for your input" nudge
// (finished agents stay green). null = event carries no status.
// A SUBAGENT's tool call (its events carry agent_id) says nothing about the
// main turn: a background subagent keeps calling tools after the turn's Stop,
// and its `working` used to turn a finished tab amber until the next Stop.
// The turn's own state comes from the main thread's events only.
function wordForHook(event, body) {
  if (event === 'UserPromptSubmit') return 'working';
  if (event === 'PreToolUse') return body && body.agent_id ? null : 'working';
  if (event === 'Stop') return 'done';
  if (event === 'Notification') {
    let text = '';
    try { text = JSON.stringify(body || {}); } catch {}
    return /waiting for your input/i.test(text) ? null : 'waiting';
  }
  return null;
}

module.exports = { start, stop, onData, wordForHook, _readStatus: readStatus };
