'use strict';
// Watches per-workspace status files that claude hooks append to (the hooks are
// injected via `claude --settings` and write to $VIBESPACE_TERM_STATUS, which
// ptyhost sets per terminal). One file per terminal; the LAST non-empty line is
// the current status: working | waiting | done.
const fs = require('node:fs');
const path = require('node:path');

const active = new Map(); // wsId -> { dir, watcher, pending: Set, timer, sweep, mtimes }
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
  const state = { dir, watcher: null, pending: new Set(), timer: null, sweep: null, mtimes: new Map() };
  const queue = (filename) => {
    state.pending.add(filename);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => flush(wsId), 200);
  };
  try {
    state.watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.status')) return;
      queue(filename);
    });
  } catch {}
  // macOS: FSEvents delivers late under load and can miss a write made right
  // after the watch starts (seen on the Intel CI runner), so a cheap mtime
  // sweep backs it up. A missed event would leave a tab light stale.
  if (process.platform === 'darwin') {
    const sweep = () => {
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => n.endsWith('.status')); } catch { return; }
      for (const n of names) {
        let m = 0;
        try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch { continue; }
        if (state.mtimes.get(n) !== m) { state.mtimes.set(n, m); queue(n); }
      }
    };
    state.sweep = setInterval(sweep, 1500);
    if (state.sweep.unref) state.sweep.unref();
  }
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
  if (state.sweep) clearInterval(state.sweep);
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
