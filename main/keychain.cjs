'use strict';
// macOS Keychain through /usr/bin/security: the darwin stand-in for the DPAPI
// blobs of accounts.cjs (RESEARCH-MAC.md Part 3 Q4). Generic-password items in
// the login keychain, created by `security` itself, so its default ACL trusts
// /usr/bin/security: main and the pty's `claude` wrapper read them without a
// prompt, the same CurrentUser trust model as DPAPI and as Claude Code's own item.
//
// Item names are a CONTRACT with the shell wrapper (ptyhost, darwin):
//   token account    service `VibeSpace-account-<id>`,  account `vibespace`, value = the raw token
//                    (the wrapper runs `security find-generic-password -s "VibeSpace-account-<id>" -a vibespace -w`)
//   endpoint account service `VibeSpace-endpoint-<id>`, account `vibespace`, value = base64 of the
//                    KEY=VALUE lines (only main reads it; base64 keeps quotes and line breaks
//                    out of security's line parser, and `-w` prints non-printable values as hex)
//
// A secret never goes on a command line: writes feed `security -i` ONE command
// line on stdin. Its parser (Apple Security, SecurityTool/macOS/security.c
// split_line + readline.c) splits on whitespace, a word starting with " or '
// runs to the same quote, and a backslash takes the next character literally.
// A line is cut at 4095 bytes (the rest would run as the NEXT command) and a
// last line without '\n' is dropped, so the line is capped and always ends in '\n'.
//
// Claude Code's own claude.ai login (verified in the 2.1.302 bundle): service
// `Claude Code-credentials`, or with CLAUDE_CONFIG_DIR set
// `Claude Code-credentials-<first 8 hex of sha256(that exact string, NFC)>`
// (no path.resolve, no trailing-slash trim). CLAUDE_SECURESTORAGE_CONFIG_DIR, when
// defined, replaces CLAUDE_CONFIG_DIR for the name (empty = the plain name). Its
// account is "claude-code-user" (older builds: $USER), so those items are
// looked up by service only. We only ever test that they EXIST: no -w, no secret read.
const crypto = require('node:crypto');
const { spawn, spawnSync, execFile } = require('node:child_process');

const SECURITY = '/usr/bin/security';
const ACCOUNT = 'vibespace';
const NOT_FOUND = 44; // errSecItemNotFound as security's exit status
const MAX_LINE = 4000; // security's line buffer holds 4095 bytes
const CLAUDE_SERVICE = 'Claude Code-credentials';

const tokenService = (id) => `VibeSpace-account-${id}`;
const endpointService = (id) => `VibeSpace-endpoint-${id}`;

// Claude Code's credentials item for a config dir (null/'' = the default one)
function claudeService(configDir) {
  if (!configDir) return CLAUDE_SERVICE;
  return `${CLAUDE_SERVICE}-${crypto.createHash('sha256').update(String(configDir).normalize('NFC')).digest('hex').slice(0, 8)}`;
}
// the item a claude started with this env uses
function claudeLoginService(env = process.env) {
  const s = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (s !== undefined) return claudeService(s || null);
  return claudeService(env.CLAUDE_CONFIG_DIR || null);
}

// ---------- security -i command line (pure) ----------
// one argument, always double-quoted; printable ASCII only (tokens, base64,
// service names), so no locale-dependent isspace() and no line breaks
function quoteArg(s) {
  const v = String(s);
  if (!/^[\x20-\x7e]*$/.test(v)) throw new Error('only printable ASCII can go through security -i');
  return `"${v.replace(/[\\"]/g, '\\$&')}"`;
}
function commandLine(args) {
  const line = args.map(quoteArg).join(' ');
  if (line.length > MAX_LINE) throw new Error(`too long for the Keychain (${line.length} bytes, at most ${MAX_LINE})`);
  return line + '\n';
}
// JS port of security.c split_line (MAX_ARGS 32), for the smoke test
function splitLine(line) {
  const out = [];
  let cur = '';
  let state = 'ws';
  let q = '';
  const isspace = (c) => c === ' ' || (c >= '\t' && c <= '\r');
  for (const c of String(line)) {
    if (state === 'ws') {
      if (isspace(c)) continue;
      if (c === '"' || c === "'") { q = c; state = 'q'; cur = ''; continue; }
      state = 'arg';
      cur = '';
    }
    if (state === 'arg') {
      if (c === '\\') { state = 'argEsc'; continue; }
      if (isspace(c)) { out.push(cur); state = 'ws'; if (out.length >= 32) break; } else cur += c;
    }
    if (state === 'q') {
      if (c === '\\') { state = 'qEsc'; continue; }
      if (c === q) { out.push(cur); state = 'ws'; if (out.length >= 32) break; } else cur += c;
    }
    if (state === 'argEsc') { cur += c; state = 'arg'; }
    if (state === 'qEsc') { cur += c; state = 'q'; }
  }
  if (state !== 'ws') out.push(cur);
  return out;
}

// The keychain itself is unusable (locked, missing, no UI to ask): the kinds
// Claude Code tells apart too. null = some other error.
function unavailableKind(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('unable to open') || t.includes('could not open')) return 'keychain_unavailable';
  if (t.includes('errsecnodefaultkeychain') || t.includes('default keychain') || t.includes('no keychain')) return 'no_keychain';
  if (t.includes('errsecinteractionnotallowed') || t.includes('interaction is not allowed') || t.includes('no user interaction')) return 'interaction_not_allowed';
  if (t.includes('locked') || t.includes('unlock')) return 'keychain_locked';
  if (t.includes('enoent')) return 'no_security_tool';
  return null;
}

const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0].slice(0, 160);

// ---------- existence (cached) ----------
// usable()/state() ask often (every account, every state push): a positive
// answer is kept 10 min, a negative one 1 min; our own write/remove update it.
const POS_TTL_MS = 10 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000;
const existCache = new Map(); // `${service}\0${account}` -> { v, at }
let lastError = null;
function forgetService(service) {
  for (const k of existCache.keys()) if (k.startsWith(`${service}\0`)) existCache.delete(k);
}

// attributes only (no -w): never reads the secret, never prompts for it.
// account null = any account (Claude's own items).
function exists(service, account = null, { maxAgeMs } = {}) {
  const key = `${service}\0${account || ''}`;
  const now = Date.now();
  const c = existCache.get(key);
  if (c && now - c.at < (maxAgeMs ?? (c.v ? POS_TTL_MS : NEG_TTL_MS))) return c.v;
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  const r = spawnSync(SECURITY, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
  let v;
  if (r.status === 0) v = true;
  else if (r.status === NOT_FOUND) v = false;
  else {
    // can't tell (locked keychain, timeout): keep the last answer, else "no"
    lastError = firstLine(r.stderr) || (r.error && r.error.message) || `exit ${r.status}`;
    v = c ? c.v : false;
  }
  existCache.set(key, { v, at: now });
  return v;
}

// ---------- read / write / remove ----------
// the value, or null when there is no such item
function read(service, account = ACCOUNT) {
  return new Promise((resolve, reject) => {
    execFile(SECURITY, ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) { resolve(String(stdout).replace(/\n$/, '')); return; }
        if (err.code === NOT_FOUND) { resolve(null); return; }
        reject(new Error(`Keychain read failed (${err.killed ? 'timed out' : `exit ${err.code}`})${stderr ? ': ' + firstLine(stderr) : ''}`));
      });
  });
}

// add or update (-U) in place; the value goes over stdin only. Resolves once a
// read-back returns the same value (security -i's exit status is the last
// command's result, which alone is not trusted).
function write(service, value, account = ACCOUNT) {
  let line;
  try { line = commandLine(['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]); } catch (e) { return Promise.reject(e); }
  const scrub = (s) => (value ? String(s).split(String(value)).join('<secret>') : String(s));
  return new Promise((resolve, reject) => {
    let err = '';
    const child = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('Keychain write timed out')); }, 20000);
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      forgetService(service);
      if (code !== 0 || /returned -?\d+/.test(err)) {
        reject(new Error(`Keychain write failed (exit ${code})${err ? ': ' + scrub(firstLine(err)) : ''}`));
        return;
      }
      read(service, account).then((back) => {
        if (back !== String(value)) { reject(new Error('Keychain write could not be verified')); return; }
        existCache.set(`${service}\0${account}`, { v: true, at: Date.now() });
        resolve();
      }, reject);
    });
    child.stdin.on('error', () => {}); // a security that died early: 'close' reports it
    child.stdin.end(line);
  });
}

// every item of that service+account (normally one); true when none is left
function remove(service, account = ACCOUNT) {
  let gone = false;
  for (let i = 0; i < 5 && !gone; i++) {
    const r = spawnSync(SECURITY, ['delete-generic-password', '-s', service, '-a', account], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status === NOT_FOUND) gone = true;
    else if (r.status !== 0) { lastError = firstLine(r.stderr) || (r.error && r.error.message) || `exit ${r.status}`; break; }
  }
  forgetService(service);
  return gone;
}

module.exports = {
  SECURITY,
  ACCOUNT,
  CLAUDE_SERVICE,
  MAX_LINE,
  tokenService,
  endpointService,
  claudeService,
  claudeLoginService,
  quoteArg,
  commandLine,
  splitLine,
  unavailableKind,
  exists,
  read,
  write,
  remove,
  lastError: () => lastError,
};
