import { $, el } from './common.js';

// Plan-limit chip in the top bar: `5h ▰▰▱ 42% · 1h12m   7d ▰▱▱ 18%`.
// With several Claude accounts (the /login + `claude setup-token` accounts,
// main/accounts.cjs) one labelled group per account, in preference order:
// `Main 5h ▰▱ 32% · 2h06m 7d ▰▱ 11% │ Work 5h …`. Endpoint accounts (z.ai…)
// report no plan limits and are left out. One Claude account = no label, the
// chip looks as it always did.
// Sources: the /login account = claude's statusLine via main (claudefeed.cjs →
// account:limits, live; the feed snapshot also carries the copy another
// VibeSpace process saw via <dataRoot>/limits.json). Token accounts = their
// reading in accounts.json (accounts.setLimits, written on change only), pushed
// by main as accounts:changed — it only changes while one of THAT account's
// agents runs. Hidden until some data arrives (API-key users never get any).
// The countdown is local math on resets_at, re-rendered every 30 s.

let live = null;   // /login account: { fiveHour: { pct, resetsAt }, sevenDay }
let liveAt = 0;    // ms the /login reading last changed
let accts = null;  // main's accounts.state()
let fit = 0;       // 0 full · 1 countdowns dropped · 2 bars dropped too (top bar too narrow)

const LABEL_MAX = 12;
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

// "14:20" today, "Thu 14:20" otherwise
function clock(ms) {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function resetText(resetsAt) {
  if (!resetsAt) return 'reset time unknown';
  const at = new Date(resetsAt * 1000);
  const sameDay = at.toDateString() === new Date().toDateString();
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = sameDay ? time : `${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
  return `resets ${when} (in ${countdown(resetsAt)})`;
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

// a window whose reset time has passed (data seeded from limits.json, or no agent
// ticked since) no longer knows its %: show — instead of a stale number
const stale = (w) => Boolean(w.resetsAt && w.resetsAt * 1000 < Date.now());
const fresh = (w) => Boolean(w && !stale(w));

// accounts.json keeps the raw statusLine shape ({ five_hour: { used_percentage, resets_at } })
function fromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const w = (x) => (x && typeof x.used_percentage === 'number' ? { pct: x.used_percentage, resetsAt: x.resets_at ?? null } : null);
  const out = { fiveHour: w(raw.five_hour), sevenDay: w(raw.seven_day) };
  return out.fiveHour || out.sevenDay ? out : null;
}

// the Claude accounts to show, each with its reading: [{ id, label, kind, lim, at, outUntil, reason }]
function rows() {
  const list = (accts && Array.isArray(accts.accounts) ? accts.accounts : [])
    .filter(a => a.kind === 'login' || a.kind === 'token');
  const out = [];
  for (const a of list) {
    const isLogin = a.kind === 'login';
    const lim = isLogin ? (live || fromRaw(a.limits)) : fromRaw(a.limits);
    // a PC without a Claude login (endpoint/token only) has nothing to show for it
    if (isLogin && a.note === 'not logged in' && !lim) continue;
    out.push({
      id: a.id, label: a.label || a.id, kind: a.kind, lim,
      at: isLogin && live ? liveAt : (a.limitsAt || 0),
      outUntil: a.exhaustedUntil && a.exhaustedUntil > Date.now() ? a.exhaustedUntil : null,
      reason: a.reason || null,
    });
  }
  // accounts list not loaded yet (or failed): the /login reading alone, as before
  if (!out.length && live) out.push({ id: 'login', label: 'Logged-in account', kind: 'login', lim: live, at: liveAt, outUntil: null });
  return out;
}

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

const windowLine = (name, w) => (stale(w)
  ? `${name}: reset since the last update — no newer data`
  : `${name}: ${Math.round(w.pct)}% used — ${resetText(w.resetsAt)}`);

function tooltip(r) {
  const tip = [`${r.label} — ${r.kind === 'login' ? 'the /login account' : 'setup-token account'}`];
  if (r.outUntil) tip.push(`Out of usage — resets ${clock(r.outUntil)}${r.reason ? ` (${r.reason})` : ''}`);
  const five = r.lim && r.lim.fiveHour, seven = r.lim && r.lim.sevenDay;
  if (five) tip.push(windowLine('5-hour window', five));
  if (seven) tip.push(windowLine('7-day window', seven));
  if (!five && !seven) tip.push('No reading yet — it appears once one of this account’s agents runs');
  else if (r.at) tip.push(`updated ${ago(r.at)}` + (r.kind === 'token' ? ' (refreshes only while one of this account’s agents runs)' : ''));
  tip.push('Claude plan usage, from claude’s status line');
  return tip.join('\n');
}

// the 5h/7d segments of one reading into `box`; false when there is none
function appendWindows(box, lim) {
  const five = lim && lim.fiveHour, seven = lim && lim.sevenDay;
  if (five) box.append(segment('5h', five, true));
  if (seven) box.append(segment('7d', seven, false));
  return Boolean(five || seven);
}

function render() {
  const chip = $('#limits-chip');
  if (!chip) return;
  const list = rows();
  const any = list.some(r => r.lim);
  if (!any) { chip.classList.add('hidden'); return; }
  chip.innerHTML = '';
  if (list.length === 1) {
    // one Claude account: exactly the old chip, no label
    const r = list[0];
    appendWindows(chip, r.lim);
    chip.title = tooltip(r);
    chip.classList.toggle('hot', [r.lim.fiveHour, r.lim.sevenDay].some(w => fresh(w) && w.pct >= 90));
  } else {
    chip.title = '';
    let allHot = true;
    for (const r of list) {
      const g = el('span', 'lim-acct');
      g.title = tooltip(r);
      const short = r.label.length > LABEL_MAX ? r.label.slice(0, LABEL_MAX - 1) + '…' : r.label;
      g.append(el('span', 'lim-label', short));
      const wins = r.lim ? [r.lim.fiveHour, r.lim.sevenDay].filter(fresh) : [];
      if (r.outUntil) {
        g.classList.add('out');
        g.append(el('span', 'lim-out', `out · resets ${clock(r.outUntil)}`));
      } else if (!wins.length) {
        // no data yet, or every window reset since the last reading
        g.append(el('span', 'lim-pct lim-none', '—'));
        allHot = false;
      } else {
        appendWindows(g, r.lim);
        if (!wins.some(w => w.pct >= 90)) allHot = false;
      }
      chip.append(g);
    }
    // red border only when no Claude account has headroom left
    chip.classList.toggle('hot', allHot);
  }
  chip.classList.remove('hidden');
  refit(chip);
}

// Too wide for the top bar? Drop the countdowns first, then the bars.
// "Too wide" = the bar overflows or squeezes the workspace name (.ws-meta shrinks).
function refit(chip) {
  const bar = $('#topbar');
  const meta = bar && bar.querySelector('.ws-meta');
  if (!bar) return;
  const fits = () => bar.scrollWidth <= bar.clientWidth && (!meta || meta.scrollWidth <= meta.clientWidth + 1);
  const apply = (n) => {
    fit = n;
    chip.classList.toggle('no-cd', n >= 1);
    chip.classList.toggle('no-bar', n >= 2);
  };
  apply(0);
  while (fit < 2 && !fits()) apply(fit + 1);
}

export function init(wsId) {
  vs.onAccountLimits((l) => { live = l; liveAt = Date.now(); render(); });
  // token accounts' readings + exhaustion come with every accounts.json change
  // (any process); the list also says how many Claude accounts there are
  vs.onAccountsChanged((st) => { if (st && Array.isArray(st.accounts)) { accts = st; render(); } });
  vs.accountsList().then((st) => { if (st && Array.isArray(st.accounts)) { accts = st; render(); } }).catch(() => {});
  // the snapshot also carries limits another VibeSpace process saw (main shares
  // them via <dataRoot>/limits.json), so a window with no running agent still
  // shows the chip; re-asked every few minutes for the same reason
  const pull = () => vs.feedSnapshot(wsId).then((snap) => {
    if (snap && snap.limits && JSON.stringify(snap.limits) !== JSON.stringify(live)) {
      live = snap.limits;
      liveAt = snap.limitsAt || Date.now();
      render();
    }
  }).catch(() => {});
  pull();
  setInterval(pull, 3 * 60 * 1000);
  setInterval(render, 30000);
  let t = null;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
}
