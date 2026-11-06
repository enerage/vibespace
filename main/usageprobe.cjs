'use strict';
// Usage probe (2026-10-22): an account with no agent running has no limits
// reading (claude reports usage only in ITS OWN agents' status line), so the
// top-bar chip shows "—" for it. Valentin asked for one request instead.
//
// VibeSpace never touches the login's token (2026-11-06): Anthropic's terms
// let a subscription's OAuth token be used by Claude Code only, so the probe
// runs the REAL claude's own `/usage` command and reads what it prints:
//   `claude -p /usage --no-session-persistence`
// It is a local command (no model request, nothing billed), and claude renews
// its own sign-in as a side effect. Output seen on 2.1.31x:
//   Current session: 29% used · resets Oct 22, 4pm (Europe/Berlin)
//   Current week (all models): 49% used · resets Oct 26, 2pm (Europe/Berlin)
// A token account needs its cloud sign-in (cloud.configOf): a setup-token
// can't read usage. The tab variables are cleared like a cloud call's.
//
// Windows only for now (macOS untested). At most one try per account per
// 30 min, machine-wide (<dataRoot>/usage-probe.json). Results go where the
// status line puts them: limits.json for the /login, accounts.json for token
// accounts.
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
const probeFile = () => path.join(U.dataRoot(), 'usage-probe.json');
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// ---------- pure ----------
// claude's /usage text → the status line's raw shape, or null
function fromUsageText(text, now = Date.now()) {
  const t = String(text || '').replace(ANSI, '');
  const win = (re) => {
    const m = re.exec(t);
    if (!m) return undefined;
    const at = m[2] ? accounts.parseReset(m[2], now) : null;
    return { used_percentage: Number(m[1]), resets_at: at ? Math.round(at / 1000) : null };
  };
  const out = {};
  const five = win(/Current session:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:[^\n]*?(resets[^\n]*))?/i);
  const seven = win(/Current week \(all models\):\s*(\d+(?:\.\d+)?)\s*%\s*used(?:[^\n]*?(resets[^\n]*))?/i);
  if (five) out.five_hour = five;
  // no 5-hour session started yet: claude prints no "Current session" line
  else if (seven && !/Current session/i.test(t)) out.five_hour = { used_percentage: 0, resets_at: null };
  if (seven) out.seven_day = seven;
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

// ---------- the real claude's /usage ----------
function runUsage(id) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_CHILD_SESSION']) delete env[k];
    const dir = cloud.dirFor(id);
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    let child;
    let out = '';
    try {
      child = spawn(updater.claudeCommand().cmd, ['-p', '/usage', '--no-session-persistence'],
        { cwd: U.dataRoot(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { resolve(null); return; }
    child.stdout.on('data', (c) => { if (out.length < 64 * 1024) out += c; });
    const timer = setTimeout(() => {
      try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      resolve(null);
    }, CLAUDE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// one account → { ok, raw } | { ok: false, why }
async function probe(id) {
  // only whether a claude.ai login exists for it; the file is never read
  if (!fs.existsSync(cloud.configOf(id).credentials)) {
    return { ok: false, why: id === accounts.LOGIN ? 'no claude.ai login file' : 'no cloud sign-in for this account' };
  }
  const out = await runUsage(id);
  if (out === null) return { ok: false, why: 'claude /usage did not finish' };
  const raw = fromUsageText(out);
  return raw ? { ok: true, raw } : { ok: false, why: 'no numbers in claude /usage output' };
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

module.exports = { start, maybe, probe, fromUsageText, isBlank, RETRY_MS };
