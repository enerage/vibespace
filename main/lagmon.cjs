'use strict';
// Typing-lag evidence for the instance log. When a keystroke takes long to show
// up, the log should say WHERE the time went: the machine (CPU pinned by agents'
// test runs/builds), claude/ConPTY (slow echo), or VibeSpace itself (a blocked
// main loop or renderer). Written after "I type and nothing shows" turned out to
// be 16 cores at 100% from agents' vitest/tsc runs (2026-10-02).
//
//   noteInput(termId, data)   main, on pty:write — starts an echo timer for a
//                             single printable key / backspace
//   noteOutput(termId)        main, on pty data — closes it (input → pty echo)
//   report(r)                 renderer reports: { kind: 'typing', termId, name, ms }
//                             (key → painted) or { kind: 'stall', ms } (blocked
//                             renderer). Returns the log line or null (throttled)
//   start(log)                CPU sampler + main event-loop stall watch

const os = require('node:os');

const LAG_MS = 500;          // slower than this is worth a line
const THROTTLE_MS = 15000;   // per kind+term, so a bad minute isn't 100 lines

const pending = new Map();   // termId -> input time
const lastEcho = new Map();  // termId -> { ms, at }
const lastLine = new Map();  // key -> { at, skipped }
let cpuPct = null;           // whole-machine busy %, sampled every 2 s
let mainStallMax = 0;        // worst main-loop stall since the last line
let prevCpu = null;

function isKey(data) {
  return typeof data === 'string' && data.length === 1 && (data >= ' ' || data === '\x7f' || data === '\b');
}

function noteInput(termId, data, now = Date.now()) {
  if (isKey(data) && !pending.has(termId)) pending.set(termId, now);
}

function noteOutput(termId, now = Date.now()) {
  const t0 = pending.get(termId);
  if (t0 == null) return;
  pending.delete(termId);
  lastEcho.set(termId, { ms: now - t0, at: now });
}

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { idle, total };
}

function sampleCpu() {
  const cur = cpuTimes();
  if (prevCpu && cur.total > prevCpu.total) {
    cpuPct = Math.round(100 * (1 - (cur.idle - prevCpu.idle) / (cur.total - prevCpu.total)));
  }
  prevCpu = cur;
}

function context(termId, now, main = true) {
  const parts = [];
  const e = termId && lastEcho.get(termId);
  if (e && now - e.at < 10000) parts.push(`claude/pty echo ${e.ms}ms`);
  if (cpuPct != null) parts.push(`cpu ${cpuPct}%`);
  if (main) parts.push(mainStallMax >= LAG_MS ? `main loop stalled ${mainStallMax}ms` : 'main loop ok');
  return parts.join(' · ');
}

function report(r, now = Date.now()) {
  if (!r || !(r.ms >= LAG_MS)) return null;
  const key = `${r.kind}|${r.termId || ''}`;
  const prev = lastLine.get(key);
  if (prev && now - prev.at < THROTTLE_MS) { prev.skipped++; return null; }
  const more = prev && prev.skipped ? ` (+${prev.skipped} more since last line)` : '';
  lastLine.set(key, { at: now, skipped: 0 });
  const ms = Math.round(r.ms);
  const what = r.kind === 'typing'
    ? `typing ${JSON.stringify(String(r.name || ''))} (${r.termId}) key→screen ${ms}ms`
    : r.kind === 'stall' ? `renderer blocked ${ms}ms`
    : `${r.kind} ${ms}ms`;
  const line = `lag: ${what} · ${context(r.termId, now, r.kind !== 'main loop blocked')}${more}`;
  mainStallMax = 0;
  return line;
}

let started = false;
function start(log) {
  if (started) return;
  started = true;
  sampleCpu();
  setInterval(sampleCpu, 2000).unref();
  // main event-loop stall: a 250 ms tick that arrives late = main was blocked.
  // The first 30 s are boot (window, ptys, restore) and block by design.
  const quietUntil = Date.now() + 30000;
  let expect = Date.now() + 250;
  setInterval(() => {
    const now = Date.now();
    const late = now - expect;
    expect = now + 250;
    if (now < quietUntil) return;
    if (late > mainStallMax) mainStallMax = late;
    if (late >= 1000) {
      const line = report({ kind: 'main loop blocked', ms: late }, now);
      if (line) log(line);
    }
  }, 250).unref();
}

function forget(termId) { pending.delete(termId); lastEcho.delete(termId); }

module.exports = { noteInput, noteOutput, report, start, forget, LAG_MS, _isKey: isKey };
