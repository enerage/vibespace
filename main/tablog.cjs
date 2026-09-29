'use strict';
// Tab ↔ conversation audit trail for the instance log. Every state flush
// (renderer snapshot + main's session enrichment, ~every 5 s) is diffed against
// the previous one, so the log answers "which tab had which conversation, and
// when did that change" without digging. Written after a 12-hour silent loss:
// a tab showed a live claude conversation that was never recorded, and a
// restart reopened it as a plain terminal (2026-09-29).
//
//   diff(wsId, terminals)          → info lines (open snapshot, +tab, -tab,
//                                    session/name/kind changes)
//   audit(wsId, terminals, opts)   → warn lines, once per tab: looks like a
//                                    claude agent but has no conversation id

const last = new Map();   // wsId -> Map(termId -> { name, sid, claude, firstSeen })
const warned = new Set(); // `${wsId}|${termId}|${reason}` already warned
const UNTRACKED_AFTER_MS = 3 * 60 * 1000;

const q = (s) => JSON.stringify(String(s ?? ''));
const sidText = (s) => s || '—';

function diff(wsId, terminals, now = Date.now()) {
  const lines = [];
  const prev = last.get(wsId);
  const next = new Map();
  for (const t of Array.isArray(terminals) ? terminals : []) {
    if (!t || !t.termId) continue;
    const p = prev && prev.get(t.termId);
    next.set(t.termId, {
      name: t.name, sid: t.claudeSessionId || null, claude: Boolean(t.isClaude),
      firstSeen: p ? p.firstSeen : now,
    });
  }
  if (!prev) {
    // first flush after the window opened = what the restore produced
    lines.push(`open: ${next.size} tab${next.size === 1 ? '' : 's'}`);
    for (const [id, t] of next) lines.push(`  ${q(t.name)} (${id}) ${t.claude ? 'claude' : 'plain'} session=${sidText(t.sid)}`);
  } else {
    for (const [id, t] of next) {
      const p = prev.get(id);
      if (!p) { lines.push(`+ ${q(t.name)} (${id}) ${t.claude ? 'claude' : 'plain'} session=${sidText(t.sid)}`); continue; }
      if (p.name !== t.name) lines.push(`rename (${id}) ${q(p.name)} → ${q(t.name)}`);
      if (p.sid !== t.sid) lines.push(`${q(t.name)} (${id}) session ${sidText(p.sid)} → ${sidText(t.sid)}`);
      if (p.claude !== t.claude) lines.push(`${q(t.name)} (${id}) kind ${p.claude ? 'claude' : 'plain'} → ${t.claude ? 'claude' : 'plain'}`);
    }
    for (const [id, p] of prev) if (!next.has(id)) lines.push(`- ${q(p.name)} (${id}) session=${sidText(p.sid)}`);
  }
  last.set(wsId, next);
  return lines;
}

// opts: { hasFeed(termId) → bool (claude is talking to our feed), alive(termId) → bool }
function audit(wsId, terminals, opts = {}, now = Date.now()) {
  const lines = [];
  const cur = last.get(wsId);
  if (!cur) return lines;
  const hasFeed = opts.hasFeed || (() => false);
  const alive = opts.alive || (() => true);
  for (const [id, t] of cur) {
    if (t.sid || !alive(id)) continue;
    const feed = hasFeed(id);
    if (!t.claude && !feed) continue; // a genuine plain shell
    if (now - t.firstSeen < UNTRACKED_AFTER_MS) continue; // no first message yet is normal
    const key = `${wsId}|${id}|untracked`;
    if (warned.has(key)) continue;
    warned.add(key);
    lines.push(`untracked: ${q(t.name)} (${id}) ${feed ? 'has a live claude feed' : 'is a claude tab'} but no conversation id after ${Math.round((now - t.firstSeen) / 60000)} min — a restart would NOT resume it`);
  }
  return lines;
}

function forget(wsId) {
  last.delete(wsId);
  for (const k of [...warned]) if (k.startsWith(wsId + '|')) warned.delete(k);
}

module.exports = { diff, audit, forget, UNTRACKED_AFTER_MS };
