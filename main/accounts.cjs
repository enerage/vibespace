'use strict';
// Claude accounts (RESEARCH-MULTISUB.md). Every claude tab runs on an ACCOUNT:
//   login — the stored `/login` (always present, keeps Remote Control / phone)
//   token — a `claude setup-token` OAuth token, handed to claude through
//           CLAUDE_CODE_OAUTH_TOKEN by the pty's `claude` wrapper (ptyhost)
// All accounts share one ~/.claude, so transcripts and session tracking are
// untouched. When a turn fails on a usage limit, the account is marked exhausted
// until its reset and the tab continues on the next available one.
//
// Machine-wide: <dataRoot>/accounts.json (order, labels, exhaustion, per-account
// limits), re-read when its mtime changes — every workspace is its own process.
// Token blobs: <dataRoot>/accounts/<id>.dpapi, Windows DPAPI (CurrentUser).
// A token is NEVER logged, never put on a command line, never sent to a renderer.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const U = require('./util.cjs');
const logger = require('./logger.cjs');

const LOGIN = 'login';
const LOGIN_LABEL = 'Logged-in account';
const TOKEN_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/; // lenient form of sk-ant-oat01-…
// not a bare "limit reached": a short 429 says "Rate limit reached" and must not move agents
const LIMIT_TEXT_RE = /hit your [\w -]*limit|usage limit|limit\s*·\s*resets/i;
const NOT_USAGE_RE = /usage credits/i; // "out of usage credits" is a billing setting, not a limit
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

const file = () => path.join(U.dataRoot(), 'accounts.json');
const blobDir = () => path.join(U.dataRoot(), 'accounts');
const blobPath = (id) => path.join(blobDir(), `${id}.dpapi`);

// System32's powershell by absolute path: under a stripped PATH a bare name fails
function psExe() {
  const ps = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(ps) ? ps : 'powershell.exe';
}

// env for a Windows PowerShell 5.1 child: without PSModulePath, so a value
// inherited from PowerShell 7 (VibeSpace started from a pwsh prompt) can't break
// module autoload ("ConvertTo-SecureString … module could not be loaded")
function psEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PSMODULEPATH') delete env[k];
  return Object.assign(env, extra);
}

// ---------- store ----------
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const accounts = {};
  if (r.accounts && typeof r.accounts === 'object') {
    for (const [id, a] of Object.entries(r.accounts)) {
      if (!a || typeof a !== 'object' || id === LOGIN) continue;
      accounts[id] = { label: String(a.label || id).slice(0, 60), kind: 'token' };
    }
  }
  accounts[LOGIN] = { label: (r.accounts && r.accounts[LOGIN] && String(r.accounts[LOGIN].label || '').slice(0, 60)) || LOGIN_LABEL, kind: 'login' };
  const order = [];
  for (const id of Array.isArray(r.order) ? r.order : []) {
    if (accounts[id] && !order.includes(id)) order.push(id);
  }
  if (!order.includes(LOGIN)) order.unshift(LOGIN); // first by default
  for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id);
  const exhausted = {};
  if (r.exhausted && typeof r.exhausted === 'object') {
    for (const [id, e] of Object.entries(r.exhausted)) {
      if (accounts[id] && e && Number.isFinite(e.until)) exhausted[id] = { until: e.until, reason: e.reason ? String(e.reason).slice(0, 200) : null };
    }
  }
  const limits = {};
  if (r.limits && typeof r.limits === 'object') {
    for (const [id, l] of Object.entries(r.limits)) {
      if (accounts[id] && l && typeof l === 'object' && l.limits) limits[id] = { at: Number(l.at) || 0, limits: l.limits };
    }
  }
  return { order, accounts, exhausted, limits };
}

let cache = null; // { key, data }
function statKey() {
  try { const st = fs.statSync(file()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

function read() {
  const key = statKey();
  if (cache && cache.key === key) return cache.data;
  const data = normalize(key ? U.readJson(file(), null) : null);
  cache = { key, data };
  return data;
}

function write(data) {
  const f = file();
  // pid in the tmp name: several workspace processes may write at once
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    U.ensureDir(path.dirname(f));
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) {
    logger.warn('accounts.json write failed: ' + e.message);
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  cache = null;
}

// read-modify-write; fn returns false to skip the write
function update(fn) {
  const d = read();
  const next = { order: [...d.order], accounts: { ...d.accounts }, exhausted: { ...d.exhausted }, limits: { ...d.limits } };
  if (fn(next) === false) return false;
  write(normalize(next));
  return true;
}

// ---------- state ----------
function isExhausted(d, id, now) {
  const e = d.exhausted[id];
  return Boolean(e && e.until > now);
}

// the logged-in account's limits are the shared <dataRoot>/limits.json copy
// (claudefeed's); token accounts keep theirs here. Raw statusLine window shape.
function loginLimits(now) {
  const j = U.readJson(path.join(U.dataRoot(), 'limits.json'), null);
  if (!j || !j.limits || typeof j.at !== 'number' || now - j.at > 6 * 3600 * 1000) return null;
  const w = (x) => (x && typeof x.pct === 'number' ? { used_percentage: x.pct, resets_at: x.resetsAt ?? null } : undefined);
  const out = {};
  if (w(j.limits.fiveHour)) out.five_hour = w(j.limits.fiveHour);
  if (w(j.limits.sevenDay)) out.seven_day = w(j.limits.sevenDay);
  return Object.keys(out).length ? out : null;
}

function usable(d, id, now) {
  if (!d.accounts[id] || isExhausted(d, id, now)) return false;
  // a token account whose blob is gone could never start: skip it
  return id === LOGIN || fs.existsSync(blobPath(id));
}

// first account (in preference order) usable now, other than excludeId
function pick(excludeId = null, now = Date.now()) {
  const d = read();
  for (const id of d.order) if (id !== excludeId && usable(d, id, now)) return id;
  return null;
}

function state(now = Date.now()) {
  const d = read();
  const accounts = d.order.map((id) => {
    const a = d.accounts[id];
    const ex = isExhausted(d, id, now) ? d.exhausted[id] : null; // expired entries drop out
    return {
      id,
      label: a.label,
      kind: a.kind,
      exhaustedUntil: ex ? ex.until : null,
      reason: ex ? ex.reason : null,
      limits: id === LOGIN ? loginLimits(now) : ((d.limits[id] && d.limits[id].limits) || null),
    };
  });
  return { accounts, pick: pick(null, now) };
}

const has = (id) => Boolean(read().accounts[id]);
const labelOf = (id) => (read().accounts[id] || {}).label || id;

// ---------- DPAPI ----------
// .NET DPAPI directly, no ConvertTo-SecureString: that cmdlet's module fails to
// load in Windows PowerShell 5.1 when PSModulePath came from a PowerShell 7 parent.
// Blob = hex of ProtectedData.Protect(UTF-8 token, CurrentUser).
const DPAPI_LOAD = "[void][Reflection.Assembly]::LoadWithPartialName('System.Security')";
const ENCRYPT_PS = `${DPAPI_LOAD}; $t = [Console]::In.ReadToEnd().Trim(); `
  + `$b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t), $null, 'CurrentUser'); `
  + `[Console]::Out.Write(-join ($b | ForEach-Object { $_.ToString('x2') }))`;
// sets $tok from the blob file at $blob — the pty wrapper (ptyhost) and smoke run this
const DECRYPT_PS = `${DPAPI_LOAD}; $h = [IO.File]::ReadAllText($blob).Trim(); `
  + `$bytes = [byte[]]::new($h.Length / 2); `
  + `for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($h.Substring($i * 2, 2), 16) }; `
  + `$tok = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'))`;

// token on STDIN only (never argv); resolves the DPAPI hex blob
function encrypt(token) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn(psExe(), ['-NoProfile', '-NonInteractive', '-Command', ENCRYPT_PS], { windowsHide: true, env: psEnv() });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('DPAPI encrypt timed out')); }, 20000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const blob = out.trim();
      if (code === 0 && /^[0-9a-f]{40,}$/i.test(blob)) resolve(blob);
      else reject(new Error(`DPAPI encrypt failed (exit ${code})${err ? ': ' + err.trim().split(/\r?\n/)[0].slice(0, 160) : ''}`));
    });
    child.stdin.end(token);
  });
}

// ---------- mutations ----------
async function add(label, token) {
  const name = String(label || '').trim().slice(0, 60);
  // pasted tokens may carry line breaks or spaces from wrapping
  const tok = String(token || '').replace(/\s+/g, '');
  if (!name) return { ok: false, error: 'Give the account a name.' };
  if (!TOKEN_RE.test(tok)) return { ok: false, error: 'That does not look like a setup-token (it starts with sk-ant-oat01-).' };
  let id;
  do { id = `${U.slugify(name).slice(0, 24)}-${U.randId(4)}`; } while (id === LOGIN || has(id));
  let blob;
  try {
    blob = await encrypt(tok);
  } catch (e) {
    logger.warn(`accounts: add failed (${e.message})`); // never the token
    return { ok: false, error: 'Could not encrypt the token: ' + e.message };
  }
  try {
    U.ensureDir(blobDir());
    fs.writeFileSync(blobPath(id), blob);
  } catch (e) {
    return { ok: false, error: 'Could not save the token: ' + e.message };
  }
  update((d) => { d.accounts[id] = { label: name, kind: 'token' }; d.order.push(id); });
  logger.info(`accounts: added ${id} ("${name}")`);
  return { ok: true, state: state() };
}

function remove(id) {
  if (id === LOGIN || !has(id)) return state();
  update((d) => {
    delete d.accounts[id];
    delete d.exhausted[id];
    delete d.limits[id];
    d.order = d.order.filter(x => x !== id);
  });
  try { fs.rmSync(blobPath(id), { force: true }); } catch {}
  logger.info(`accounts: removed ${id}`);
  return state();
}

function rename(id, label) {
  const name = String(label || '').trim().slice(0, 60);
  if (!name || !has(id)) return state();
  update((d) => { d.accounts[id] = { ...d.accounts[id], label: name }; });
  return state();
}

function move(id, delta) {
  const step = Number(delta) < 0 ? -1 : 1;
  update((d) => {
    const i = d.order.indexOf(id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= d.order.length) return false;
    [d.order[i], d.order[j]] = [d.order[j], d.order[i]];
    return true;
  });
  return state();
}

// forget exhaustion (the user knows better, e.g. a plan upgrade)
function clear(id) {
  update((d) => {
    if (!d.exhausted[id]) return false;
    delete d.exhausted[id];
    return true;
  });
  return state();
}

// only ever EXTENDS an exhaustion window — a later, shorter guess never shortens it
function markExhausted(id, untilMs, reason) {
  const until = Number(untilMs);
  if (!Number.isFinite(until) || until <= Date.now()) return false;
  const changed = update((d) => {
    if (!d.accounts[id]) return false;
    const prev = d.exhausted[id];
    if (prev && prev.until >= until) return false;
    d.exhausted[id] = { until, reason: reason ? String(reason).slice(0, 200) : null };
    return true;
  });
  if (changed) logger.info(`accounts: ${id} exhausted until ${new Date(until).toISOString()} (${reason || '?'})`);
  return changed;
}

// raw statusLine rate_limits ({ five_hour, seven_day }) of a TOKEN account;
// written only on change
function setLimits(id, rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object' || id === LOGIN) return false;
  const win = (w) => (w && typeof w.used_percentage === 'number'
    ? { used_percentage: w.used_percentage, resets_at: typeof w.resets_at === 'number' ? w.resets_at : null } : undefined);
  const lim = {};
  if (win(rateLimits.five_hour)) lim.five_hour = win(rateLimits.five_hour);
  if (win(rateLimits.seven_day)) lim.seven_day = win(rateLimits.seven_day);
  if (!Object.keys(lim).length) return false;
  return update((d) => {
    if (!d.accounts[id]) return false;
    if (d.limits[id] && JSON.stringify(d.limits[id].limits) === JSON.stringify(lim)) return false;
    d.limits[id] = { at: Date.now(), limits: lim };
    return true;
  });
}

// ---------- change feed (any process) ----------
const listeners = [];
let watching = false;
let lastKey = null;
function onFileChange() {
  const key = statKey();
  if (key === lastKey) return;
  lastKey = key;
  const s = state();
  for (const fn of listeners) { try { fn(s); } catch (e) { logger.warn('accounts listener: ' + e.message); } }
}

function onChange(fn) {
  listeners.push(fn);
  if (watching) return;
  watching = true;
  lastKey = statKey();
  fs.watchFile(file(), { interval: 1000 }, onFileChange);
}

function unwatch() {
  if (!watching) return;
  watching = false;
  try { fs.unwatchFile(file(), onFileChange); } catch {}
}

// ---------- limit detection ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_RE = new RegExp(
  'resets\\s+(?:(' + MONTHS.join('|') + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(?:at\\s+)?)?'
  + '(?:(\\d{1,2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)?)?', 'i');

// "resets Oct 5, 3pm (Europe/Berlin)" | "resets Oct 5 at 3:30pm" | "resets 3pm (…)"
// | "resets 15:00" → epoch ms in the machine's LOCAL time zone (the tz name is
// ignored). No date → today, or tomorrow if passed. A date without a year → this
// year, or next year when that is more than a day in the past.
function parseReset(text, now = Date.now()) {
  const m = RESET_RE.exec(String(text || ''));
  if (!m) return null;
  const [, mon, day, hh, mm, ap] = m;
  const hasTime = hh !== undefined && (mm !== undefined || ap !== undefined);
  if (!mon && !hasTime) return null;
  let h = hasTime ? Number(hh) : 0;
  const min = hasTime && mm !== undefined ? Number(mm) : 0;
  if (ap) {
    if (h < 1 || h > 12) return null;
    const pm = /^p/i.test(ap);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || min > 59) return null;
  const ref = new Date(now);
  if (mon) {
    const mi = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
    const d = Number(day);
    if (d < 1 || d > 31) return null;
    let t = new Date(ref.getFullYear(), mi, d, h, min, 0, 0);
    if (t.getTime() < now - 24 * 3600 * 1000) t = new Date(ref.getFullYear() + 1, mi, d, h, min, 0, 0);
    return t.getTime();
  }
  let t = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, min, 0, 0);
  if (t.getTime() <= now) t = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1, h, min, 0, 0);
  return t.getTime();
}

// statusLine windows at >= 100 % — raw ({ five_hour: { used_percentage, resets_at } })
// or the feed reducer's form ({ fiveHour: { pct, resetsAt } })
function fullWindows(rl, now = Date.now()) {
  if (!rl || typeof rl !== 'object') return [];
  const out = [];
  for (const w of [rl.five_hour, rl.seven_day, rl.fiveHour, rl.sevenDay]) {
    if (!w || typeof w !== 'object') continue;
    const pct = typeof w.used_percentage === 'number' ? w.used_percentage : w.pct;
    const reset = typeof w.resets_at === 'number' ? w.resets_at : w.resetsAt;
    // a window whose reset already passed is stale, not full
    if (typeof reset === 'number' && reset * 1000 <= now) continue;
    if (typeof pct === 'number' && pct >= 100) out.push({ pct, resetsAt: typeof reset === 'number' ? reset : null });
  }
  return out;
}

// quota = the transcript error line's `quotaLimits` ({ status: 'rejected', resetsAt
// (epoch s), rateLimitType: 'seven_day' }, seen live 2026-10-01): the most exact
// signal, so it wins over the text and the statusLine windows
function classifyFailure(failure, feedRateLimits, transcriptText, now = Date.now(), quota = null) {
  const f = failure || {};
  const text = [f.message, transcriptText].filter(s => typeof s === 'string' && s).join('\n');
  const rateish = f.type === 'rate_limit' || /rate[ _-]?limit/i.test(text);
  const byText = rateish && LIMIT_TEXT_RE.test(text) && !NOT_USAGE_RE.test(text);
  const byQuota = Boolean(quota && quota.status === 'rejected' && !NOT_USAGE_RE.test(text));
  const full = fullWindows(feedRateLimits, now);
  if (!byText && !byQuota && !full.length) return { usageLimit: false, until: null, reason: null };
  const resets = full.map(w => w.resetsAt).filter(v => typeof v === 'number').map(v => v * 1000);
  const quotaUntil = byQuota && typeof quota.resetsAt === 'number' && quota.resetsAt * 1000 > now ? quota.resetsAt * 1000 : null;
  const until = quotaUntil || (byText && parseReset(text, now)) || (resets.length ? Math.max(...resets) : null) || now + DEFAULT_BACKOFF_MS;
  const named = /hit your ([\w-]+(?: [\w-]+)?) limit/i.exec(text);
  const reason = named ? `${named[1].toLowerCase()} limit` : (byText ? 'usage limit' : 'limit reached');
  return { usageLimit: true, until, reason };
}

// The LAST `"isApiErrorMessage":true` line of a transcript (only the tail is read):
// { error, text, timestamp (epoch ms | null) } or null
function lastApiErrorText(jsonlPath, maxBytes = 256 * 1024) {
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
      if (!line.includes('"isApiErrorMessage":true')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; } // the cut first line
      const c = j.message && j.message.content;
      const text = typeof c === 'string' ? c
        : (Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '');
      const ts = Date.parse(j.timestamp);
      const q = j.quotaLimits && typeof j.quotaLimits === 'object' ? j.quotaLimits : null;
      const quota = q ? { status: q.status || null, resetsAt: typeof q.resetsAt === 'number' ? q.resetsAt : null, type: q.rateLimitType || null } : null;
      return { error: typeof j.error === 'string' ? j.error : null, text, timestamp: Number.isFinite(ts) ? ts : null, quota };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = {
  LOGIN,
  LIMIT_TEXT_RE,
  DECRYPT_PS,
  state,
  pick,
  has,
  labelOf,
  add,
  remove,
  rename,
  move,
  clear,
  markExhausted,
  setLimits,
  onChange,
  unwatch,
  blobPath,
  blobDir,
  parseReset,
  classifyFailure,
  lastApiErrorText,
  _normalize: normalize,
  _psExe: psExe,
  _psEnv: psEnv,
};
