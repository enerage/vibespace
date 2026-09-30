'use strict';
// Which attention events raise a Windows toast. Machine-wide (one choice for
// every workspace): <dataRoot>/notify.json, re-read when its mtime changes, so a
// switch flipped in one workspace window applies to all the others at once —
// each workspace is its own process.
//
// Defaults: toast only when you are NEEDED (a question/permission, a failed
// turn). "Finished its turn" is off — with many agents it fires constantly and
// trains you to ignore toasts (Valentin, 2026-09-30). Tab lights and the
// taskbar badge are not affected; they always show every state.
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

const DEFAULTS = Object.freeze({ waiting: true, failed: true, done: false });
const KINDS = Object.keys(DEFAULTS);

let cache = null;   // { mtime, prefs }
const file = () => path.join(U.dataRoot(), 'notify.json');

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of KINDS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

function get() {
  let mtime = 0;
  try { mtime = fs.statSync(file()).mtimeMs; } catch { /* no file yet → defaults */ }
  if (cache && cache.mtime === mtime) return { ...cache.prefs };
  const prefs = normalize(mtime ? U.readJson(file(), null) : null);
  cache = { mtime, prefs };
  return { ...prefs };
}

function set(patch) {
  const next = normalize({ ...get(), ...(patch && typeof patch === 'object' ? patch : {}) });
  U.ensureDir(path.dirname(file()));
  U.writeJsonAtomic(file(), next);
  cache = null; // re-read with the new mtime
  return next;
}

// st: the attention status notifyAttention was called with
function shouldToast(st) {
  return Boolean(get()[st]);
}

module.exports = { get, set, shouldToast, DEFAULTS, _normalize: normalize };
