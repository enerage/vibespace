'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  pty = null;
}

const sessions = new Map(); // termId -> IPty
const lastActivity = new Map(); // termId -> ms of last data in or out (reload guard)
const lastOutput = new Map(); // termId -> ms of last OUTPUT only (input excluded: with
// mouse tracking on, merely moving the mouse over claude's terminal sends input)
const metas = new Map(); // termId -> { cwd, statusFile, wsId } — bookkeeping for list()
const buffers = new Map(); // termId -> { chunks: [], len } — output ring for re-attach
const BUFFER_CAP = 256 * 1024; // per-terminal bytes kept so a reload can restore scrollback

function pushBuffer(termId, chunk) {
  let b = buffers.get(termId);
  if (!b) { b = { chunks: [], len: 0 }; buffers.set(termId, b); }
  b.chunks.push(chunk);
  b.len += chunk.length;
  while (b.len > BUFFER_CAP && b.chunks.length > 1) {
    b.len -= b.chunks[0].length;
    b.chunks.shift();
  }
}
let dataListener = () => {};
let exitListener = () => {};
const logger = require('./logger.cjs');
const U = require('./util.cjs');
const presence = require('./presence.cjs');

function available() {
  return Boolean(pty);
}

// Windows stores the variable as "Path"; process.env is case-insensitive, but a
// COPY ({ ...process.env }) is a plain object where "Path" and "PATH" are two
// different keys. Writing env.PATH on the copy used to ADD a second, stripped
// PATH next to the full "Path" — and the stripped one won in the child's
// environment block (the "node/python/mcp-postgres not found in VibeSpace
// terminals" bug, 2026-09-29). Always collapse to ONE key.
function withSinglePath(env, value) {
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH') delete env[k];
  }
  env.Path = value;
  return env;
}

function readPath(env) {
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH' && env[k]) return env[k];
  }
  return '';
}

function ensureClaudeOnPath(env) {
  const claudeDir = path.join(os.homedir(), '.local', 'bin');
  if (fs.existsSync(claudeDir)) {
    const cur = readPath(env);
    const already = cur.toLowerCase().split(';').some(p => p.trim().replace(/\\+$/, '') === claudeDir.toLowerCase());
    if (!already) withSinglePath(env, `${claudeDir};${cur}`);
  }
  return env;
}

// A window spawned from a stripped environment (e.g. an agent shell whose PATH lacks
// System32) used to hand that broken PATH to every terminal and every process they
// start — claude hooks then fail with 'node/powershell: command not found'. Repair the
// system-critical entries so every VibeSpace terminal is fully usable regardless of
// how its window was launched.
function repairPath(env) {
  // built with path.join, not literals: 'C:\Windows\...\v1.0' in a JS string is
  // "C:Windows...<vertical-tab>1.0" — this very function was injecting mangled entries
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const mustHave = [
    path.join(sysRoot, 'System32'),
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    sysRoot,
  ];
  const parts = readPath(env).split(';').map(s => s.trim()).filter(Boolean);
  const have = new Set(parts.map(p => p.toLowerCase()));
  for (const dir of mustHave) {
    if (!have.has(dir.toLowerCase())) parts.unshift(dir);
  }
  return withSinglePath(env, parts.join(';'));
}

function create(termId, cwd, cols = 120, rows = 30, wsId = null) {
  if (!pty) throw new Error('node-pty is not available — run: npm install && npm run rebuild');
  if (sessions.has(termId)) kill(termId);
  // start from ONE path key holding the full value (process.env.PATH reads the
  // real, registry-rebuilt value case-insensitively)
  const base = withSinglePath({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, process.env.PATH || '');
  const env = repairPath(ensureClaudeOnPath(base));
  // claude hooks (injected via `claude --settings`) append working|waiting|done to
  // this file; main watches the directory and turns it into tab status lights
  let statusFile = null;
  if (wsId) {
    statusFile = path.join(U.dataRoot(), 'instances', wsId, 'status', `${termId}.status`);
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.rmSync(statusFile, { force: true });
    } catch {}
    env.VIBESPACE_TERM_STATUS = statusFile;
  }
  // claude's statusLine command and HTTP hooks send this back as the x-vs-term
  // header, so the feed server (claudefeed.cjs) knows which tab a payload is for
  env.VIBESPACE_TERM_ID = termId;
  // away mode: claude skips phone pushes while this file exists (presence.cjs owns
  // it machine-wide); read at claude launch, so only new agents pick it up
  env.CLAUDE_CLIENT_PRESENCE_FILE = presence.markerPath();
  const proc = pty.spawn('powershell.exe', ['-NoLogo'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    useConpty: true,
  });
  sessions.set(termId, proc);
  metas.set(termId, { cwd, statusFile, wsId });
  buffers.set(termId, { chunks: [], len: 0 });
  logger.info(`pty spawn: ${termId} cwd=${cwd}`);
  proc.onData(chunk => {
    const t = Date.now();
    lastActivity.set(termId, t);
    lastOutput.set(termId, t);
    pushBuffer(termId, chunk);
    dataListener(termId, chunk);
  });
  proc.onExit(({ exitCode }) => {
    sessions.delete(termId);
    const meta = metas.get(termId);
    if (meta?.statusFile) { try { fs.rmSync(meta.statusFile, { force: true }); } catch {} }
    metas.delete(termId);
    buffers.delete(termId);
    lastActivity.delete(termId);
    lastOutput.delete(termId);
    logger.info(`pty exit: ${termId} code=${exitCode}`);
    exitListener(termId);
  });
  return proc;
}

function write(termId, data) {
  const s = sessions.get(termId);
  if (s) {
    lastActivity.set(termId, Date.now()); // input counts as activity too (reload guard)
    s.write(data);
  }
}

function resize(termId, cols, rows) {
  const s = sessions.get(termId);
  if (s) {
    try { s.resize(cols, rows); } catch {}
  }
}

function kill(termId) {
  const s = sessions.get(termId);
  if (s) {
    const meta = metas.get(termId);
    if (meta?.statusFile) { try { fs.rmSync(meta.statusFile, { force: true }); } catch {} }
    sessions.delete(termId);
    metas.delete(termId);
    buffers.delete(termId);
    lastActivity.delete(termId);
    lastOutput.delete(termId);
    try { s.kill(); } catch {}
  }
}

function killAll() {
  for (const id of [...sessions.keys()]) kill(id);
}

function alive(termId) {
  return sessions.has(termId);
}

// owning workspace of a live pty (null if unknown/dead) — the feed server's
// termId -> wsId lookup
function wsOf(termId) {
  return (sessions.has(termId) && metas.get(termId)?.wsId) || null;
}

// Layer 3: true when any pty produced output or received input recently — lets the
// (opt-in) dev watcher defer its reload/relaunch while agents are mid-run or the
// user is typing. Claude streams continuously while working, so a few seconds of
// silence is a reliable "idle" signal.
function busyNow({ idleMs = 5000, now = Date.now() } = {}) {
  for (const ts of lastActivity.values()) {
    if (now - ts < idleMs) return true;
  }
  return false;
}

// ms since this terminal last produced output (Infinity if never / dead)
function outputAge(termId, now = Date.now()) {
  const ts = lastOutput.get(termId);
  return ts ? now - ts : Infinity;
}

// Live ptys with their buffered output, so a reloaded renderer can re-attach to the
// still-running processes instead of killing and re-spawning them (Layer 2:
// a renderer reload must never kill an agent).
function list() {
  const out = [];
  for (const [termId] of sessions) {
    const b = buffers.get(termId);
    out.push({
      termId,
      cwd: metas.get(termId)?.cwd || '',
      buffer: b ? b.chunks.join('') : '',
    });
  }
  return out;
}

module.exports = {
  available,
  create,
  write,
  resize,
  kill,
  killAll,
  alive,
  wsOf,
  list,
  busyNow,
  outputAge,
  _withSinglePath: withSinglePath,
  onData: (fn) => { dataListener = fn; },
  onExit: (fn) => { exitListener = fn; },
};
