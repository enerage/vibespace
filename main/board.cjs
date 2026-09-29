'use strict';
// Agent board, cross-window part. Each workspace process writes a small summary
// of its agents to <dataRoot>/board/<wsId>.json so every other window's board can
// show an "Other workspaces" strip. Read-only mirror of state that lives
// elsewhere (status files = base, claude feed = detail): never a source of truth.
//   - written atomically, on change, at most once per 2 s; a 60 s heartbeat
//     rewrite keeps an idle workspace "fresh" (readers hide files older than 2 min)
//   - deleted when the workspace window closes / the process quits
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');
const logger = require('./logger.cjs');

const MIN_GAP = 2000;
const HEARTBEAT = 60 * 1000;
const FRESH = 2 * 60 * 1000;

const dir = () => path.join(U.dataRoot(), 'board');
const fileFor = (wsId) => path.join(dir(), `${wsId}.json`);

// ---------- pure: summary shape ----------
// terminals: renderer snapshot [{ termId, name, isClaude }]; statusOf(termId) →
// working|waiting|done|undefined; feedOf(termId) → claude feed state or null;
// reasonOf(state) → attention line (claudefeed.attentionText)
function buildSummary({ wsId, name, terminals, statusOf, feedOf, reasonOf, now = Date.now() }) {
  const agents = [];
  for (const t of terminals || []) {
    const f = feedOf(t.termId);
    if (!t.isClaude && !f) continue; // plain shells aren't agents
    const items = f ? ((f.tasks && f.tasks.length) ? f.tasks : (f.todos || [])) : [];
    agents.push({
      name: t.name || t.termId,
      status: statusOf(t.termId) || null,
      failed: Boolean(f && f.failure),
      reason: f ? reasonOf(f) : null,
      nowDoing: f && f.nowDoing ? [f.nowDoing.tool, f.nowDoing.detail].filter(Boolean).join(' ') : null,
      contextPct: f && f.context && typeof f.context.pct === 'number' ? f.context.pct : null,
      tasks: items.length ? { done: items.filter(x => x.status === 'completed').length, total: items.length } : null,
      turnEndedAt: (f && f.turnEndedAt) || null,
    });
  }
  return { wsId, name: name || wsId, updatedAt: now, agents };
}

// ---------- writer (per workspace) ----------
const writers = new Map(); // wsId -> { get, lastJson, lastAt, timer, beat }

function writeNow(wsId, force = false) {
  const w = writers.get(wsId);
  if (!w) return;
  w.timer = null;
  let summary;
  try { summary = w.get(); } catch (e) { logger.warn('board summary failed: ' + e.message); return; }
  if (!summary) return;
  const json = JSON.stringify({ ...summary, updatedAt: 0 }); // change test ignores the clock
  if (!force && json === w.lastJson) return;
  try {
    U.ensureDir(dir());
    U.writeJsonAtomic(fileFor(wsId), summary);
    w.lastJson = json;
    w.lastAt = Date.now();
  } catch (e) {
    logger.warn('board summary write failed: ' + e.message);
  }
}

// something changed for this workspace: write soon (≤ 1 write / 2 s)
function touch(wsId) {
  const w = writers.get(wsId);
  if (!w || w.timer) return;
  w.timer = setTimeout(() => writeNow(wsId), Math.max(0, MIN_GAP - (Date.now() - w.lastAt)));
}

function start(wsId, getSummary) {
  stop(wsId, { keepFile: true });
  const w = { get: getSummary, lastJson: '', lastAt: 0, timer: null, beat: null };
  w.beat = setInterval(() => { if (Date.now() - w.lastAt >= HEARTBEAT) writeNow(wsId, true); }, HEARTBEAT / 2);
  w.beat.unref?.();
  writers.set(wsId, w);
  touch(wsId);
}

function stop(wsId, { keepFile = false } = {}) {
  const w = writers.get(wsId);
  if (w) { clearTimeout(w.timer); clearInterval(w.beat); writers.delete(wsId); }
  if (!keepFile) { try { fs.rmSync(fileFor(wsId), { force: true }); } catch {} }
}

function stopAll() {
  for (const wsId of [...writers.keys()]) stop(wsId);
}

// ---------- reader ----------
// fresh summaries of every OTHER workspace (stale files = crashed/closed: hidden)
function readOthers(selfId, now = Date.now()) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json') || n === `${selfId}.json`) continue;
    const j = U.readJson(path.join(dir(), n), null);
    if (!j || typeof j.updatedAt !== 'number' || now - j.updatedAt > FRESH || !Array.isArray(j.agents)) continue;
    out.push(j);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

// watch the board dir only while some board is open: fs.watch + a 10 s poll
// fallback (fs.watch on Windows can miss atomic renames)
let watcher = null;
let poll = null;
let debounce = null;
function watch(onChange) {
  unwatch();
  U.ensureDir(dir());
  const fire = () => { clearTimeout(debounce); debounce = setTimeout(onChange, 300); };
  try { watcher = fs.watch(dir(), { persistent: false }, fire); } catch {}
  poll = setInterval(onChange, 10000);
  poll.unref?.();
}

function unwatch() {
  if (watcher) { try { watcher.close(); } catch {} }
  watcher = null;
  clearInterval(poll);
  clearTimeout(debounce);
  poll = null;
}

module.exports = { buildSummary, start, stop, stopAll, touch, readOthers, watch, unwatch, _writeNow: writeNow, _file: fileFor };
