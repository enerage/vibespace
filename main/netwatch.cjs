'use strict';
// Internet outage handling (DECISIONS.md 2026-10-09). When the internet drops,
// every agent's turn fails the same way: claude retries, gives up and fires
// StopFailure with `error: "server_error"`, and the transcript's API error line
// says "Can't reach the API server … (ENOTFOUND)". That is ONE quiet state, not
// N failure toasts: index.cjs marks such a tab `net` (feed state), this module
// probes the API host until it answers again, and the renderer then types
// `continue` into each waiting agent (terms.js netResume).
//
// Two parts:
//   isNetworkFailure / unambiguous — PURE text classifiers (smoke tests them)
//   a per-target watcher            — offline → probe every 15 s; online again
//                                     only after 2 successes in a row. Stops
//                                     (and forgets the target) when nothing waits.
// A probe is a DNS lookup + a TCP connect to <host>:443 (3 s cap): no HTTP
// request, no tokens. Each workspace process probes on its own; there is no
// machine-wide state.
const dns = require('node:dns');
const net = require('node:net');

// ---------- pure classifiers ----------
// error kinds a network failure can arrive as. claude reports a lost
// connection as `server_error` (StopFailure, seen 2026-10-09); the transcript
// line may say `unknown`. Everything else (rate_limit, overloaded, auth,
// billing, invalid_request…) is never a network failure, whatever the text.
const NET_TYPES = new Set(['', 'server_error', 'unknown', 'unknown_error', 'api_error', 'connection_error', 'api_connection_error', 'network_error', 'timeout', 'timeout_error']);
// text that says the API could not be reached
const NET_TEXT_RE = /can'?t reach|cannot reach|could not reach|unable to (?:reach|connect)|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|fetch failed|connection error|connection refused|timed out|network/i;
// text that is about something else even if it also mentions the network
const NOT_NET_RE = /rate[ _-]?limit|usage limit|hit your .*limit|overloaded|\b529\b|\b401\b|\b403\b|authenticat|unauthori[sz]ed|invalid api key|billing|credit balance|quota/i;
// text that can only mean "no internet / DNS": no probe needed to believe it
const SURE_RE = /can'?t reach the api|cannot reach the api|could not reach the api|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|check your internet/i;

function isNetworkFailure({ error, transcriptText } = {}) {
  const type = typeof error === 'string' ? error.trim().toLowerCase() : '';
  if (!NET_TYPES.has(type)) return false;
  const text = typeof transcriptText === 'string' ? transcriptText : '';
  if (!text || NOT_NET_RE.test(text)) return false;
  return NET_TEXT_RE.test(text);
}

// the text alone proves the outage (DNS failed, "can't reach the API server");
// anything else (ECONNRESET, "Connection error", "fetch failed") is confirmed
// by a probe first
const unambiguous = (text) => typeof text === 'string' && SURE_RE.test(text) && !NOT_NET_RE.test(text);

// ---------- targets ----------
const DEFAULT_HOST = 'api.anthropic.com';
// "host:port" | "host" → { host, port, key }; VIBESPACE_NET_PROBE overrides every
// target (tests point it at a local relay)
function parseTarget(s, defPort = 443) {
  const str = String(s || '').trim();
  if (!str) return null;
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(str) || /^([^:]+)(?::(\d+))?$/.exec(str);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defPort;
  if (!(port > 0 && port < 65536)) return null;
  const host = m[1].toLowerCase();
  return { host, port, key: `${host}:${port}` };
}

// the host to probe for a tab: its account's API (an endpoint account's base
// URL, else Anthropic's)
function targetFor(baseUrl = null) {
  const o = parseTarget(process.env.VIBESPACE_NET_PROBE || '');
  if (o) return o;
  if (baseUrl) {
    try {
      const u = new URL(String(baseUrl));
      const t = parseTarget(u.host, u.protocol === 'http:' ? 80 : 443);
      if (t) return t;
    } catch {}
  }
  return parseTarget(DEFAULT_HOST);
}

// ---------- probe ----------
// { ok, why, ms }: DNS lookup + TCP connect, closed at once; never rejects
function probeOnce(target, timeoutMs = 3000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (ok, why = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sock) { try { sock.destroy(); } catch {} }
      resolve({ ok, why, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    dns.lookup(target.host, (err, address) => {
      if (done) return;
      if (err) { finish(false, err.code || 'dns'); return; }
      try {
        sock = net.connect({ host: address, port: target.port });
        sock.once('connect', () => finish(true));
        sock.once('error', (e) => finish(false, e.code || 'connect'));
      } catch (e) {
        finish(false, e.code || 'connect');
      }
    });
  });
}

// ---------- watcher ----------
const timing = { offlineMs: 15000, confirmMs: 3000, timeoutMs: 3000, needOk: 2 };
let probe = probeOnce;
const targets = new Map(); // key -> { host, port, key, since, oks, timer, waiters: Set<termId>, probing }
let listener = () => {};

// a term waits on this target: the target is offline from now (if it wasn't
// already) and probing starts
function wait(termId, target) {
  if (!target) return;
  for (const [k, t] of targets) if (k !== target.key) dropWaiter(t, termId);
  let t = targets.get(target.key);
  if (!t) {
    t = { host: target.host, port: target.port, key: target.key, since: Date.now(), oks: 0, timer: null, waiters: new Set(), probing: false };
    targets.set(target.key, t);
    t.waiters.add(termId);
    schedule(t, timing.offlineMs);
    emit({ kind: 'offline', target: t.key, since: t.since });
    return;
  }
  t.waiters.add(termId);
  t.oks = 0; // a fresh failure: the next success starts the count again
}

function dropWaiter(t, termId) {
  if (!t.waiters.delete(termId) || t.waiters.size) return;
  clearTimeout(t.timer);
  targets.delete(t.key);
  emit({ kind: 'idle', target: t.key, since: t.since }); // nothing waits: no more probing
}

// the term no longer waits (its turn restarted, it exited, it was continued)
function release(termId) {
  for (const t of [...targets.values()]) dropWaiter(t, termId);
}

function schedule(t, ms) {
  clearTimeout(t.timer);
  t.timer = setTimeout(() => tick(t), ms);
  if (t.timer.unref) t.timer.unref();
}

async function tick(t) {
  if (targets.get(t.key) !== t || t.probing) return;
  t.probing = true;
  let r;
  try { r = await probe(t, timing.timeoutMs); } catch (e) { r = { ok: false, why: e.message }; }
  t.probing = false;
  if (targets.get(t.key) !== t) return; // released meanwhile
  if (!r || !r.ok) {
    t.oks = 0;
    schedule(t, timing.offlineMs);
    return;
  }
  t.oks++;
  if (t.oks < timing.needOk) { schedule(t, timing.confirmMs); return; }
  // back: hand the waiting terms over and forget the target
  const waiters = [...t.waiters];
  targets.delete(t.key);
  emit({ kind: 'online', target: t.key, since: t.since, downMs: Date.now() - t.since, waiters });
}

function emit(ev) {
  try { listener(ev); } catch {}
}

// { offline, since, targets: [{ target, since, waiting }] } — offline = some
// target has a term waiting and hasn't answered twice in a row yet
function status() {
  const list = [...targets.values()].map(t => ({ target: t.key, since: t.since, waiting: t.waiters.size }));
  return { offline: list.length > 0, since: list.length ? Math.min(...list.map(x => x.since)) : null, targets: list };
}

const waitingOn = (termId) => {
  for (const t of targets.values()) if (t.waiters.has(termId)) return t.key;
  return null;
};

module.exports = {
  netType: (error) => NET_TYPES.has(typeof error === 'string' ? error.trim().toLowerCase() : ''),
  isNetworkFailure,
  unambiguous,
  parseTarget,
  targetFor,
  probeOnce,
  wait,
  release,
  status,
  waitingOn,
  onChange: (fn) => { listener = typeof fn === 'function' ? fn : () => {}; },
  // smoke
  _setProbe: (fn) => { probe = typeof fn === 'function' ? fn : probeOnce; },
  _setTiming: (o) => { Object.assign(timing, o || {}); },
  _reset: () => { for (const t of targets.values()) clearTimeout(t.timer); targets.clear(); },
};
