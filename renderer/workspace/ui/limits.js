import { $, el } from './common.js';

// Plan-limit chip in the top bar: `5h ▰▰▱ 42% · 1h12m   7d ▰▱▱ 18%`.
// Fed by claude's statusLine via main (claudefeed.cjs → account:limits); the
// limits are account-wide, so every window shows the same numbers. Hidden until
// the first data arrives (API-key users never get any). The countdown is local
// math on resets_at, re-rendered every 30 s — no statusLine refresh needed.

let limits = null;

const level = (pct) => (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : 'ok');

function countdown(resetsAt) {
  if (!resetsAt) return '';
  const s = Math.round(resetsAt - Date.now() / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${Math.max(1, m)}m`;
}

function resetText(resetsAt) {
  if (!resetsAt) return 'reset time unknown';
  const at = new Date(resetsAt * 1000);
  const sameDay = at.toDateString() === new Date().toDateString();
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = sameDay ? time : `${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
  return `resets ${when} (in ${countdown(resetsAt)})`;
}

// a window whose reset time has passed (data seeded from limits.json, or no agent
// ticked since) no longer knows its %: show — instead of a stale number
const stale = (w) => Boolean(w.resetsAt && w.resetsAt * 1000 < Date.now());

function segment(label, w, withCountdown) {
  const old = stale(w);
  const seg = el('span', 'lim-seg' + (old ? ' stale' : ''));
  seg.append(el('span', 'lim-name', label));
  const bar = el('span', 'lim-bar');
  const fill = el('span', 'lim-fill ' + level(w.pct));
  fill.style.width = (old ? 0 : Math.max(0, Math.min(100, w.pct))) + '%';
  bar.append(fill);
  seg.append(bar, el('span', 'lim-pct', old ? '—' : Math.round(w.pct) + '%'));
  const cd = withCountdown && !old ? countdown(w.resetsAt) : '';
  if (cd) seg.append(el('span', 'lim-cd', '· ' + cd));
  return seg;
}

function render() {
  const chip = $('#limits-chip');
  if (!chip) return;
  const five = limits && limits.fiveHour;
  const seven = limits && limits.sevenDay;
  if (!five && !seven) { chip.classList.add('hidden'); return; }
  chip.innerHTML = '';
  const tip = [];
  if (five) {
    chip.append(segment('5h', five, true));
    tip.push(stale(five) ? '5-hour window: reset since the last update — no newer data' : `5-hour window: ${Math.round(five.pct)}% used — ${resetText(five.resetsAt)}`);
  }
  if (seven) {
    chip.append(segment('7d', seven, false));
    tip.push(stale(seven) ? '7-day window: reset since the last update — no newer data' : `7-day window: ${Math.round(seven.pct)}% used — ${resetText(seven.resetsAt)}`);
  }
  tip.push('Claude plan usage, account-wide (from claude’s status line)');
  chip.title = tip.join('\n');
  chip.classList.toggle('hot', [five, seven].some(w => w && !stale(w) && w.pct >= 90));
  chip.classList.remove('hidden');
}

export function init(wsId) {
  vs.onAccountLimits((l) => { limits = l; render(); });
  // the snapshot also carries limits another VibeSpace process saw (main shares
  // them via <dataRoot>/limits.json), so a window with no running agent still
  // shows the chip; re-asked every few minutes for the same reason
  const pull = () => vs.feedSnapshot(wsId).then((snap) => {
    if (snap && snap.limits && JSON.stringify(snap.limits) !== JSON.stringify(limits)) { limits = snap.limits; render(); }
  }).catch(() => {});
  pull();
  setInterval(pull, 3 * 60 * 1000);
  setInterval(render, 30000);
}
