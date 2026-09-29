import { el, toast, showMenu } from './common.js';

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
    { sep: true },
    { label: 'Close', danger: true, run: close },
  ]);
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
