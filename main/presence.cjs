'use strict';
// Away mode. Claude Code skips phone pushes (Remote Control) while the file named
// by $CLAUDE_CLIENT_PRESENCE_FILE exists (2.1.181+). VibeSpace owns that marker
// machine-wide: <dataRoot>/presence/at-pc exists iff Valentin is at the PC.
// State lives in <dataRoot>/presence.json so a toggle or a lock seen by one
// workspace process reaches all of them; every workspace process runs this and
// every write is idempotent.
//   present — marker exists, phone stays quiet
//   away    — manual toggle; marker gone
//   idle    — automatic (screen locked / 10 min without input); marker gone
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');
const logger = require('./logger.cjs');

const MODES = new Set(['present', 'away', 'idle']);
const IDLE_AFTER_S = 600; // present + this much idle → idle
const ARM_AFTER_S = 120; // manual away + this much idle → he really left
const BACK_UNDER_S = 30; // input this recent → back at the PC
const TICK_MS = 15000;

const stateFile = () => path.join(U.dataRoot(), 'presence.json');
const markerPath = () => path.join(U.dataRoot(), 'presence', 'at-pc');

let pm = null; // electron powerMonitor, required lazily in start()
let timer = null;
let current = null;
let locked = false;
let armedFor = null; // `since` of the away state that got armed (per process)
const listeners = [];

// Pure transition rule. The click that sets 'away' is itself input, so manual
// away must not return on "idle < 30 s" until it was armed by a real absence.
function decide(mode, idleSeconds, armed) {
  const idle = Number(idleSeconds) || 0;
  if (mode === 'present') return { mode: idle >= IDLE_AFTER_S ? 'idle' : 'present', armed: false };
  if (mode === 'away') {
    if (armed && idle < BACK_UNDER_S) return { mode: 'present', armed: false };
    return { mode: 'away', armed: Boolean(armed) || idle >= ARM_AFTER_S };
  }
  if (mode === 'idle') return { mode: idle < BACK_UNDER_S ? 'present' : 'idle', armed: false };
  return { mode: 'present', armed: false };
}

function readState() {
  const s = U.readJson(stateFile(), null);
  if (s && MODES.has(s.mode)) return { mode: s.mode, since: Number(s.since) || 0, why: String(s.why || '') };
  return { mode: 'present', since: 0, why: 'default' };
}

function get() {
  return { ...(current || readState()) };
}

function syncMarker(mode) {
  const file = markerPath();
  try {
    if (mode === 'present') {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      }
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch (e) {
    logger.warn('presence marker sync failed: ' + e.message);
  }
}

function notify() {
  const s = get();
  for (const fn of listeners) { try { fn(s); } catch {} }
}

// adopt a state read from disk (another process may have written it)
function adopt(s) {
  const changed = !current || current.mode !== s.mode;
  current = s;
  syncMarker(s.mode);
  if (changed) notify();
}

function set(mode, why) {
  if (!MODES.has(mode)) return get();
  const next = { mode, since: Date.now(), why: String(why || '') };
  const file = stateFile();
  // pid in the tmp name: several workspace processes may write at once
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    U.ensureDir(path.dirname(file));
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    logger.warn('presence.json write failed: ' + e.message);
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  if (mode === 'away') armedFor = null;
  logger.info(`presence: ${mode} (${why})`);
  adopt(next);
  return get();
}

function idleNow() {
  if (!pm) return 0;
  try {
    // a locked screen is "not at the PC" however recent the last input was —
    // Win+L right after typing would otherwise read as back within one tick
    if (locked || pm.getSystemIdleState(1) === 'locked') return Infinity;
    return pm.getSystemIdleTime();
  } catch {
    return 0;
  }
}

function tick() {
  const cur = readState();
  adopt(cur);
  const idle = idleNow();
  const armed = cur.mode === 'away' && armedFor === cur.since;
  const d = decide(cur.mode, idle, armed);
  if (cur.mode === 'away' && d.armed && !armed) {
    armedFor = cur.since;
    logger.info(`presence: away armed (idle ${Number.isFinite(idle) ? idle + 's' : 'locked'})`);
  }
  if (d.mode !== cur.mode) {
    set(d.mode, d.mode === 'present' ? 'back at the PC' : (Number.isFinite(idle) ? `idle ${idle}s` : 'screen locked'));
  }
}

function onLock() {
  locked = true;
  if (readState().mode === 'present') set('idle', 'screen locked');
}

function onUnlock() {
  locked = false;
  if (readState().mode !== 'present') set('present', 'screen unlocked');
}

function onFileChange() {
  adopt(readState());
}

function start() {
  if (timer) return;
  pm = require('electron').powerMonitor;
  current = null;
  adopt(readState()); // marker matches the state from the first moment
  pm.on('lock-screen', onLock);
  pm.on('unlock-screen', onUnlock);
  fs.watchFile(stateFile(), { interval: 1000 }, onFileChange);
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  try { fs.unwatchFile(stateFile(), onFileChange); } catch {}
  if (pm) {
    pm.removeListener('lock-screen', onLock);
    pm.removeListener('unlock-screen', onUnlock);
  }
}

function onChange(fn) {
  listeners.push(fn);
}

module.exports = { start, stop, get, set, decide, markerPath, onChange };
