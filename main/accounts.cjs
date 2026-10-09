'use strict';
// Claude accounts (RESEARCH-MULTISUB.md). Every claude tab runs on an ACCOUNT:
//   login — the stored `/login` (always present, keeps Remote Control / phone)
//   token — a `claude setup-token` OAuth token, handed to claude through
//           CLAUDE_CODE_OAUTH_TOKEN by the pty's `claude` wrapper (ptyhost)
//   endpoint — an Anthropic-compatible API (z.ai GLM, …): a pasted env block
//           (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN/API_KEY + models …) the
//           wrapper sets for that one claude call
// All accounts share one ~/.claude, so transcripts and session tracking are
// untouched. When a turn fails on a usage limit, the account is marked exhausted
// until its reset and the tab continues on the next available one OF THE SAME
// FAMILY: a conversation never crosses providers (a Claude conversation does not
// work when resumed on GLM). Family = 'anthropic' for login/token accounts,
// 'endpoint:<host of ANTHROPIC_BASE_URL>' for endpoint accounts.
//
// Machine-wide: <dataRoot>/accounts.json (order, labels, exhaustion, per-account
// limits), re-read when its mtime changes — every workspace is its own process.
// Endpoint accounts live in their OWN file, <dataRoot>/accounts-endpoints.json
// ({ <id>: { label, baseUrl, models } }), merged in on read: a window still on
// older main code rewrites accounts.json and turns every non-login account into
// a 'token' (and would hand the endpoint's blob to claude as an OAuth token), so
// it must never see one.
// Secret blobs, Windows DPAPI (CurrentUser): <dataRoot>/accounts/<id>.dpapi = a
// token; <id>.endpoint.dpapi = an endpoint's whole env as KEY=VALUE lines (older
// code looks for <id>.dpapi only, finds nothing and skips the account).
// A secret is NEVER logged, never put on a command line, never sent to a renderer.
const fs = require('node:fs');
const os = require('node:os');
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
const endpointsFile = () => path.join(U.dataRoot(), 'accounts-endpoints.json');
const blobDir = () => path.join(U.dataRoot(), 'accounts');
const tokenBlobPath = (id) => path.join(blobDir(), `${id}.dpapi`);
const endpointBlobPath = (id) => path.join(blobDir(), `${id}.endpoint.dpapi`);
const blobIn = (d, id) => ((d.accounts[id] || {}).kind === 'endpoint' ? endpointBlobPath(id) : tokenBlobPath(id));
const blobPath = (id) => blobIn(read(), id);

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
      const label = String(a.label || id).slice(0, 60);
      if (a.kind === 'endpoint') {
        const m = a.models && typeof a.models === 'object' ? a.models : {};
        const model = (v) => (typeof v === 'string' && v ? v.slice(0, 80) : null);
        accounts[id] = { label, kind: 'endpoint', baseUrl: String(a.baseUrl || '').slice(0, 300), models: { opus: model(m.opus), sonnet: model(m.sonnet), haiku: model(m.haiku) } };
      } else {
        accounts[id] = { label, kind: 'token' };
      }
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
      // at = when the evidence was seen (0 for entries written before 0.6.46)
      if (accounts[id] && e && Number.isFinite(e.until)) exhausted[id] = { until: e.until, reason: e.reason ? String(e.reason).slice(0, 200) : null, at: Number(e.at) || 0 };
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
const fileKey = (f) => {
  try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
};
const statKey = () => `${fileKey(file())}|${fileKey(endpointsFile())}`;

// accounts.json + accounts-endpoints.json → one normalized store. An endpoint
// entry still inside accounts.json (written by the first 0.6.49 build) moves
// to its own file, its blob to the new name.
function read() {
  const key = statKey();
  if (cache && cache.key === key) return cache.data;
  const raw = fileKey(file()) ? U.readJson(file(), null) : null;
  const eps = fileKey(endpointsFile()) || fs.existsSync(endpointsFile() + '.bak') ? U.readJson(endpointsFile(), null) : null;
  const merged = { ...(raw && typeof raw === 'object' ? raw : {}) };
  merged.accounts = { ...(raw && raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {}) };
  let migrate = false;
  for (const [id, a] of Object.entries(merged.accounts)) {
    if (!a || a.kind !== 'endpoint' || id === LOGIN) continue;
    migrate = true;
    try {
      if (!fs.existsSync(endpointBlobPath(id)) && fs.existsSync(tokenBlobPath(id))) fs.renameSync(tokenBlobPath(id), endpointBlobPath(id));
    } catch (e) { logger.warn(`accounts: endpoint ${id} blob rename failed (${e.message})`); }
  }
  if (eps && typeof eps === 'object') {
    for (const [id, e] of Object.entries(eps)) {
      if (id !== LOGIN && e && typeof e === 'object') merged.accounts[id] = { ...e, kind: 'endpoint' };
    }
  }
  const data = normalize(merged);
  if (migrate) {
    write(data);
    logger.info('accounts: endpoint accounts moved to accounts-endpoints.json');
  }
  cache = { key: statKey(), data };
  return data;
}

// one JSON file, atomically (pid in the tmp name: several workspace processes
// may write at once); unchanged content is not rewritten
function writeFile(f, obj) {
  const text = JSON.stringify(obj, null, 2);
  try { if (fs.readFileSync(f, 'utf8') === text) return; } catch {}
  // crash-safe (fsync, last good copy as .bak — CLAUDE.md "JSON files are
  // crash-safe"): these files hold endpoint accounts and conversation families,
  // and a read that falls back to {} would make the next write erase them
  try {
    U.ensureDir(path.dirname(f));
    U.writeJsonAtomic(f, obj);
  } catch (e) {
    logger.warn(`${path.basename(f)} write failed: ${e.message}`);
  }
}

// endpoint accounts → accounts-endpoints.json; everything else (and every id in
// `order`, exhaustion, limits) → accounts.json
function write(data) {
  const eps = {};
  const rest = {};
  for (const [id, a] of Object.entries(data.accounts)) {
    if (a.kind === 'endpoint') eps[id] = { label: a.label, baseUrl: a.baseUrl, models: a.models };
    else rest[id] = a;
  }
  writeFile(endpointsFile(), eps);
  writeFile(file(), { ...data, accounts: rest });
  cache = null;
}

// "Move all agents here": a machine-wide request { to, at } every workspace
// window applies to the tabs whose own account choice is older (renderer
// terms.js drainMoves). It lives in its OWN file: a window still running older
// main code rewrites accounts.json without keys it doesn't know, which would
// erase the request. It is retired after 12 h, when its account runs out and
// when the order is changed by hand, so it can never resurface days later.
const SWITCH_TTL_MS = 12 * 3600 * 1000;
const switchFile = () => path.join(U.dataRoot(), 'accounts-switch.json');
function readSwitch(now = Date.now()) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(switchFile(), 'utf8')); } catch {}
  if (!j || typeof j.to !== 'string' || !Number.isFinite(j.at) || now - j.at > SWITCH_TTL_MS) return null;
  return read().accounts[j.to] ? { to: j.to, at: j.at } : null;
}
function writeSwitch(v) {
  const f = switchFile();
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    U.ensureDir(path.dirname(f));
    fs.writeFileSync(tmp, JSON.stringify(v || { to: null, at: Date.now() }));
    fs.renameSync(tmp, f);
  } catch (e) {
    logger.warn('accounts-switch.json write failed: ' + e.message);
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
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
// (claudefeed's); token accounts keep theirs here. Raw statusLine window shape,
// plus `at` (ms, when the reading last changed). maxAgeMs: the chip hides a
// reading older than 6 h; the ranking keeps it (a reset time stays true, and a
// passed one is projected forward).
function loginLimits(now, maxAgeMs = 6 * 3600 * 1000) {
  const j = U.readJson(path.join(U.dataRoot(), 'limits.json'), null);
  if (!j || !j.limits || typeof j.at !== 'number' || now - j.at > maxAgeMs) return null;
  const w = (x) => (x && typeof x.pct === 'number' ? { used_percentage: x.pct, resets_at: x.resetsAt ?? null } : undefined);
  const out = {};
  if (w(j.limits.fiveHour)) out.five_hour = w(j.limits.fiveHour);
  if (w(j.limits.sevenDay)) out.seven_day = w(j.limits.sevenDay);
  return Object.keys(out).length ? { limits: out, at: j.at } : null;
}

// The stored `/login` exists only while claude's credentials file does. Someone
// with ONLY an API endpoint (no Claude login) must not get new agents on it.
let credentialsOverride = null; // smoke
const credentialsPath = () => credentialsOverride
  || path.join(process.env.USERPROFILE || os.homedir(), '.claude', '.credentials.json');
// The stored /login. Its credentials file is the usual proof; CLAUDE_CONFIG_DIR
// moves it, and an ANTHROPIC_API_KEY or an oauthAccount in ~/.claude.json also
// mean claude has Anthropic auth. Only with NONE of them (a PC that runs claude
// on an endpoint only) is the login account skipped.
const loggedIn = () => {
  if (fs.existsSync(credentialsPath())) return true;
  if (credentialsOverride) return false; // smoke pins the answer
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.CLAUDE_CONFIG_DIR && fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'))) return true;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || os.homedir(), '.claude.json'), 'utf8'));
    return Boolean(j && j.oauthAccount && j.oauthAccount.emailAddress);
  } catch { return false; }
};

function usable(d, id, now) {
  if (!d.accounts[id] || isExhausted(d, id, now)) return false;
  if (id === LOGIN) return loggedIn();
  // a token/endpoint account whose blob is gone could never start: skip it
  return fs.existsSync(blobIn(d, id));
}

// lower-cased host of an endpoint's base URL ('' when unreadable)
function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).host.toLowerCase(); } catch { return ''; }
}

// which provider a conversation on this account lives with; unknown/removed
// ids count as 'anthropic' (login and token accounts)
function familyIn(d, id) {
  const a = d.accounts[id];
  if (!a || a.kind !== 'endpoint') return 'anthropic';
  return `endpoint:${hostOf(a.baseUrl) || id}`;
}
const familyOf = (id) => familyIn(read(), id);

// ---------- automatic order ("use what expires first") ----------
// A weekly allowance not used before its reset is lost, so with the automatic
// order on, the Claude account (login + token) whose 7-day window resets
// SOONEST is preferred, as long as it has room. Manual order is only the
// tie-breaker; endpoint accounts keep their manual order (they report no plan
// limits), and every account keeps its family's SLOT in the manual order, so
// the preference between Claude and an endpoint stays the user's.
// The switch is machine-wide in its OWN file, <dataRoot>/accounts-auto.json
// ({ auto: bool }, default on): a window on older main code rewrites
// accounts.json without keys it doesn't know (same reason as accounts-switch.json).
const ROOM_MAX_PCT = 95; // a window at or above this % = no room
const WEEK_S = 7 * 86400;
const autoFile = () => path.join(U.dataRoot(), 'accounts-auto.json');
let autoCache = null; // { key, value }
function readAuto() {
  const key = fileKey(autoFile());
  if (autoCache && autoCache.key === key) return autoCache.value;
  const j = key || fs.existsSync(autoFile() + '.bak') ? U.readJson(autoFile(), null) : null;
  const value = j && typeof j.auto === 'boolean' ? j.auto : true;
  autoCache = { key, value };
  return value;
}
function setAuto(on) {
  writeFile(autoFile(), { auto: Boolean(on), at: Date.now() });
  autoCache = null;
  // a standing "move all" is a manual choice: the automatic order replaces it
  if (on && readSwitch()) writeSwitch(null);
  logger.info(`account auto: automatic order ${on ? 'on' : 'off'}`);
  return state();
}

// A 7-day reading at `nowS`: a passed reset is projected forward by whole
// weeks and that window's % is unknown-but-fresh = 0.
function weekWindow(w, nowS) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  let resetsAt = typeof w.resets_at === 'number' ? w.resets_at : null;
  let pct = w.used_percentage;
  if (resetsAt !== null && resetsAt <= nowS) {
    resetsAt += (Math.floor((nowS - resetsAt) / WEEK_S) + 1) * WEEK_S;
    pct = 0;
  }
  return { pct, resetsAt };
}
// A 5-hour reading: a passed reset just means its % is stale → 0.
function fiveWindow(w, nowS) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  const r = typeof w.resets_at === 'number' ? w.resets_at : null;
  if (r !== null && r <= nowS) return { pct: 0, resetsAt: null };
  return { pct: w.used_percentage, resetsAt: r };
}

// PURE. rows (manual order): [{ id, family, usable, exhaustedUntil (ms|null),
// limits: { five_hour, seven_day } | null }] → { ranked: [ids], info: { id: {
// room, weeklyResetAt (s, projected), weeklyPct, fivePct, fiveResetAt,
// blockedBy: 'out'|'7d'|'5h'|'unavailable'|null, roomAt (s|null) } } }.
// Claude accounts: has-room first (soonest weekly reset, then unknown reset,
// then manual order); no-room last (soonest time it regains room first,
// unavailable ones at the very end).
function rankRows(rows, now = Date.now()) {
  const nowS = now / 1000;
  const info = {};
  rows.forEach((r, idx) => {
    const exhausted = Boolean(r.exhaustedUntil && r.exhaustedUntil > now);
    const lim = r.limits || {};
    const w7 = r.family === 'anthropic' ? weekWindow(lim.seven_day, nowS) : null;
    const w5 = r.family === 'anthropic' ? fiveWindow(lim.five_hour, nowS) : null;
    let blockedBy = null;
    let roomAt = null;
    if (exhausted) { blockedBy = 'out'; roomAt = r.exhaustedUntil / 1000; }
    else if (!r.usable) blockedBy = 'unavailable';
    else {
      const full = [];
      if (w7 && w7.pct >= ROOM_MAX_PCT) full.push(['7d', w7.resetsAt]);
      if (w5 && w5.pct >= ROOM_MAX_PCT) full.push(['5h', w5.resetsAt]);
      if (full.length) {
        // the later reset gates it (an unknown reset = never known)
        full.sort((a, b) => (b[1] === null ? Infinity : b[1]) - (a[1] === null ? Infinity : a[1]));
        [blockedBy, roomAt] = full[0];
      }
    }
    info[r.id] = {
      idx,
      family: r.family,
      room: blockedBy === null,
      weeklyResetAt: w7 ? w7.resetsAt : null,
      weeklyPct: w7 ? w7.pct : null,
      fivePct: w5 ? w5.pct : null,
      fiveResetAt: w5 ? w5.resetsAt : null,
      blockedBy,
      roomAt,
    };
  });
  const inf = (v) => (v === null || v === undefined ? Infinity : v);
  const cmp = (a, b) => {
    const A = info[a], B = info[b];
    if (A.room !== B.room) return A.room ? -1 : 1;
    if (A.room) {
      const d = inf(A.weeklyResetAt) - inf(B.weeklyResetAt);
      if (d) return d;
    } else {
      const ua = A.blockedBy === 'unavailable', ub = B.blockedBy === 'unavailable';
      if (ua !== ub) return ua ? 1 : -1;
      const d = inf(A.roomAt) - inf(B.roomAt);
      if (d) return d;
    }
    return A.idx - B.idx;
  };
  const claude = rows.filter(r => r.family === 'anthropic').map(r => r.id).sort(cmp);
  let k = 0;
  const ranked = rows.map(r => (r.family === 'anthropic' ? claude[k++] : r.id));
  for (const v of Object.values(info)) { delete v.idx; delete v.family; }
  return { ranked, info };
}

// the store's rows for rankRows; login limits from limits.json at any age
function rankInputs(d, now) {
  return d.order.map((id) => {
    const reading = id === LOGIN ? loginLimits(now, Infinity) : (d.limits[id] || null);
    return {
      id,
      family: familyIn(d, id),
      usable: usable(d, id, now),
      exhaustedUntil: isExhausted(d, id, now) ? d.exhausted[id].until : null,
      limits: (reading && reading.limits) || null,
    };
  });
}
const rank = (now = Date.now()) => rankRows(rankInputs(read(), now), now);

// "resets Mon 15:00 · 82 % left" for the log (local time)
function rankReason(i) {
  if (!i) return '?';
  const t = (s) => new Date(s * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (i.blockedBy === 'out') return `out until ${t(i.roomAt)}`;
  if (i.blockedBy === 'unavailable') return 'unavailable';
  if (i.blockedBy) return `${i.blockedBy} full` + (i.roomAt ? ` until ${t(i.roomAt)}` : '');
  if (i.weeklyResetAt) return `resets ${t(i.weeklyResetAt)} · ${Math.round(100 - (i.weeklyPct || 0))} % left`;
  return 'no reading yet';
}

// one `account auto:` line per process when the top Claude account changes
let lastTop;
function noteTop(r, d) {
  const top = r.ranked.find(id => familyIn(d, id) === 'anthropic') || null;
  if (top === lastTop) return;
  const prev = lastTop;
  lastTop = top;
  if (top) logger.info(`account auto: top account ${prev === undefined ? 'is' : `${prev || '-'} ->`} ${top} (${rankReason(r.info[top])})`);
}

// The next moment the ranking can change without any file changing: a 5-hour
// or 7-day reset, or an exhaustion running out (epoch ms, or null).
function nextRankChange(r, now = Date.now()) {
  let next = Infinity;
  for (const i of Object.values(r.info)) {
    for (const s of [i.weeklyResetAt, i.fiveResetAt, i.roomAt]) {
      if (typeof s === 'number' && Number.isFinite(s) && s * 1000 > now) next = Math.min(next, s * 1000);
    }
  }
  return Number.isFinite(next) ? next : null;
}

// first account (in preference order) usable now, other than excludeId;
// { family } keeps it to accounts of that family (a conversation never
// crosses providers). With the automatic order on, preference = the ranking.
function pick(excludeId = null, now = Date.now(), { family = null } = {}) {
  const d = read();
  const order = readAuto() ? rankRows(rankInputs(d, now), now).ranked : d.order;
  for (const id of order) {
    if (id === excludeId || (family && familyIn(d, id) !== family)) continue;
    if (usable(d, id, now)) return id;
  }
  return null;
}

function state(now = Date.now()) {
  const d = read();
  const auto = readAuto();
  const r = rankRows(rankInputs(d, now), now);
  if (auto) noteTop(r, d);
  const accounts = d.order.map((id) => {
    const a = d.accounts[id];
    const ex = isExhausted(d, id, now) ? d.exhausted[id] : null; // expired entries drop out
    const reading = id === LOGIN ? loginLimits(now) : (d.limits[id] || null); // { limits, at }
    const row = {
      id,
      label: a.label,
      kind: a.kind,
      family: familyIn(d, id),
      available: usable(d, id, now),
      exhaustedUntil: ex ? ex.until : null,
      reason: ex ? ex.reason : null,
      limits: (reading && reading.limits) || null,
      limitsAt: (reading && reading.at) || null, // ms; the top-bar chip's "updated … ago"
      // the automatic order's view (rankRows): s, projected past resets
      room: r.info[id].room,
      weeklyResetAt: r.info[id].weeklyResetAt,
      weeklyPct: r.info[id].weeklyPct,
      fivePct: r.info[id].fivePct,
      fiveResetAt: r.info[id].fiveResetAt,
      blockedBy: r.info[id].blockedBy,
      roomAt: r.info[id].roomAt,
    };
    if (id === LOGIN && !loggedIn()) row.note = 'not logged in';
    if (a.kind === 'endpoint') {
      row.host = hostOf(a.baseUrl);
      row.baseUrl = a.baseUrl;
      row.models = { ...a.models };
      row.preset = presetOf(a.baseUrl); // 'zai' → the friendlier row hint
    }
    return row;
  });
  // auto: the automatic order is on; ranked: every id in its preference order
  // (manual order when off); nextChangeAt: ms when a reset may reorder it
  return {
    accounts,
    pick: pick(null, now),
    switchAll: auto ? null : readSwitch(now),
    auto,
    ranked: auto ? r.ranked : [...d.order],
    nextChangeAt: auto ? nextRankChange(r, now) : null,
  };
}

const has = (id) => Boolean(read().accounts[id]);
const kindOf = (id) => (read().accounts[id] || {}).kind || null;
const labelOf = (id) => (read().accounts[id] || {}).label || id;

// ---------- conversation families ----------
// Which provider each conversation belongs to: <dataRoot>/session-families.json
// { <sessionId>: family }, machine-wide. Noted when the feed shows a
// conversation running on a tab (index.cjs); the FIRST family wins, so picking
// a GLM conversation in a Claude tab's resume picker can't relabel it. Restore,
// unpark and the picker check it: a conversation never moves to another family.
// Conversations not in it (older ones) are Claude's.
const familiesFile = () => path.join(U.dataRoot(), 'session-families.json');
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
let familiesMax = 2000; // oldest entries pruned beyond this
let famCache = null; // { key, data }
function readFamilies() {
  const key = fileKey(familiesFile());
  if (famCache && famCache.key === key) return famCache.data;
  const data = Object.create(null);
  let j = null;
  if (key || fs.existsSync(familiesFile() + '.bak')) j = U.readJson(familiesFile(), null); // .bak on a damaged file
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    for (const [sid, f] of Object.entries(j)) if (SID_RE.test(sid) && typeof f === 'string' && f) data[sid] = f.slice(0, 300);
  }
  famCache = { key, data };
  return data;
}

function sessionFamily(sid) {
  const s = String(sid || '');
  if (!SID_RE.test(s)) return null;
  const d = readFamilies();
  return Object.prototype.hasOwnProperty.call(d, s) ? d[s] : null;
}

// Which provider wrote a transcript: the model of its first real assistant
// message ("claude-…" = anthropic; anything else = an endpoint). null when it
// has no assistant message yet (a brand-new conversation). Reads at most the
// first 1 MB; API error lines carry model "<synthetic>" and are skipped.
function transcriptProvider(jsonlPath) {
  const m = transcriptModel(jsonlPath);
  return m === null ? null : (/^claude/i.test(m) ? 'anthropic' : 'endpoint');
}

// the model of a transcript's first real assistant message, or null
function transcriptModel(jsonlPath) {
  let fd = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const len = Math.min(fs.fstatSync(fd).size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"type":"assistant"')) continue;
      const m = /"model":"([^"]+)"/.exec(line);
      if (!m || m[1] === '<synthetic>') continue;
      return m[1];
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

// The family to record for a conversation seen running for the first time.
// Its transcript decides when it has replies: an older Claude conversation
// picked in a tab that runs on an endpoint stays Claude's (and the renderer
// moves it). Only a conversation with no reply yet takes the tab's family.
// A GLM conversation picked in a Claude tab (the tab's family says nothing):
// the endpoint account whose models include the transcript's model (live
// z.ai test 2026-10-07: "glm-5.3[1m]"), else the only endpoint family there
// is, else 'endpoint:unknown' (the renderer then refuses to continue it).
function familyForNewSession(transcriptPath, tabFamily) {
  const model = transcriptPath ? transcriptModel(transcriptPath) : null;
  if (model === null) return tabFamily || 'anthropic';
  if (/^claude/i.test(model)) return 'anthropic';
  if (tabFamily && tabFamily.startsWith('endpoint:')) return tabFamily;
  const d = read();
  const eps = Object.keys(d.accounts).filter(id => d.accounts[id].kind === 'endpoint');
  const strip = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]$/, '');
  const byModel = eps.filter(id => Object.values(d.accounts[id].models || {}).some(x => x && strip(x) === strip(model)));
  const fams = [...new Set((byModel.length ? byModel : eps).map(id => familyIn(d, id)))];
  return fams.length === 1 ? fams[0] : 'endpoint:unknown';
}

// sets it only if the conversation has no family yet; returns the family it has
function noteSessionFamily(sid, family) {
  const s = String(sid || '');
  if (!SID_RE.test(s) || typeof family !== 'string' || !family) return null;
  const cur = readFamilies();
  if (Object.prototype.hasOwnProperty.call(cur, s)) return cur[s];
  const next = Object.assign(Object.create(null), cur);
  next[s] = family.slice(0, 300);
  const keys = Object.keys(next); // insertion order = oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - familiesMax))) delete next[k];
  writeFile(familiesFile(), next);
  famCache = null;
  return next[s];
}

// ---------- DPAPI ----------
// .NET DPAPI directly, no ConvertTo-SecureString: that cmdlet's module fails to
// load in Windows PowerShell 5.1 when PSModulePath came from a PowerShell 7 parent.
// Blob = hex of ProtectedData.Protect(UTF-8 secret, CurrentUser); the secret is
// the token, or an endpoint's KEY=VALUE lines.
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
    fs.writeFileSync(tokenBlobPath(id), blob);
  } catch (e) {
    return { ok: false, error: 'Could not save the token: ' + e.message };
  }
  update((d) => { d.accounts[id] = { label: name, kind: 'token' }; d.order.push(id); });
  logger.info(`accounts: added ${id} ("${name}")`);
  return { ok: true, state: state() };
}

// ---------- endpoint accounts ----------
// The env block a user pastes (the `env` of a Claude settings file, or KEY=VALUE
// lines). Only claude's own knobs may be injected: never PATH and the like.
const ENDPOINT_KEY_RE = /^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|API_TIMEOUT_MS|DISABLE_[A-Z0-9_]+|MAX_THINKING_TOKENS|MAX_MCP_OUTPUT_TOKENS|BASH_[A-Z0-9_]+)$/;
const ENDPOINT_KEYS_TEXT = 'ANTHROPIC_*, CLAUDE_CODE_*, API_TIMEOUT_MS, DISABLE_*, MAX_THINKING_TOKENS, MAX_MCP_OUTPUT_TOKENS, BASH_*';
const ENDPOINT_FORBIDDEN = {
  CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN is not allowed here: an endpoint account brings its own ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.',
  CLAUDE_CONFIG_DIR: 'CLAUDE_CONFIG_DIR is not allowed here: every account shares one ~/.claude.',
};

// JSON with // line comments and trailing commas: both removed outside strings
function looseJson(text) {
  const pass = (src, onChar) => {
    let out = '';
    let inStr = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        out += c;
        if (c === '\\' && i + 1 < src.length) out += src[++i];
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      const skip = onChar(src, i);
      if (skip === null) out += c; else i = skip;
    }
    return out;
  };
  // comments: jump to the end of the line (the newline itself is kept)
  const noComments = pass(text, (s, i) => {
    if (s[i] !== '/' || s[i + 1] !== '/') return null;
    let j = i;
    while (j + 1 < s.length && s[j + 1] !== '\n') j++;
    return j;
  });
  // a comma followed only by whitespace and a closing bracket (or the end)
  return pass(noComments, (s, i) => {
    if (s[i] !== ',') return null;
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    return j >= s.length || s[j] === '}' || s[j] === ']' ? i : null;
  });
}

// → { ok: true, env: { KEY: 'value' }, notes: [] } | { ok: false, error }.
// Error texts name keys, never values (a value may be the secret).
function parseEndpointEnv(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return { ok: false, error: 'Paste the env block (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, …).' };
  if (src.length > 20000) return { ok: false, error: 'That block is too long.' };
  const pairs = []; // [key, raw value]
  if (/^\s*\{/.test(src) || /"[^"\n]*"\s*:/.test(src)) {
    let s = looseJson(src).trim();
    if (!s.startsWith('{')) s = `{${s}}`;
    let obj;
    try { obj = JSON.parse(s); } catch {
      return { ok: false, error: 'Could not read the block: paste JSON ("KEY": "value" lines) or KEY=VALUE lines.' };
    }
    // a whole `"env": { … }` pasted from a settings file
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 1
      && obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) obj = obj.env;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'Could not read the block: expected "KEY": "value" pairs.' };
    for (const [k, v] of Object.entries(obj)) pairs.push([k, v]);
  } else {
    const lines = src.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) return { ok: false, error: `Line ${n + 1} is not KEY=VALUE.` };
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
      pairs.push([m[1], v]);
    }
  }
  const env = {};
  const notes = [];
  const literal = new Set(pairs.map(([k]) => String(k).trim()));
  for (const [rawKey, rawVal] of pairs) {
    let key = String(rawKey).trim();
    if (/^ANCHROPIC_/.test(key)) { // a typo seen in a real config
      const good = 'ANTHROPIC_' + key.slice('ANCHROPIC_'.length);
      if (literal.has(good)) { notes.push(`${key} ignored: ${good} is set too`); continue; }
      notes.push(`${key} → ${good}`);
      key = good;
    }
    if (ENDPOINT_FORBIDDEN[key]) return { ok: false, error: ENDPOINT_FORBIDDEN[key] };
    if (!ENDPOINT_KEY_RE.test(key)) return { ok: false, error: `${key || '(empty name)'} is not allowed here. Allowed: ${ENDPOINT_KEYS_TEXT}.` };
    let val;
    if (typeof rawVal === 'string') val = rawVal.trim();
    else if (typeof rawVal === 'number' && Number.isFinite(rawVal)) val = String(rawVal);
    else return { ok: false, error: `${key}: the value must be text or a number.` };
    if (/[\r\n\0]/.test(val)) return { ok: false, error: `${key}: the value must be on one line.` };
    env[key] = val;
  }
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return { ok: false, error: 'ANTHROPIC_BASE_URL is missing (the endpoint, e.g. https://api.z.ai/api/anthropic).' };
  let u = null;
  try { u = new URL(base); } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || !u.host) return { ok: false, error: 'ANTHROPIC_BASE_URL must be an http(s) URL.' };
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) is missing: the key for that endpoint.' };
  return { ok: true, env, notes };
}

// the blob's plaintext: KEY=VALUE lines (the wrapper splits on the first '=')
const envText = (env) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');

// base URL without credentials or query (only display/family info is stored)
function displayUrl(u) {
  const p = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
  return `${u.protocol}//${u.host}${p}`;
}

// An endpoint account's env, decrypted in MAIN (one PowerShell spawn, the token
// never on a command line), cached per account until it is removed. The pty
// wrapper never decrypts endpoint settings: Defender flagged a wrapper that did
// (Exploit:Win32/Tikupom on the -EncodedCommand, 2026-10-07) and blocked every
// terminal. Main writes them into a per-tab claude settings file instead
// (ptyhost.writeEndpointSettings).
const envCache = new Map(); // id -> { KEY: value }
const envInflight = new Map(); // id -> Promise of the one decrypt running for it
let decryptSpawns = 0; // smoke: concurrent callers must share one spawn
function endpointEnv(id) {
  if (envCache.has(id)) return Promise.resolve({ ...envCache.get(id) });
  let p = envInflight.get(id);
  if (!p) {
    // a failed decrypt is not cached: the next call tries again
    p = decryptEnv(id).finally(() => { if (envInflight.get(id) === p) envInflight.delete(id); });
    envInflight.set(id, p);
  }
  return p.then((env) => ({ ...env }));
}

function decryptEnv(id) {
  const blob = endpointBlobPath(id);
  if (!fs.existsSync(blob)) return Promise.reject(new Error('its settings file is missing: remove the account and add it again'));
  decryptSpawns++;
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(psExe(), ['-NoProfile', '-NonInteractive', '-Command', `$blob = $env:VS_BLOB; ${DECRYPT_PS}; [Console]::Out.Write($tok)`],
      { windowsHide: true, env: psEnv({ VS_BLOB: blob }) });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('decrypting its settings timed out')); }, 20000);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const env = {};
      for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0 && ENDPOINT_KEY_RE.test(line.slice(0, i))) env[line.slice(0, i)] = line.slice(i + 1);
      }
      if (code !== 0 || !env.ANTHROPIC_BASE_URL) { reject(new Error(`its settings could not be decrypted (exit ${code})`)); return; }
      if (has(id)) envCache.set(id, env); // removed meanwhile: nothing to keep
      resolve(env);
    });
  });
}

// What a tab's claude starts on: { id, env } (env = an endpoint's vars, which
// main writes into the tab's own settings file, else null). Never a silent
// fallback: an unknown id, or an endpoint whose settings can't be decrypted,
// THROWS, so no claude is typed at all. Falling back to the /login would run a
// GLM conversation on Claude (or the friend with only z.ai on nothing).
async function forTerm(accountId) {
  const id = accountId == null || accountId === '' ? LOGIN : String(accountId);
  const a = read().accounts[id];
  if (!a) throw new Error('that account no longer exists');
  if (a.kind !== 'endpoint') return { id, env: null };
  try {
    return { id, env: await endpointEnv(id) };
  } catch (e) {
    throw new Error(`${a.label}: ${e.message}`);
  }
}

async function addEndpoint(label, text) {
  const name = String(label || '').trim().slice(0, 60);
  if (!name) return { ok: false, error: 'Give the account a name.' };
  const p = parseEndpointEnv(text);
  if (!p.ok) return { ok: false, error: p.error };
  const r = await storeEndpoint(name, p.env);
  return r.ok ? { ok: true, state: r.state, notes: p.notes } : r;
}

// A validated endpoint env (ANTHROPIC_BASE_URL is an http(s) URL, a key is in
// it) → DPAPI blob + entry. The one store path for pasted blocks and presets.
async function storeEndpoint(name, env) {
  const u = new URL(env.ANTHROPIC_BASE_URL);
  const baseUrl = displayUrl(u);
  const models = {
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || null,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null,
  };
  let id;
  do { id = `${U.slugify(name).slice(0, 24)}-${U.randId(4)}`; } while (id === LOGIN || has(id));
  let blob;
  try {
    blob = await encrypt(envText(env));
  } catch (e) {
    logger.warn(`accounts: add endpoint failed (${e.message})`); // never a value
    return { ok: false, error: 'Could not encrypt the settings: ' + e.message };
  }
  try {
    U.ensureDir(blobDir());
    fs.writeFileSync(endpointBlobPath(id), blob);
  } catch (e) {
    return { ok: false, error: 'Could not save the settings: ' + e.message };
  }
  update((d) => { d.accounts[id] = { label: name, kind: 'endpoint', baseUrl, models }; d.order.push(id); });
  logger.info(`accounts: added endpoint ${id} ("${name}", ${u.host}, vars: ${Object.keys(env).join(',')})`);
  return { ok: true, state: state(), id, label: name };
}

// ---------- presets ----------
// "Add account → pick a provider → paste the key": the env a provider needs,
// minus the key. zai = the values from Valentin's own working z.ai config
// (2026-10-07).
const PRESETS = {
  zai: {
    name: 'z.ai (GLM)',
    label: 'z.ai GLM',
    keyHint: 'API key from z.ai → API Keys',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000',
    },
  },
};
const PRESET_MODEL_KEYS = { opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' };

// for the UI: no secrets in a preset, but only the display fields go out
function presets() {
  return Object.entries(PRESETS).map(([id, p]) => ({
    id,
    name: p.name,
    label: p.label,
    keyHint: p.keyHint,
    models: Object.fromEntries(Object.entries(PRESET_MODEL_KEYS).map(([m, k]) => [m, p.env[k] || null])),
  }));
}

// the preset an endpoint account was made from (same base URL), or null
function presetOf(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  for (const [id, p] of Object.entries(PRESETS)) if (p.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') === b) return id;
  return null;
}

// "z.ai GLM", "z.ai GLM 2", … — never two accounts with the same label
function uniqueLabel(d, base) {
  const taken = new Set(Object.values(d.accounts).map(a => a.label));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const l = `${base.slice(0, 60 - String(n).length - 1)} ${n}`;
    if (!taken.has(l)) return l;
  }
}

// Error texts never contain the key.
async function addPreset(presetId, label, apiKey, { models } = {}) {
  const p = Object.prototype.hasOwnProperty.call(PRESETS, presetId) ? PRESETS[presetId] : null;
  if (!p) return { ok: false, error: 'Unknown provider.' };
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'Paste the API key.' };
  if (/^sk-ant-/i.test(key)) return { ok: false, error: "That's a Claude token: add it under Claude subscription" };
  if (/\s/.test(key)) return { ok: false, error: 'The key must not contain spaces or line breaks.' };
  if (key.length < 16) return { ok: false, error: 'That key is too short.' };
  if (key.length > 400) return { ok: false, error: 'That key is too long.' };
  const env = { ...p.env };
  const m = models && typeof models === 'object' ? models : {};
  for (const [which, envKey] of Object.entries(PRESET_MODEL_KEYS)) {
    const v = typeof m[which] === 'string' ? m[which].trim() : '';
    if (!v) continue;
    if (/\s/.test(v) || v.length > 100) return { ok: false, error: `The ${which} model name must be one word of at most 100 characters.` };
    env[envKey] = v;
  }
  env.ANTHROPIC_AUTH_TOKEN = key;
  const name = uniqueLabel(read(), String(label || '').trim().slice(0, 60) || p.label);
  return storeEndpoint(name, env);
}

// An endpoint's blob and its entry go; tabs running on it keep going (their
// settings file is deleted when their pty exits) and its conversations keep
// their family, so they are never resumed on another provider.
function remove(id) {
  envCache.delete(id);
  if (id === LOGIN || !has(id)) return state();
  const blob = blobPath(id);
  update((d) => {
    delete d.accounts[id];
    delete d.exhausted[id];
    delete d.limits[id];
    d.order = d.order.filter(x => x !== id);
  });
  try { fs.rmSync(blob, { force: true }); } catch {}
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
  if (readSwitch()) writeSwitch(null); // a new preference by hand ends a standing "move all"
  return state();
}

// "Move all agents here": the account becomes the first choice (new agents) and
// every window moves its open agents to it — idle ones at once, busy ones when
// their turn ends (renderer terms.js drainMoves). Throws for an account that is
// out of usage: moving agents onto it would stop them all.
function switchAll(id) {
  const d0 = read();
  if (!d0.accounts[id]) throw new Error('Unknown account');
  if (readAuto()) throw new Error('Automatic order is on: turn it off to move agents by hand');
  if (isExhausted(d0, id, Date.now())) throw new Error(`${d0.accounts[id].label} is out of usage right now`);
  // a token account whose token file is gone would stop every agent at a shell
  if (!usable(d0, id, Date.now())) {
    throw new Error(id === LOGIN ? `${d0.accounts[id].label}: not logged in on this PC` : `${d0.accounts[id].label} has no stored token: remove it and add it again`);
  }
  update((d) => {
    if (d.order[0] === id) return false;
    d.order = [id, ...d.order.filter(x => x !== id)];
    return true;
  });
  writeSwitch({ to: id, at: Date.now() });
  logger.info(`accounts: move all agents to ${id}`);
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

// only ever EXTENDS an exhaustion window — a later, shorter guess never shortens it.
// `at` is when the evidence was seen: fresh evidence refreshes it (at most one
// write per 10 s), so clearIfProven only trusts turns started after it.
function markExhausted(id, untilMs, reason) {
  const until = Number(untilMs);
  const now = Date.now();
  if (!Number.isFinite(until) || until <= now) return false;
  let extended = false;
  update((d) => {
    if (!d.accounts[id]) return false;
    const prev = d.exhausted[id];
    if (prev && prev.until >= until) {
      if (now - (prev.at || 0) < 10000) return false;
      d.exhausted[id] = { ...prev, at: now };
      return true;
    }
    d.exhausted[id] = { until, reason: reason ? String(reason).slice(0, 200) : null, at: now };
    extended = true;
    return true;
  });
  if (extended) {
    logger.info(`accounts: ${id} exhausted until ${new Date(until).toISOString()} (${reason || '?'})`);
    const sw = readSwitch();
    if (sw && sw.to === id) writeSwitch(null); // never pull agents onto it when it comes back
  }
  return extended;
}

// when the exhaustion evidence was seen (ms), or null when the account isn't out
function exhaustedAt(id, now = Date.now()) {
  const d = read();
  return isExhausted(d, id, now) ? (d.exhausted[id].at || 0) : null;
}

// The account works again before its recorded reset (a plan change, or the
// "reset limits" offer on claude.ai, 2026-10-06): a turn that STARTED after the
// evidence and finished fine proves it. Older turns prove nothing — a response
// already streaming can finish after another tab hit the limit.
function clearIfProven(id, turnStartedMs) {
  let cleared = false;
  update((d) => {
    const e = d.exhausted[id];
    if (!e || !(Number(turnStartedMs) > (e.at || 0))) return false;
    delete d.exhausted[id];
    cleared = true;
    return true;
  });
  if (cleared) logger.info(`accounts: ${id} works again (a turn started after the limit finished), exhaustion cleared`);
  return cleared;
}

const hasFullWindow = (rl, now = Date.now()) => fullWindows(rl, now).length > 0;

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
let rankTimer = null;
const watchKey = () => `${statKey()}|${fileKey(switchFile())}|${fileKey(autoFile())}`;
function emit() {
  const s = state();
  for (const fn of listeners) { try { fn(s); } catch (e) { logger.warn('accounts listener: ' + e.message); } }
  armRankTimer(s);
}
function onFileChange() {
  const key = watchKey();
  if (key === lastKey) return;
  lastKey = key;
  emit();
}
// A reset passing reorders the automatic ranking although no file changes:
// push the new state at that moment (one timer, at least 60 s apart).
function armRankTimer(s) {
  clearTimeout(rankTimer);
  rankTimer = null;
  if (!watching || !s || !s.nextChangeAt) return;
  const ms = Math.min(Math.max(s.nextChangeAt - Date.now() + 2000, 60000), 6 * 3600 * 1000);
  rankTimer = setTimeout(() => { rankTimer = null; emit(); }, ms);
  if (rankTimer.unref) rankTimer.unref();
}

function onChange(fn) {
  listeners.push(fn);
  if (watching) return;
  watching = true;
  lastKey = watchKey();
  fs.watchFile(file(), { interval: 1000 }, onFileChange);
  fs.watchFile(endpointsFile(), { interval: 1000 }, onFileChange); // an endpoint rename touches only this one
  fs.watchFile(switchFile(), { interval: 1000 }, onFileChange);
  fs.watchFile(autoFile(), { interval: 1000 }, onFileChange);
  try { armRankTimer(state()); } catch (e) { logger.warn('accounts rank timer: ' + e.message); }
}

function unwatch() {
  if (!watching) return;
  watching = false;
  clearTimeout(rankTimer);
  rankTimer = null;
  try { fs.unwatchFile(file(), onFileChange); } catch {}
  try { fs.unwatchFile(endpointsFile(), onFileChange); } catch {}
  try { fs.unwatchFile(switchFile(), onFileChange); } catch {}
  try { fs.unwatchFile(autoFile(), onFileChange); } catch {}
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
  ROOM_MAX_PCT,
  state,
  pick,
  rank,
  rankRows,
  readAuto,
  setAuto,
  familyOf,
  has,
  labelOf,
  add,
  addEndpoint,
  presets,
  addPreset,
  kindOf,
  endpointEnv,
  forTerm,
  sessionFamily,
  familyForNewSession,
  transcriptProvider,
  transcriptModel,
  noteSessionFamily,
  remove,
  rename,
  move,
  switchAll,
  clear,
  markExhausted,
  exhaustedAt,
  clearIfProven,
  hasFullWindow,
  setLimits,
  onChange,
  unwatch,
  blobPath,
  blobDir,
  parseReset,
  classifyFailure,
  lastApiErrorText,
  _normalize: normalize,
  _parseEndpointEnv: parseEndpointEnv,
  _envText: envText,
  _setCredentialsPath: (p) => { credentialsOverride = p || null; },
  _setFamiliesMax: (n) => { familiesMax = Number(n) > 0 ? Number(n) : 2000; },
  _forgetEnv: (id) => { envCache.delete(id); },
  _decryptSpawns: () => decryptSpawns,
  _files: () => ({ accounts: file(), endpoints: endpointsFile(), families: familiesFile(), auto: autoFile(), tokenBlob: tokenBlobPath, endpointBlob: endpointBlobPath }),
  _rankReason: rankReason,
  _nextRankChange: nextRankChange,
  _psExe: psExe,
  _psEnv: psEnv,
};
