// Automatic account order (main/accounts.cjs rankRows): which account a
// running agent should be on, and when it may move there. Pure, no imports,
// so node can test it (scratch tests import this file directly).
//
// Rules (DECISIONS.md 2026-10-09):
// - target = the top-ranked account of the tab's family that has room; only
//   Claude conversations ('anthropic') follow the ranking, endpoints never move
// - the existing "move all" evidence still applies (busyForMove: a live `done`,
//   nothing typed, no dialog, compaction or background work, claude settled)
// - AND the prompt cache is cold: a move restarts claude, and with a warm cache
//   the next turn would re-read the whole conversation at full price
// - a tab moved by the automatic order stays put for 30 min unless its account
//   has no room (no ping-pong); two failed moves hold it for 30 min

export const MOVE_SETTLE_MS = 20000; // a claude that just started isn't idle yet
export const AUTO_COOLDOWN_MS = 30 * 60 * 1000;
export const NO_CACHE_COLD_MS = 60 * 60 * 1000; // no cache info: an hour after its turn ended

// the first account of `family` in the ranking that has room and is usable
export function topOf(state, family, usable = () => true) {
  if (!state || !Array.isArray(state.accounts)) return null;
  const ids = Array.isArray(state.ranked) && state.ranked.length ? state.ranked : state.accounts.map(a => a.id);
  for (const id of ids) {
    const a = state.accounts.find(x => x.id === id);
    if (a && (a.family || 'anthropic') === family && a.room !== false && usable(a)) return id;
  }
  return null;
}

// Where the automatic order wants this tab, or null (auto off, not a Claude
// conversation, already on the top account, cooling down).
export function autoTarget(tab, state, now, { family, usable = () => true } = {}) {
  if (!state || !state.auto || !tab || !tab.isClaude || tab.dead || !tab.sessionId) return null;
  if (family !== 'anthropic') return null;
  if (tab.autoHoldUntil && now < tab.autoHoldUntil) return null;
  const cur = tab.account || 'login';
  const top = topOf(state, family, usable);
  if (!top || top === cur) return null;
  const row = state.accounts.find(a => a.id === cur);
  const curRoom = Boolean(row && row.room !== false && usable(row));
  if (tab.autoMovedAt && now - tab.autoMovedAt < AUTO_COOLDOWN_MS && curRoom) return null;
  return top;
}

// Positive evidence that the tab is idle (same rules as "Move all here").
// bgCount = background tasks the finished turn left running.
export function busyForMove(tab, feed, now, bgCount = 0) {
  if (tab.switching || tab.status !== 'done' || !tab.doneAt || tab.draft) return true;
  if (now - (tab.launchedAt || 0) < MOVE_SETTLE_MS) return true;
  if (feed && (feed.compacting || feed.attention)) return true;
  return bgCount > 0;
}

// When the tab's prompt cache is cold (ms): the feed's absolute deadline
// (promptCache.expiresAt, epoch s), else an hour after its turn ended; null
// = can't tell yet (no finished turn seen).
export function cacheColdAt(feed, doneAt) {
  const pc = feed && feed.promptCache;
  if (pc && typeof pc.expiresAt === 'number' && Number.isFinite(pc.expiresAt)) return pc.expiresAt * 1000;
  return doneAt ? doneAt + NO_CACHE_COLD_MS : null;
}

// "Mon 15:00" (epoch s, local time), just "07:30" when it is today
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export function resetText(s, nowMs = Date.now()) {
  const d = new Date(s * 1000);
  return d.toDateString() === new Date(nowMs).toDateString() ? hhmm(d) : `${DAYS[d.getDay()]} ${hhmm(d)}`;
}

// Why an account sits where it does in the automatic order (a row of
// accounts.state()): "resets Mon 15:00 · 82 % left", "5h full until 07:30",
// "no reading yet".
export function roomText(a, nowMs = Date.now()) {
  if (!a) return '';
  if (a.blockedBy === 'out') return `out until ${resetText(a.roomAt, nowMs)}`;
  if (a.blockedBy === 'unavailable') return 'unavailable';
  if (a.blockedBy === '5h' || a.blockedBy === '7d') return `${a.blockedBy} full` + (a.roomAt ? ` until ${resetText(a.roomAt, nowMs)}` : '');
  if (a.kind === 'endpoint') return 'manual order';
  if (a.weeklyResetAt) return `resets ${resetText(a.weeklyResetAt, nowMs)} · ${Math.round(100 - (a.weeklyPct || 0))} % left`;
  return 'no reading yet';
}

// One toast per burst of automatic moves instead of one per tab.
// moves = [{ name, to, toLabel, why }] → one line per target account:
// "agent-3 moved to MAIN (automatic order: …)" for one,
// "Moved 6 agents to MAIN (automatic order: …): agent-1, agent-2, agent-4 +3" for more.
// The reason is shown when every move to that account had the same one.
export function autoMoveSummary(moves, maxNames = 3) {
  const byTo = new Map();
  for (const m of moves || []) {
    if (!m || !m.to) continue;
    if (!byTo.has(m.to)) byTo.set(m.to, []);
    byTo.get(m.to).push(m);
  }
  const lines = [];
  for (const list of byTo.values()) {
    const label = list[0].toLabel || list[0].to;
    const whys = [...new Set(list.map(m => m.why || ''))];
    const why = whys.length === 1 && whys[0] ? `automatic order: ${whys[0]}` : 'automatic order';
    if (list.length === 1) { lines.push(`${list[0].name} moved to ${label} (${why})`); continue; }
    const names = list.slice(0, maxNames).map(m => m.name).join(', ') + (list.length > maxNames ? ` +${list.length - maxNames}` : '');
    lines.push(`Moved ${list.length} agents to ${label} (${why}): ${names}`);
  }
  return lines;
}

// One verdict for the automatic order: { to, wait } — to = target or null;
// wait = null (move now) | 'busy' | ms epoch when its cache goes cold | 'unknown'.
export function autoDecision(tab, feed, state, now, { family, usable, bgCount = 0 } = {}) {
  const to = autoTarget(tab, state, now, { family, usable });
  if (!to) return { to: null, wait: null };
  if (busyForMove(tab, feed, now, bgCount)) return { to, wait: 'busy' };
  const coldAt = cacheColdAt(feed, tab.doneAt);
  if (coldAt === null) return { to, wait: 'unknown' };
  return coldAt > now ? { to, wait: coldAt } : { to, wait: null };
}
