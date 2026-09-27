'use strict';
// Watches the workspace repo for filesystem changes (recursive fs.watch — native
// on Windows) so the file tree can refresh live. Agents create files constantly;
// a tree that snapshots once is useless. Events under ignored folders
// (node_modules etc.) are filtered before they ever reach the debounce.
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

const active = new Map(); // wsId -> { repoPath, watcher, timer }
let listener = () => {};

function onData(fn) { listener = fn; }

function start(wsId, repoPath) {
  stop(wsId);
  const state = { repoPath, watcher: null, timer: null };
  try {
    state.watcher = fs.watch(repoPath, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (U.isIgnoredPath(rel)) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => listener(wsId), 700);
    });
  } catch {}
  active.set(wsId, state);
  return state;
}

function stop(wsId) {
  const state = active.get(wsId);
  if (!state) return;
  if (state.watcher) { try { state.watcher.close(); } catch {} }
  clearTimeout(state.timer);
  active.delete(wsId);
}

module.exports = { start, stop, onData };
