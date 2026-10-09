import { $ } from './common.js';
import * as terms from './terms.js';
import { fmtAgo } from './feedui.js';

// Internet outage chip in the top bar, next to the plan-limit chip:
// `⚠ Offline · 3 waiting`. Shown while main's probe says the API can't be
// reached (main/netwatch.cjs) or while any agent of this window waits for the
// internet (feed.net). Hidden otherwise. The waiting agents continue by
// themselves when the API answers again (terms.js netResume).

let net = { offline: false, since: null, targets: [] };

function render() {
  const chip = $('#net-chip');
  if (!chip) return;
  const waiting = terms.agents().filter(a => a.feed && a.feed.net);
  if (!net.offline && !waiting.length) { chip.classList.add('hidden'); return; }
  chip.textContent = net.offline
    ? `⚠ Offline${waiting.length ? ` · ${waiting.length} waiting` : ''}`
    : `⚠ ${waiting.length} waiting for the internet`;
  const tip = [];
  if (net.offline) {
    const hosts = (net.targets || []).map(t => t.target).join(', ');
    tip.push(`The API can't be reached${hosts ? ` (${hosts})` : ''}${net.since ? `, since ${fmtAgo(net.since)}` : ''}.`);
  } else tip.push('The API answers again: the waiting agents are being continued.');
  if (waiting.length) {
    tip.push('', 'Waiting agents (they continue automatically when it\'s back):');
    for (const a of waiting.slice(0, 20)) tip.push(`• ${a.name}`);
    if (waiting.length > 20) tip.push(`• +${waiting.length - 20} more`);
  }
  tip.push('', 'No toasts while it lasts. A tab you type in is left for you.');
  chip.title = tip.join('\n');
  chip.classList.remove('hidden');
}

export function init() {
  vs.onNetState((st) => { if (st) { net = st; render(); } });
  vs.netGet().then((st) => { if (st) { net = st; render(); } }).catch(() => {});
  terms.onAgentsChanged(render);
  setInterval(render, 30000); // "since 3m ago" in the tooltip
}
