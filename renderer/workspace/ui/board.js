import { $, el, cardOnHover, hideCard } from './common.js';
import { fmtElapsed, fmtAgo, taskItems, cacheChip, compactSoon, wtText } from './feedui.js';
import * as terms from './terms.js';
import { cardFor as parkedCard, metaText as parkedMeta } from './parked.js';

// Agent board (▦ / Ctrl+Shift+B): this window's agents as cards in columns —
// Needs you · Working · Done · Other — plus a read-only "Other workspaces" strip
// fed by <dataRoot>/board/*.json (main/board.cjs). An overlay INSIDE #term-hosts:
// the terminals keep running underneath, nothing is disposed or refit, and the
// preview pane stays usable. Read-only mirror: tab state + feed are the truth.

let wsId = null;
let root = null;
let open = false;
let colsEl = null;
let othersEl = null;
let renderTimer = null;
let lastRender = 0;
let tickTimer = null;
const cards = new Map(); // termId -> { root, body, reply, input, col }
let others = [];
let bgEl = null;
let bgAgents = [];
let bgTimer = null;
let parkedEl = null;
let parkedKey = null; // rebuilt only when the shelf changes (a hover card must survive ticks)

const COLS = [
  ['needs', 'Needs you'],
  ['working', 'Working'],
  ['done', 'Done'],
  ['other', 'Other'],
];

// ---------- pure helpers ----------
export function columnOf(a) {
  const f = a.feed;
  const st = a.status;
  if (a.dead) return 'other';
  if (st === 'waiting' || (f && (f.failure || f.attention === 'permission' || f.attention === 'question'))) return 'needs';
  if (st !== 'done' && (st === 'working' || (f && f.nowDoing))) return 'working';
  if (st === 'done' || (f && f.turnEndedAt)) return 'done';
  return 'other';
}

// quick reply only where the agent sits at its prompt box: finished or failed
// turns. Permission / question / MCP dialogs are answered in the terminal — a
// typed "text + Enter" would pick the highlighted option (e.g. "Yes").
function canReply(a, col) {
  if (!a.feed || a.dead) return false;
  return col === 'done' || (col === 'needs' && Boolean(a.feed.failure));
}

const firstLines = (s, n) => (s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, n).join('\n');
const level = (pct) => (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : 'ok');

function lightClass(a) {
  const f = a.feed;
  let cls = 'status' + (a.status ? ' ' + a.status : '');
  if (f && f.failure) cls += ' failed';
  else if (a.status === 'waiting' && f && f.attention === 'permission') cls += ' perm';
  else if (a.status === 'waiting' && f && f.attention === 'question') cls += ' question';
  return cls;
}

// ---------- card rendering (in place: the reply input survives re-renders) ----------
function cardBody(a, col) {
  const f = a.feed;
  const body = el('div', 'bc-body');
  const head = el('div', 'bc-head');
  head.append(el('span', lightClass(a)), el('span', 'bc-name', a.name));
  if (f && f.model && f.model.name) head.append(el('span', 'bc-model', f.model.name));
  body.append(head);
  if (a.worktree) body.append(el('div', 'bc-wt', wtText(a.worktree)));

  let line = '';
  let lineCls = 'bc-line';
  if (!f) line = a.dead ? 'exited' : a.isClaude ? 'no feed yet (started before 0.6.16, or not talking yet)' : 'plain terminal';
  else if (col === 'needs') {
    line = f.reason ? f.reason.replace(/^is /, '') : 'needs your input';
    lineCls += ' needs';
    if (f.attention === 'permission' && !f.failure) lineCls += ' perm';
  } else if (col === 'working') line = f.compacting ? 'compacting context…' : f.nowDoing ? [f.nowDoing.tool, f.nowDoing.detail].filter(Boolean).join(' ') : 'thinking…';
  else if (col === 'done') { line = firstLines(f.lastMessage, 2) || 'finished its turn'; lineCls += ' reply'; }
  body.append(el('div', lineCls, line));
  if (col === 'needs' && f && f.attention === 'permission' && !f.failure) body.append(el('div', 'bc-hint', 'Approve or deny in the terminal — click to open it'));

  if (f) {
    const meta = el('div', 'bc-meta');
    if (f.context && typeof f.context.pct === 'number') {
      const bar = el('span', 'lim-bar');
      const fill = el('span', 'lim-fill ' + level(f.context.pct));
      fill.style.width = Math.max(0, Math.min(100, f.context.pct)) + '%';
      bar.append(fill);
      const c = el('span', 'bc-ctx');
      c.append(bar, el('span', '', Math.round(f.context.pct) + '%'));
      meta.append(c);
    }
    if (typeof f.cost === 'number') meta.append(el('span', '', '$' + f.cost.toFixed(2)));
    if (f.linesAdded || f.linesRemoved) meta.append(el('span', '', `+${f.linesAdded || 0}/−${f.linesRemoved || 0}`));
    if (col === 'working' && f.turnStartedAt) meta.append(el('span', '', 'working ' + fmtElapsed(Date.now() - f.turnStartedAt)));
    else if (col !== 'working' && f.turnEndedAt) meta.append(el('span', '', 'done ' + fmtAgo(f.turnEndedAt)));
    if (f.subagents > 0) meta.append(el('span', '', `${f.subagents} subagent${f.subagents > 1 ? 's' : ''}`));
    const chip = cacheChip(f, col === 'working' || (col === 'needs' && !f.failure));
    if (chip) meta.append(chip);
    if (compactSoon(f, col === 'working')) meta.append(el('span', 'ts-hint', 'auto-compact soon'));
    if (meta.childNodes.length) body.append(meta);
    const items = taskItems(f);
    if (items.length) {
      const done = items.filter(t => t.status === 'completed').length;
      const cur = items.find(t => t.status === 'in_progress');
      const tl = el('div', 'bc-tasks');
      tl.append(el('span', 'bc-count', `${done}/${items.length} tasks`));
      if (cur) tl.append(el('span', 'bc-cur', cur.activeForm || cur.text));
      body.append(tl);
    }
  }
  return body;
}

function makeReply(id) {
  const wrap = el('div', 'bc-reply');
  const input = el('input', 'bc-input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'Reply… (Enter sends)';
  input.title = 'Types this into the agent and presses Enter';
  const state = el('span', 'bc-sent hidden', 'sent ✓');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // board shortcuts / Esc-close must not fire while typing
    if (e.key === 'Escape') { input.blur(); root.focus(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return; // guard: never send an empty Enter (it would confirm whatever is selected)
    if (terms.sendToAgent(id, text)) {
      input.value = '';
      state.classList.remove('hidden');
      setTimeout(() => state.classList.add('hidden'), 1600);
    }
  });
  wrap.addEventListener('click', (e) => e.stopPropagation()); // typing area never opens the tab
  wrap.append(input, state);
  return { wrap, input };
}

function render() {
  lastRender = Date.now();
  renderTimer = null;
  if (!open) return;
  // keep focus + caret across re-renders (cards may move between columns)
  const ae = document.activeElement;
  const focusId = ae && ae.classList && ae.classList.contains('bc-input') ? ae.closest('.bcard')?.dataset.termId : null;
  const sel = focusId ? [ae.selectionStart, ae.selectionEnd] : null;

  const list = terms.agents();
  const byCol = { needs: [], working: [], done: [], other: [] };
  for (const a of list) byCol[columnOf(a)].push(a);
  byCol.done.sort((x, y) => ((y.feed && y.feed.turnEndedAt) || 0) - ((x.feed && x.feed.turnEndedAt) || 0));

  const seen = new Set();
  for (const [col] of COLS) {
    const colEl = colsEl.querySelector(`.bcol[data-col="${col}"]`);
    const box = colEl.querySelector('.bcol-cards');
    colEl.classList.toggle('empty', byCol[col].length === 0);
    colEl.querySelector('.bcol-count').textContent = String(byCol[col].length);
    byCol[col].forEach((a, i) => {
      seen.add(a.id);
      let c = cards.get(a.id);
      if (!c) {
        const r = el('div', 'bcard');
        r.dataset.termId = a.id;
        r.onclick = () => { terms.activate(a.id); close(); };
        c = { root: r, body: null, reply: null, input: null };
        cards.set(a.id, c);
      }
      const body = cardBody(a, col);
      if (c.body) c.body.replaceWith(body); else c.root.prepend(body);
      c.body = body;
      c.root.className = 'bcard col-' + col;
      if (canReply(a, col)) {
        if (!c.reply) { const r = makeReply(a.id); c.reply = r.wrap; c.input = r.input; }
        if (c.reply.parentNode !== c.root) c.root.append(c.reply);
      } else if (c.reply && c.reply.parentNode) {
        c.reply.remove();
      }
      if (box.children[i] !== c.root) box.insertBefore(c.root, box.children[i] || null);
    });
  }
  for (const [id, c] of cards) if (!seen.has(id)) { c.root.remove(); cards.delete(id); }

  if (focusId) {
    const c = cards.get(focusId);
    if (c && c.input && c.input.isConnected && document.activeElement !== c.input) {
      c.input.focus();
      try { c.input.setSelectionRange(sel[0], sel[1]); } catch {}
    }
  }
  renderParked();
  renderOthers();
  // elapsed labels: 1 s while someone works, else 30 s
  clearTimeout(tickTimer);
  tickTimer = setTimeout(schedule, byCol.working.length ? 1000 : 30000);
}

// ≤ 4 renders/s however fast feed ticks arrive
function schedule() {
  if (!open || renderTimer) return;
  renderTimer = setTimeout(render, Math.max(0, 250 - (Date.now() - lastRender)));
}

// ---------- parked agents (ui/parked.js): click = unpark, hover = card ----------
function renderParked() {
  const list = terms.parkedList();
  const key = list.map(e => `${e.id}:${e.name}`).join('|');
  if (key === parkedKey) return;
  parkedKey = key;
  hideCard();
  parkedEl.innerHTML = '';
  parkedEl.classList.toggle('hidden', list.length === 0);
  if (!list.length) return;
  const row = el('div', 'bo-row bp-row');
  row.append(el('span', 'bo-name', `Parked (${list.length})`));
  const chips = el('span', 'bo-chips');
  for (const e of list) {
    const chip = el('span', 'bchip bp-chip');
    chip.append(el('span', 'bp-glyph', '🅿'), el('span', 'bchip-name', e.name), el('span', 'bchip-why', parkedMeta(e)));
    cardOnHover(chip, () => parkedCard(e), { place: 'above' });
    chip.onclick = (ev) => { ev.stopPropagation(); hideCard(); terms.unparkAgent(e.id); close(); };
    chips.append(chip);
  }
  row.append(chips);
  parkedEl.append(row);
}

// ---------- other workspaces (read-only) ----------
function chipLight(a) {
  return 'status' + (a.status ? ' ' + a.status : '') + (a.failed ? ' failed' : '');
}

function renderOthers() {
  othersEl.innerHTML = '';
  othersEl.classList.toggle('hidden', others.length === 0);
  if (!others.length) return;
  othersEl.append(el('div', 'bo-head', 'Other workspaces'));
  for (const w of others) {
    const row = el('div', 'bo-row');
    row.title = `Switch to ${w.name}`;
    row.append(el('span', 'bo-name', w.name));
    const chips = el('span', 'bo-chips');
    if (!w.agents.length) chips.append(el('span', 'bo-none', 'no agents'));
    for (const a of w.agents) {
      const chip = el('span', 'bchip');
      const short = a.failed || a.status === 'waiting' ? (a.reason || 'needs you').replace(/^is /, '')
        : a.status === 'working' ? (a.nowDoing || 'working') : a.status === 'done' ? 'done' : '';
      chip.append(el('span', chipLight(a)), el('span', 'bchip-name', a.name));
      if (short) chip.append(el('span', 'bchip-why', short));
      chip.title = [a.name, short, a.contextPct != null ? `context ${Math.round(a.contextPct)}%` : '', a.tasks ? `${a.tasks.done}/${a.tasks.total} tasks` : ''].filter(Boolean).join(' · ');
      chips.append(chip);
    }
    row.append(chips);
    row.onclick = () => vs.boardFocus(w.wsId);
    othersEl.append(row);
  }
}

// ---------- background agents (claude --bg) under this repo ----------
// main runs `claude agents --json --cwd <repo>`; polled every 15 s while the
// board is open only. Any failure = the section simply stays hidden.
function renderBg() {
  bgEl.innerHTML = '';
  bgEl.classList.toggle('hidden', bgAgents.length === 0);
  if (!bgAgents.length) return;
  bgEl.append(el('div', 'bo-head', `Background agents · ${bgAgents.length}`));
  for (const a of bgAgents) {
    const row = el('div', 'bg-row');
    const st = a.state === 'done' || a.status === 'idle' ? 'done' : a.status === 'waiting' ? 'waiting' : 'working';
    row.append(el('span', 'status ' + st), el('span', 'bg-name', a.name), el('span', 'bg-state', [a.state || a.status, a.waitingFor].filter(Boolean).join(' · ')));
    if (a.startedAt) row.append(el('span', 'bg-age', 'started ' + fmtAgo(a.startedAt)));
    const btn = el('button', 'btn small ghost', 'Attach');
    btn.title = `Open it in a new tab (claude attach ${a.id}); it keeps running when you close the tab`;
    btn.onclick = (e) => { e.stopPropagation(); terms.attachBackground(a.id, a.name); close(); };
    row.append(el('span', 'spacer'), btn);
    bgEl.append(row);
  }
}

async function pullBg() {
  clearTimeout(bgTimer);
  const r = await vs.bgList().catch(() => null);
  bgAgents = (r && r.ok && Array.isArray(r.agents)) ? r.agents : [];
  if (open) { renderBg(); bgTimer = setTimeout(pullBg, 15000); }
}

async function pullOthers() {
  others = (await vs.boardOthers(wsId).catch(() => [])) || [];
  if (open) renderOthers();
}

// ---------- open / close ----------
export function toggle() { if (open) close(); else show(); }

function show() {
  if (open) return;
  open = true;
  root.classList.remove('hidden');
  $('#btn-board')?.classList.add('active');
  render();
  root.focus(); // Esc closes only while focus is in the board
  pullOthers();
  pullBg();
  vs.boardWatch(true);
}

function close() {
  if (!open) return;
  open = false;
  root.classList.add('hidden');
  $('#btn-board')?.classList.remove('active');
  clearTimeout(tickTimer);
  clearTimeout(renderTimer);
  renderTimer = null;
  vs.boardWatch(false);
  clearTimeout(bgTimer);
  const id = terms.activeTermId();
  if (id) terms.activate(id); // focus back to the terminal
}

export function init(opts) {
  wsId = opts.wsId;
  root = $('#board');
  root.tabIndex = -1;
  const head = el('div', 'board-head');
  head.append(el('span', 'board-title', 'Agents'), el('span', 'board-hint', 'click a card to open its tab · Esc closes'));
  const x = el('button', 'btn small ghost', '✕');
  x.title = 'Close the board (Ctrl+Shift+B)';
  x.onclick = close;
  head.append(el('span', 'spacer'), x);
  colsEl = el('div', 'board-cols');
  for (const [key, title] of COLS) {
    const c = el('div', 'bcol empty');
    c.dataset.col = key;
    const h = el('div', 'bcol-head');
    h.append(el('span', 'bcol-title', title), el('span', 'bcol-count', '0'));
    c.append(h, el('div', 'bcol-cards'));
    colsEl.append(c);
  }
  othersEl = el('div', 'board-others hidden');
  bgEl = el('div', 'board-others board-bg hidden');
  parkedEl = el('div', 'board-others board-parked hidden');
  root.append(head, colsEl, parkedEl, bgEl, othersEl);

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  $('#btn-board').onclick = toggle;
  document.addEventListener('keydown', (e) => {
    // capture + stopPropagation: xterm must not also see Ctrl+B (tmux-style prefix)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); toggle(); }
  }, true);
  terms.onAgentsChanged(schedule);
  vs.onBoardChanged(() => { if (open) pullOthers(); });
}
