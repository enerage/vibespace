'use strict';
// Usage probe (2026-10-22): an account with no agent running has no limits
// reading (claude reports usage only in ITS OWN agents' status line), so the
// top-bar chip shows "—" for it. Valentin asked for one request instead.
//
// The request is claude's own `/usage` source: GET /api/oauth/usage with a
// claude.ai login's access token (needs the user:profile scope; a setup-token
// gets 403, so a token account needs its cloud sign-in, cloud.configOf).
// No model request, nothing billed. Verified live 2026-10-22: utilization is
// a percent (29.0), resets_at an ISO time.
//
// The access token expires within hours when no claude on that login runs.
// We never refresh it ourselves: refresh tokens rotate, and a race with VS
// Code / claude windows on the same login could sign it out. Instead the
// REAL claude refreshes it: `claude -p /usage --no-session-persistence` is a
// local command (no model call) that renews the token as a side effect.
//
// Windows only for now: on macOS the login is a Keychain item (reading it
// could prompt). At most one try per account per 30 min, machine-wide
// (<dataRoot>/usage-probe.json). Results go where the status line puts them:
// limits.json for the /login, accounts.json for token accounts.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const U = require('./util.cjs');
const logger = require('./logger.cjs');
const accounts = require('./accounts.cjs');
const cloud = require('./cloud.cjs');
const updater = require('./updater.cjs');

const RETRY_MS = 30 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 15 * 1000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const probeFile = () => path.join(U.dataRoot(), 'usage-probe.json');

// ---------- pure ----------
// /api/oauth/usage JSON → the status line's raw shape, or null
function fromUsageJson(j) {
  if (!j || typeof j !== 'object') return null;
  const w = (x) => {
    if (!x || typeof x !== 'object' || typeof x.utilization !== 'number') return undefined;
    const t = Date.parse(x.resets_at);
    return { used_percentage: x.utilization, resets_at: Number.isFinite(t) ? Math.round(t / 1000) : null };
  };
  const out = {};
  if (w(j.five_hour)) out.five_hour = w(j.five_hour);
  if (w(j.seven_day)) out.seven_day = w(j.seven_day);
  return Object.keys(out).length ? out : null;
}

// the chip shows "—" for this accounts.state() row: no reading, or every
// window's reset has passed (limits.js `fresh`)
function isBlank(row, now = Date.now()) {
  const lim = row && row.limits;
  if (!lim) return true;
  const fresh = (w) => Boolean(w && typeof w.used_percentage === 'number' && !(w.resets_at && w.resets_at * 1000 < now));
  return !fresh(lim.five_hour) && !fresh(lim.seven_day);
}

// ---------- helpers ----------
function readCreds(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string') return null;
    return { token: o.accessToken, expiresAt: Number(o.expiresAt) || 0, scopes: Array.isArray(o.scopes) ? o.scopes : [] };
  } catch { return null; }
}

// the real claude, on that login only, renews the token (and prints /usage,
// which we ignore). The tab variables are cleared like a cloud call's.
function refreshViaClaude(id) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_CHILD_SESSION']) delete env[k];
    const dir = cloud.dirFor(id);
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    let child;
    try {
      child = spawn(updater.claudeCommand().cmd, ['-p', '/usage', '--no-session-persistence'],
        { cwd: U.dataRoot(), env, windowsHide: true, stdio: 'ignore' });
    } catch (e) { resolve(false); return; }
    const timer = setTimeout(() => {
      try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      resolve(false);
    }, CLAUDE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function fetchUsage(token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(USAGE_URL, { headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }, signal: ctl.signal });
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
    const raw = fromUsageJson(await r.json());
    return raw ? { ok: true, raw } : { ok: false, why: 'no windows in the answer' };
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

// one account → { ok, raw } | { ok: false, why }
async function probe(id) {
  const file = cloud.configOf(id).credentials;
  let c = readCreds(file);
  if (!c) return { ok: false, why: id === accounts.LOGIN ? 'no claude.ai login file' : 'no cloud sign-in for this account' };
  if (!c.scopes.includes('user:profile')) return { ok: false, why: 'login lacks the user:profile scope' };
  if (c.expiresAt < Date.now() + 2 * 60 * 1000) {
    await refreshViaClaude(id);
    c = readCreds(file);
    if (!c || c.expiresAt < Date.now() + 60 * 1000) return { ok: false, why: 'claude did not renew the sign-in' };
  }
  return fetchUsage(c.token);
}

function store(id, raw) {
  if (id === accounts.LOGIN) {
    // the status line's own file; never over a newer live reading
    const f = path.join(U.dataRoot(), 'limits.json');
    const j = U.readJson(f, null);
    if (j && typeof j.at === 'number' && j.at > Date.now() - 60 * 1000) return;
    const w = (x) => (x ? { pct: x.used_percentage, resetsAt: x.resets_at } : undefined);
    U.writeJsonAtomic(f, { at: Date.now(), limits: { fiveHour: w(raw.five_hour), sevenDay: w(raw.seven_day) }, source: 'probe' });
  } else accounts.setLimits(id, raw);
}

// ---------- the loop ----------
let running = false;
async function maybe(st = accounts.state()) {
  if (process.platform !== 'win32' || running || !st || !Array.isArray(st.accounts)) return;
  const now = Date.now();
  const due = st.accounts.filter(a => (a.kind === 'login' || a.kind === 'token') && a.note !== 'not logged in' && isBlank(a, now));
  if (!due.length) return;
  running = true;
  try {
    for (const a of due) {
      // machine-wide: every workspace process runs this loop
      const tries = U.readJson(probeFile(), {}) || {};
      if (tries[a.id] && now - tries[a.id].at < RETRY_MS) continue;
      tries[a.id] = { at: now };
      try { U.writeJsonAtomic(probeFile(), tries); } catch {}
      const r = await probe(a.id);
      if (r.ok) {
        store(a.id, r.raw);
        const p = (w) => (w ? Math.round(w.used_percentage) + '%' : '-');
        logger.info(`usage probe: ${a.id} 5h ${p(r.raw.five_hour)} 7d ${p(r.raw.seven_day)}`);
      } else logger.info(`usage probe: ${a.id} skipped (${r.why})`);
    }
  } catch (e) {
    logger.warn('usage probe: ' + e.message);
  } finally { running = false; }
}

let timer = null;
function start() {
  if (timer || process.platform !== 'win32') return;
  setTimeout(() => maybe(), 20 * 1000).unref?.();
  timer = setInterval(() => maybe(), 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { start, maybe, probe, fromUsageJson, isBlank, RETRY_MS };
