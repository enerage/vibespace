import { el, toast, showMenu, confirmBox } from './common.js';
import { feedFor, accounts, relaunchOnAccount } from './terms.js';

// Right-click menu for terminal tabs (was: right-click = rename) + the
// "Agent info" panel. Kept out of terms.js: terms.js only hands us the tab
// object and two callbacks.
//   tab: { id, name, sessionId, isClaude, dead, status, cwd }

function copy(text, what) {
  vs.writeClipboard(text).then(() => toast(`${what} copied`, 'ok'));
}

// Claude Code keeps a conversation at ~/.claude/projects/<munged cwd>/<id>.jsonl,
// munging every non-alphanumeric char of the cwd to '-' (see sessions.cjs)
function transcriptPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  return `%USERPROFILE%\\.claude\\projects\\${cwd.replace(/[^a-zA-Z0-9]/g, '-')}\\${sessionId}.jsonl`;
}

function resumeCommand(sessionId) { return sessionId ? `claude --resume ${sessionId}` : null; }

function statusText(tab) {
  if (tab.dead) return 'exited';
  if (!tab.isClaude) return 'plain terminal';
  return { working: 'working', waiting: 'waiting for you', done: 'finished its turn (idle)' }[tab.status]
    || (tab.sessionId ? 'idle' : 'starting — no conversation yet');
}

export function openTabMenu(ev, tab, { rename, close }) {
  const sid = tab.sessionId;
  const noSid = 'No conversation captured yet — send a first message';
  showMenu(ev.clientX, ev.clientY, [
    { label: 'Rename…', run: rename },
    { label: 'Agent info…', run: () => showAgentInfo(tab) },
    { sep: true },
    { label: 'Copy name', run: () => copy(tab.name, 'Name') },
    { label: 'Copy session ID', disabled: !sid, hint: sid || noSid, run: () => copy(sid, 'Session ID') },
    { label: 'Copy resume command', disabled: !sid, hint: sid ? resumeCommand(sid) : noSid, run: () => copy(resumeCommand(sid), 'Resume command') },
    ...accountItems(tab),
    { sep: true },
    { label: 'Close', danger: true, run: close },
  ]);
}

// "Continue on <account>": one item per OTHER account, for a claude tab with a
// conversation, once there are >= 2 accounts. Same pty, `claude --resume`.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function untilText(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${DAYS[d.getDay()]}`;
}

function accountItems(tab) {
  const st = accounts();
  if (!tab.isClaude || tab.dead || !tab.sessionId || !st || st.accounts.length < 2) return [];
  const cur = tab.account || 'login';
  const items = [];
  for (const a of st.accounts) {
    if (a.id === cur) continue;
    const out = Boolean(a.exhaustedUntil && a.exhaustedUntil > Date.now());
    items.push({
      label: `Continue on ${a.label}` + (out ? ` (out until ${untilText(a.exhaustedUntil)})` : ''),
      disabled: out || Boolean(tab.switching),
      hint: a.kind === 'token' ? 'Resume this conversation on that account (no phone control there)' : 'Resume this conversation on that account',
      run: () => moveTo(tab, a),
    });
  }
  return items.length ? [{ sep: true }, ...items] : [];
}

async function moveTo(tab, a) {
  if (tab.status === 'working' && !(await confirmBox(`Interrupt the running turn and move this agent to ${a.label}?`, { ok: 'Move' }))) return;
  // a failed last turn (e.g. this account hit its limit) restarts with
  // `continue`; otherwise the conversation just resumes and waits for you
  const failed = Boolean(feedFor(tab.id)?.failure);
  relaunchOnAccount(tab, a.id, { prompt: failed ? 'continue' : null });
}

// Read-only details panel: every value has its own copy button, plus
// "Copy all" as a paste-ready block (for an agent, an issue, a note).
export function showAgentInfo(tab) {
  const rows = [
    ['Name', tab.name],
    ['Kind', tab.isClaude ? 'Claude agent' : 'Terminal'],
    ['Status', statusText(tab)],
    ['Session ID', tab.sessionId],
    ['Resume', resumeCommand(tab.sessionId)],
    ['Transcript', transcriptPath(tab.cwd, tab.sessionId)],
    ['Folder', tab.cwd],
    ['Terminal ID', tab.id],
  ];
  // live detail from the claude data feed (main/claudefeed.cjs), when this tab has one
  const f = feedFor(tab.id);
  if (f) {
    const c = f.context;
    const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
    const items = (f.tasks && f.tasks.length) ? f.tasks : (f.todos || []);
    rows.splice(3, 0,
      ['Model', f.model && f.model.name],
      ['Context', c && typeof c.pct === 'number' ? `${Math.round(c.pct)}%` + (c.size ? ` (${tok(c.used || 0)} / ${tok(c.size)} tokens)` : '') : null],
      ['Cost', typeof f.cost === 'number' ? '$' + f.cost.toFixed(2) : null],
      ['Lines', f.linesAdded || f.linesRemoved ? `+${f.linesAdded || 0} / −${f.linesRemoved || 0}` : null],
      ['Tasks', items.length ? `${items.filter(t => t.status === 'completed').length}/${items.length} done` : null],
      ['Session name', f.sessionName]);
  }

  const back = el('div', 'info-modal');
  const box = el('div', 'info-box');
  box.appendChild(el('h3', '', tab.name));
  const grid = el('div', 'info-grid');
  for (const [k, v] of rows) {
    grid.appendChild(el('div', 'info-k', k));
    const val = el('div', 'info-v' + (v ? '' : ' none'), v || '—');
    grid.appendChild(val);
    const btn = el('button', 'btn small ghost', 'Copy');
    btn.disabled = !v;
    btn.onclick = () => copy(v, k);
    grid.appendChild(btn);
  }
  box.appendChild(grid);
  const actions = el('div', 'info-actions');
  const all = el('button', 'btn small', 'Copy all');
  all.onclick = () => copy(rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n'), 'Agent info');
  const ok = el('button', 'btn small primary', 'Close');
  actions.append(all, ok);
  box.appendChild(actions);
  back.appendChild(box);
  document.body.appendChild(back);

  const done = () => { back.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
  ok.onclick = done;
  back.addEventListener('mousedown', (e) => { if (e.target === back) done(); });
  window.addEventListener('keydown', onKey, true);
  ok.focus();
}
