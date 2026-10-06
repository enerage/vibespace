import { $, el, toast, confirmBox, showMenu } from './common.js';
import { termTheme, onThemeChange } from './themes.js';
import { openTabMenu } from './tabmenu.js';
import * as feedui from './feedui.js';
import * as board from './board.js';
import * as parked from './parked.js';
import * as inputsel from './inputsel.js';

// terminal tabs: each hosts a PowerShell pty; "claude" tabs run Claude Code and
// get their session id tracked (main process) so they can be resumed after updates.

let wsId;
let repoPath;
let persist = () => {};
let openFile = null; // (path, name, line) — file:line links hand off to the viewer
let remote = () => false; // phone control pref (⚙): launch claude with --remote-control
let wsName = '';

const tabs = new Map(); // termId -> tab record
const feeds = new Map(); // termId -> latest claude feed snapshot (main/claudefeed.cjs)
let activeId = null;
let counter = 0;
// parked agents (ui/parked.js): stopped, conversation kept; null until init
// loaded them, so an early snapshot can't save an empty shelf
let shelf = null;
let persistNow = async () => persist();

// ---- accounts (main/accounts.cjs) --------------------------------------------
// Each claude tab runs on an ACCOUNT: 'login' = the stored /login, others are
// `claude setup-token` tokens the shell wrapper hands to claude via env. The
// list is machine-wide; main pushes every change (any process).
let accountsState = null; // { accounts: [{ id, label, kind, exhaustedUntil, reason, limits }], pick }
let accountsReady = Promise.resolve();

export function accounts() { return accountsState; }
export function accountById(id) {
  return (accountsState && accountsState.accounts.find(a => a.id === id)) || null;
}
const isExhausted = (a) => Boolean(a && a.exhaustedUntil && a.exhaustedUntil > Date.now());
const multiAccount = () => Boolean(accountsState && accountsState.accounts.length >= 2);

function setAccounts(st) {
  if (!st || !Array.isArray(st.accounts)) return;
  const prev = accountsState;
  accountsState = st;
  renderTabBar(); // account chips appear/disappear/relabel
  // a new "move all agents here" (from any window): say what happens here
  if (prev && st.switchAll && (!prev.switchAll || prev.switchAll.at !== st.switchAll.at)) {
    const pending = [...tabs.values()].filter(pendingMove);
    const later = pending.filter(busyForMove).length;
    const a = accountById(st.switchAll.to);
    if (pending.length) {
      toast(`Moving ${pending.length} agent${pending.length > 1 ? 's' : ''} to ${a ? a.label : st.switchAll.to}`
        + (later ? ` (${later} when ${later > 1 ? 'their' : 'its'} turn ends)` : ''));
    }
  }
  drainMoves();
}

// The account a "move all agents here" (Preferences → Accounts, machine-wide)
// asks for, when that request is newer than the tab's own account choice
// (accountAt) and the account still has room.
const SWITCH_TTL_MS = 12 * 3600 * 1000; // same as main/accounts.cjs
function switchTarget(accountAt) {
  const sw = accountsState && accountsState.switchAll;
  if (!sw || !(sw.at > (accountAt || 0)) || Date.now() - sw.at > SWITCH_TTL_MS) return null;
  const a = accountById(sw.to);
  return a && !isExhausted(a) ? a.id : null;
}

// new agent → the first available account; a restored one keeps its saved
// account while it still exists and isn't out of usage, unless a newer
// "move all" asks for another one
function resolveAccount(saved, savedAt = 0) {
  if (saved) {
    const to = switchTarget(savedAt);
    if (to) return to;
  }
  const a = saved ? accountById(saved) : null;
  if (a && !isExhausted(a)) return a.id;
  return (accountsState && accountsState.pick) || 'login';
}

// ---- "move all agents here" ----------------------------------------------------
// A tab still owes a move when the request is newer than its account choice.
// Only tabs with a known conversation move: without a session id there is
// nothing to resume, and a relaunch could strand an untracked conversation.
function pendingMove(tab) {
  if (!tab || !tab.isClaude || tab.dead || !tab.sessionId) return null;
  const to = switchTarget(tab.accountAt);
  return to && to !== (tab.account || 'login') ? to : null;
}

// Never interrupt, never guess. A tab moves only on positive evidence that it is
// idle, seen by THIS window: a `done` status event (after a reload the status
// is unknown until the next one) and an empty prompt (tab.draft: nothing typed
// since the last Enter, also unknown after a reload). A running turn, an open
// dialog, a compaction, background work the turn left running (exiting claude
// would kill it) and a claude that is still starting all wait.
const MOVE_SETTLE_MS = 20000;
function busyForMove(tab) {
  if (tab.switching || tab.status !== 'done' || !tab.doneAt || tab.draft) return true;
  if (Date.now() - (tab.launchedAt || 0) < MOVE_SETTLE_MS) return true;
  const f = feeds.get(tab.id);
  if (f && (f.compacting || f.attention)) return true;
  return feedui.bgTasks(f, 'done').length > 0;
}

// one agent at a time: every relaunch stops and starts a claude
let moveChain = Promise.resolve();
let appWriting = false; // sendToAgent is pasting (see term.onData)
let moveRetry = null;
function drainLater(ms) {
  if (moveRetry) return;
  moveRetry = setTimeout(() => { moveRetry = null; drainMoves(); }, ms);
}
function drainMoves() {
  if (!accountsState || !accountsState.switchAll) return;
  for (const tab of tabs.values()) {
    if (tab.moveQueued || !pendingMove(tab)) continue;
    if (busyForMove(tab)) {
      // only "claude is still starting" ends by itself; the rest end with a `done`
      if (tab.status === 'done' && tab.doneAt && !tab.draft && !tab.switching) drainLater(MOVE_SETTLE_MS + 1000);
      continue;
    }
    tab.moveQueued = true;
    moveChain = moveChain.then(() => moveOne(tab)).catch((e) => console.warn('account move failed', e && e.message));
  }
}

async function moveOne(tab) {
  tab.moveQueued = false;
  const id = tab.id;
  let to = pendingMove(tab);
  if (!to || !tabs.has(id) || busyForMove(tab)) return;
  // The user may have left claude by hand: then this shell could be running
  // anything (a REPL, an editor), and nothing must be typed into it.
  const running = await vs.claudeRunning(id);
  to = pendingMove(tab);
  if (!to || !tabs.has(id) || busyForMove(tab)) return; // typed or started meanwhile
  if (running === false) {
    const used = await vs.setTermAccount(id, to); // the next `claude` typed here uses it
    tab.account = typeof used === 'string' ? used : to;
    tab.accountAt = Date.now();
    console.warn(`account move: ${id} has no claude running, account set to ${tab.account} without a relaunch`);
    renderTabBar();
    persist();
    return;
  }
  if (running === true) await relaunchOnAccount(tab, to, { prompt: null, gentle: true });
  if ((tab.account || 'login') !== to) {
    // couldn't tell, or claude didn't leave: one retry, then leave the tab alone
    tab.moveFails = (tab.moveFails || 0) + 1;
    if (tab.moveFails >= 2) { tab.accountAt = Date.now(); renderTabBar(); persist(); } else drainLater(30000);
  }
}

const TERM_OPTS = {
  fontSize: 13,
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  cursorBlink: true,
  scrollback: 6000,
  // theme comes from ui/themes.js per workspace (see createTab + onThemeChange)
  allowProposedApi: true,
};

// Typing-lag evidence (main/lagmon.cjs logs it with CPU load + echo time).
// A single printable key or backspace; pastes and escape sequences don't echo 1:1.
const LAG_MS = 500;
const isTypedKey = (d) => d.length === 1 && (d >= ' ' || d === '\x7f' || d === '\b');

// A 250 ms tick that arrives late = this renderer was blocked (xterm parsing,
// Monaco, a long task). Only while the window is focused and visible: Chromium
// throttles timers in background windows, which would read as false stalls.
function watchRendererStalls() {
  let expect = performance.now() + 250;
  const rearm = () => { expect = performance.now() + 250; }; // first tick after un-hiding is late by design
  document.addEventListener('visibilitychange', rearm);
  window.addEventListener('focus', rearm);
  setInterval(() => {
    const now = performance.now();
    const late = now - expect;
    expect = now + 250;
    if (late >= LAG_MS && !document.hidden && document.hasFocus()) vs.lagReport({ kind: 'stall', ms: late });
  }, 250);
}

export function init(opts) {
  wsId = opts.wsId;
  repoPath = opts.repoPath;
  persist = opts.persist || persist;
  persistNow = opts.persistNow || persistNow;
  openFile = opts.openFile || openFile;
  shelf = parked.normalizeParked(opts.savedParked);
  parked.init({ list: () => shelf || [], unpark: unparkAgent, forget: forgetParked });
  remote = opts.remote || remote;
  wsName = opts.wsName || '';

  // a theme switch repaints every live terminal in place (xterm v5 options setter)
  onThemeChange((t) => {
    for (const tab of tabs.values()) { try { tab.term.options.theme = t.term; } catch {} }
  });

  vs.onPtyData((termId, chunk) => {
    const tab = tabs.get(termId);
    if (!tab) return;
    const t0 = tab.lagT0;
    if (t0 == null) { tab.term.write(chunk); return; }
    // first output after a typed key: time key → parsed (+ next paint)
    tab.lagT0 = null;
    tab.term.write(chunk, () => {
      const done = () => {
        const ms = performance.now() - t0;
        if (ms >= LAG_MS) vs.lagReport({ kind: 'typing', termId, name: tab.name, ms });
      };
      if (document.hidden) done(); else requestAnimationFrame(done);
    });
  });
  watchRendererStalls();

  vs.onPtyExit((termId) => {
    const tab = tabs.get(termId);
    if (!tab) return;
    removeTab(termId, false);
  });

  vs.onSessionFound((termId, sessionId) => {
    const tab = tabs.get(termId);
    if (!tab || !sessionId || tab.sessionId === sessionId) return;
    tab.sessionId = sessionId;
    renderTabBar();
    persist();
    setTimeout(() => autoName(tab), 4000); // claude writes its title a few seconds after the first message
  });

  // agent status lights, fed by injected claude hooks via main (status.cjs)
  vs.onTermStatus((termId, st) => {
    const tab = tabs.get(termId);
    if (!tab || tab.status === st) return;
    tab.status = st;
    if (st === 'done') {
      tab.doneAt = Date.now();
      syncClaudeName(tab);
      setTimeout(drainMoves, 1500); // the feed's background list lands with Stop
    }
    autoName(tab);
    if ((st === 'waiting' || st === 'done') && activeId !== termId) tab.unread = true;
    renderTabBar();
  });
  vs.onTermFocus((termId) => { if (tabs.has(termId)) activateTab(termId); });

  accountsReady = vs.accountsList().then(setAccounts).catch((e) => console.warn('accounts: list failed', e && e.message));
  vs.onAccountsChanged(setAccounts);
  // main: this tab's turn failed on a usage limit and another account is free
  vs.onAccountSwitch(({ termId, to, toLabel, reason }) => {
    const tab = tabs.get(termId);
    if (!tab) { console.warn(`account switch: unknown term ${termId}`); return; }
    toast(`${tab.name}: ${reason || 'usage limit'}, continuing on ${toLabel || to}`);
    relaunchOnAccount(tab, to);
  });

  // tabs wrap onto extra rows when they don't fit: the bar's height changes and
  // the terminal below shrinks or grows, so refit once (throttled) per change
  let barHeight = 0;
  new ResizeObserver(([entry]) => {
    const h = Math.round(entry.contentRect.height);
    if (h === barHeight) return;
    barHeight = h;
    scheduleRefit();
  }).observe($('#tabbar'));

  // claude data feed → context meter, light detail, task pill (all repainted IN
  // PLACE; a full renderTabBar per tick would churn the bar and kill a rename in
  // progress) + activity strip / peek card (ui/feedui.js). The snapshot covers a
  // reload: everything shows before the next tick arrives.
  feedui.init({ getTab: (id) => tabs.get(id), getFeed: (id) => feeds.get(id), activeId: () => activeId });
  board.init({ wsId }); // ▦ agent board (Ctrl+Shift+B) — reads tabs + feeds via the exports below
  vs.onTermFeed((termId, feed) => {
    if (!termId) return;
    feeds.set(termId, feed);
    const tab = tabs.get(termId);
    if (tab) paintMeter(tab);
    feedui.onFeed(termId);
    notifyAgents();
  });
  vs.feedSnapshot(wsId).then((snap) => {
    for (const [termId, feed] of Object.entries((snap && snap.terms) || {})) {
      if (feeds.has(termId)) continue; // a live tick already beat the snapshot
      feeds.set(termId, feed);
      const tab = tabs.get(termId);
      if (tab) paintMeter(tab);
    }
    feedui.refresh();
  }).catch(() => {});
  // the pill hides a minute after an all-done turn ends — no feed tick says so
  setInterval(() => { for (const tab of tabs.values()) paintMeter(tab); }, 30000);


  $('#btn-new-claude').onclick = () => createTab({ name: nextName('agent'), cwd: repoPath, claude: true });
  // ONE "new" menu: the ▾ caret and right-click on + Claude open the same one
  // (new agent / worktree agent / terminal, then Resume: parked agents, Claude's
  // own picker, kept worktrees)
  $('#btn-new-claude').oncontextmenu = (ev) => {
    ev.preventDefault();
    openClaudeMenu();
  };
  $('#btn-new-claude-menu').onclick = () => openClaudeMenu();


  // ---- Ctrl+F: find inside the active terminal ----
  $('#term-find-next').onclick = () => termFind(false);
  $('#term-find-prev').onclick = () => termFind(true);
  $('#term-find-close').onclick = closeTermFind;
  $('#term-find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); termFind(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeTermFind(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      // Monaco has its own find — only handle when focus is NOT in the editor
      const ae = document.activeElement;
      if (ae && $('#monaco-host')?.contains(ae)) return;
      e.preventDefault();
      openTermFind();
    }
  }, true);

  // restore saved terminals (or start one fresh agent on first run).
  // A renderer reload leaves every pty alive in the main process — attach to them
  // (replaying their buffered output) instead of killing and re-spawning agents.
  // Parked agents are NOT restored as tabs: they stay on the shelf (🅿).
  const saved = parked.restorable(opts.savedTerminals, shelf);
  for (const t of saved) if (t.termId && t.named) restoredNamed.set(t.termId, t.named);
  const firstRun = saved.length === 0 && shelf.length === 0; // everything parked = no fresh agent
  vs.ptyList().then(async live => {
    await accountsReady; // restored tabs check their saved account against the list
    const liveByTerm = new Map(live.map(p => [p.termId, p]));
    if (firstRun) createTab({ name: 'agent-1', cwd: repoPath, claude: true });
    let attached = 0;
    const deadSessions = [];
    for (const t of saved) {
      const isClaude = t.isClaude === undefined ? true : Boolean(t.isClaude); // legacy states predate the flag
      const p = liveByTerm.get(t.termId);
      if (p) {
        attached++;
        createTab({
          termId: t.termId,
          name: t.name,
          cwd: t.cwd || repoPath,
          attachBuffer: p.buffer,
          savedIsClaude: isClaude,
          savedSessionId: t.claudeSessionId || null,
          account: t.account || null,
          accountAt: t.accountAt || 0,
          worktree: t.worktree || null,
        });
      } else if (t.worktree && !(await worktreeAlive(t.worktree))) {
        // the worktree folder is gone: a plain terminal at the repo root, never
        // an auto-resume into the wrong folder
        createTab({ termId: t.termId || null, name: t.name, cwd: repoPath });
        toast(`worktree ${t.worktree.name} no longer exists: the conversation can still be resumed from + ▾ → All conversations…`, 'err');
      } else if (opts.autoResume && isClaude && t.claudeSessionId && !(await vs.sessionCheck(wsId, t.claudeSessionId, t.cwd || repoPath))) {
        // saved session file is gone — open claude's interactive picker instead of
        // typing a resume id that would silently error out
        deadSessions.push(t.name);
        createTab({ termId: t.termId || null, name: t.name, cwd: t.cwd || repoPath, pickSession: true, account: t.account || null, accountAt: t.accountAt || 0, worktree: t.worktree || null });
      } else {
        createTab({
          termId: t.termId || null, // keep stable ids across restarts (sessions pin by termId)
          name: t.name,
          cwd: t.cwd || repoPath,
          claude: opts.autoResume && isClaude && !t.claudeSessionId,
          resumeId: opts.autoResume ? (t.claudeSessionId || null) : null,
          account: t.account || null,
          accountAt: t.accountAt || 0,
          worktree: t.worktree || null,
        });
      }
    }
    if (deadSessions.length) toast(`${deadSessions.join(', ')}: saved session gone — resume picker opened in tab`, 'err');
    // safety net: a live pty with no saved tab (state lost mid-reload) still gets a tab
    for (const p of live) {
      if (!tabs.has(p.termId)) {
        attached++;
        createTab({ termId: p.termId, name: 'recovered', cwd: p.cwd || repoPath, attachBuffer: p.buffer, savedIsClaude: true, savedSessionId: null });
      }
    }
    if (!opts.quiet) {
      if (attached) toast(`Re-attached ${attached} live terminal${attached > 1 ? 's' : ''} — agents never stopped`, 'ok');
      else if (saved.length && opts.autoResume) toast(`Restored ${saved.length} agent terminal${saved.length > 1 ? 's' : ''} — conversations resumed`, 'ok');
      else if (saved.length) toast(`Restored ${saved.length} terminals (auto-resume off)`, '');
    }
  }).catch(() => {
    // pty:list failed — fall back to the classic spawn/resume path
    if (firstRun) { createTab({ name: 'agent-1', cwd: repoPath, claude: true }); return; }
    for (const t of saved) {
      const isClaude = t.isClaude === undefined ? true : Boolean(t.isClaude);
      createTab({
        termId: t.termId || null,
        name: t.name,
        cwd: t.cwd || repoPath,
        claude: opts.autoResume && isClaude && !t.claudeSessionId,
        resumeId: opts.autoResume ? (t.claudeSessionId || null) : null,
        account: t.account || null,
        accountAt: t.accountAt || 0,
        worktree: t.worktree || null,
      });
    }
  });
}

// ---- worktree tabs (main/worktrees.cjs) --------------------------------------
// An agent in its own git worktree (<repo>\.claude\worktrees\<name>, branch
// vs/<name>): parallel agents never touch each other's files. VibeSpace owns the
// worktree; git writes beyond add/remove (commit, merge) stay with the agents.
const normPath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const samePath = (a, b) => normPath(a) === normPath(b);
const wtInfo = (w) => ({ name: w.name, path: w.path, branch: w.branch, base: w.base });

let wtCache = null; // one wt:list per restore pass
async function worktreeAlive(wt) {
  if (!wtCache) wtCache = vs.wtList(wsId).catch(() => null);
  const list = await wtCache;
  return Array.isArray(list) && list.some(w => w.exists && samePath(w.path, wt.path));
}

export function repoRoot() { return repoPath; }

export async function newWorktreeAgent() {
  const name = nextName('agent');
  let wt;
  try { wt = await vs.wtCreate(wsId, name); } catch (e) { wt = { ok: false, reason: (e && e.message) || String(e) }; }
  if (!wt || !wt.ok) { toast(`Worktree failed: ${(wt && wt.reason) || 'unknown error'}`, 'err'); return null; }
  const tab = createTab({ name, cwd: wt.path, claude: true, worktree: wtInfo(wt) });
  const from = feedui.wtText(wt).replace(/^⎇ \S+ · from /, '');
  toast(`Worktree ready: ${wt.branch} (from ${from}). Not shared: node_modules, .env, build output; the agent may need to install.`, 'ok');
  return tab;
}

// the parked agent that owns a worktree (its folder is kept for the unpark)
const parkedOwner = (wtPath) => (shelf || []).find(e => e.worktree && samePath(e.worktree.path, wtPath)) || null;

// our worktrees that no open tab is using: closed with work left in them, or
// held by a parked agent (listed as such, never as an orphan)
async function keptWorktrees() {
  let list = null;
  try { list = await vs.wtList(wsId); } catch {}
  if (!Array.isArray(list)) return [];
  const used = [...tabs.values()].map(t => (t.worktree && t.worktree.path) || t.cwd);
  return list.filter(w => w.exists && !used.some(u => samePath(u, w.path)))
    .map(w => ({ ...w, parkedBy: parkedOwner(w.path) }));
}

// claude's own resume picker in a new tab; the picked session gets pinned
const resumePicker = () => createTab({ name: nextName('agent'), cwd: repoPath, pickSession: true });

async function openClaudeMenu() {
  const r = $('#btn-new-claude').closest('.btn-group').getBoundingClientRect();
  const kept = await keptWorktrees();
  const list = shelf || [];
  const items = [
    { label: 'New agent', run: () => createTab({ name: nextName('agent'), cwd: repoPath, claude: true }) },
    { label: 'New agent in a worktree', hint: "Its own git worktree and branch vs/<name>: parallel agents never touch each other's files", run: () => newWorktreeAgent() },
    { label: 'New terminal', hint: 'A plain PowerShell terminal', run: () => createTab({ name: nextName('term'), cwd: repoPath }) },
    { sep: true },
    { section: 'Resume' },
    ...parked.menuItems(list, { max: parked.MENU_MAX, more: () => parked.openList(r) }),
    { label: 'All conversations…', hint: "Claude's own resume picker in a new tab; the pick is saved to that tab", run: resumePicker },
  ];
  if (kept.length) items.push({ label: `Kept worktrees (${kept.length}) ▸`, hint: 'Worktrees kept after their tab closed, or held by a parked agent', run: () => worktreesMenu(r, kept) });
  showMenu(r.left, r.bottom + 4, items);
}

function worktreesMenu(r, kept) {
  showMenu(r.left, r.bottom + 4, kept.map(w => (w.parkedBy ? {
    label: `⎇ ${w.name} — 🅿 parked as ${w.parkedBy.name}`,
    hint: `${feedui.wtText(w)}\nKept for the parked agent: click to unpark it`,
    run: () => unparkAgent(w.parkedBy.id),
  } : {
    label: `⎇ ${w.name} — ${w.loss || 'clean'}`,
    hint: feedui.wtText(w),
    run: () => worktreeActions(r, w),
  })));
}

function worktreeActions(r, w) {
  showMenu(r.left, r.bottom + 4, [
    { label: 'Open agent here', hint: "New tab in this worktree with Claude's resume picker", run: () => createTab({ name: nextName('agent'), cwd: w.path, pickSession: true, worktree: wtInfo(w) }) },
    w.loss
      ? { label: `Remove — kept: ${w.loss}`, disabled: true, hint: 'Merge or commit first, or use Remove and discard' }
      : { label: 'Remove', hint: `Removes the worktree and branch ${w.branch} (nothing unmerged)`, run: () => removeWorktree(w, false) },
    { label: 'Remove and discard…', danger: true, run: () => discardWorktree(w) },
  ]);
}

async function removeWorktree(w, discard) {
  let res;
  try { res = await vs.wtRemove(wsId, w.name, { discard }); } catch (e) { res = { ok: false, reason: (e && e.message) || String(e) }; }
  if (res && res.ok) toast(`worktree ${w.name} removed` + (discard ? '' : ' (nothing unmerged)') + (res.branchKept ? `, branch ${w.branch} kept` : ''), 'ok');
  else toast(`worktree ${w.name} kept: ${(res && res.reason) || 'remove failed'}`, res && res.kept ? '' : 'err');
  return res;
}

async function discardWorktree(w) {
  const lost = [];
  // null = main couldn't check: say so, never imply "nothing is lost"
  if (w.ahead === null) lost.push(`· possibly commits on ${w.branch}: couldn't compare it with its base`);
  else if (w.ahead > 0 && !w.merged) lost.push(`· ${w.ahead} commit${w.ahead === 1 ? '' : 's'} on ${w.branch} not merged into ${w.base}`);
  if (w.dirty === null) lost.push(`· possibly uncommitted files in ${w.path}: couldn't read its status`);
  else if (w.dirty > 0) lost.push(`· ${w.dirty} uncommitted file${w.dirty === 1 ? '' : 's'} in ${w.path}`);
  const msg = `Remove worktree ${w.name} and delete branch ${w.branch}?\n`
    + (lost.length ? `This permanently loses:\n${lost.join('\n')}` : 'Nothing unmerged or uncommitted is lost.');
  if (!(await confirmBox(msg, { ok: 'Remove and discard', danger: true }))) return;
  removeWorktree(w, true);
}

// after a worktree tab closed: clean + nothing unmerged → removed silently;
// otherwise kept, with the reason. Skipped while another tab still uses it.
function afterWorktreeTabClosed(wt) {
  if (!wt || [...tabs.values()].some(t => samePath((t.worktree && t.worktree.path) || t.cwd, wt.path))) return;
  if (parkedOwner(wt.path)) return; // a parked agent resumes in it later
  removeWorktree(wt, false);
}

// ---- parked agents (ui/parked.js) ---------------------------------------------
// Park = stop the agent, keep its conversation on the shelf; unpark resumes that
// exact conversation (claude --resume <id>) in a new tab. The entry is on disk
// BEFORE the pty dies, and a parked agent is never auto-resumed on restore.
export function parkedList() { return shelf || []; }

// null before init loaded the shelf: app.js then keeps the saved list as is
export function parkedSnapshot() { return shelf ? shelf.map(e => ({ ...e })) : null; }

// a conversation on disk: an id AND its transcript (claude writes it on the first message)
export async function isParkable(tab) {
  if (!tab || !tab.isClaude || tab.dead || !tab.sessionId) return false;
  return Boolean(await vs.sessionCheck(wsId, tab.sessionId, tab.cwd || repoPath).catch(() => false));
}

const parking = new Set(); // termIds mid-park
const unparking = new Set(); // shelf ids mid-unpark

export async function parkTab(tab) {
  if (!tab || !tabs.has(tab.id) || parking.has(tab.id)) return false;
  if (!(await isParkable(tab))) { toast(`${tab.name}: nothing saved yet: send a message first`, 'err'); return false; }
  // stopping a busy agent interrupts it: the one case worth a question
  if (tab.status === 'working' || tab.status === 'waiting') {
    const what = tab.status === 'working' ? 'is working' : 'is waiting for your answer';
    if (!(await confirmBox(`${tab.name} ${what}. Parking stops it mid-task; the conversation is kept up to this point.`, { ok: 'Park' }))) return false;
    if (!tabs.has(tab.id)) return false;
  }
  parking.add(tab.id);
  try {
    const f = feeds.get(tab.id);
    let lastMessage = (f && f.lastMessage) || null;
    let model = (f && f.model && f.model.name) || null;
    if (!lastMessage || !model) { // no feed (or no finished turn yet): the transcript's tail
      const r = await vs.sessionLastReply(wsId, tab.sessionId, tab.cwd || repoPath).catch(() => null);
      if (r) { lastMessage = lastMessage || r.text || null; model = model || r.model || null; }
    }
    const entry = parked.makeEntry(tab, { lastMessage, model });
    const before = shelf;
    shelf = parked.normalizeParked([entry, ...shelf.filter(e => e.claudeSessionId !== entry.claudeSessionId)]);
    // 1. on disk first: a crash after this point still has the entry
    try {
      await persistNow();
    } catch (e) {
      shelf = before;
      toast(`${tab.name} not parked: saving failed (${(e && e.message) || e})`, 'err');
      return false;
    }
    // 2. stop it the way tab-close does, minus the worktree auto-remove: a
    // parked worktree agent keeps its worktree
    if (tabs.has(tab.id)) removeTab(tab.id);
    else { parked.paintChip(); notifyAgents(); persist(); }
    toast(`${tab.name} parked: 🅿 menu or chip to bring it back`, 'ok');
    return true;
  } finally {
    parking.delete(tab.id);
  }
}

export async function unparkAgent(id) {
  const e = (shelf || []).find(x => x.id === id);
  if (!e || unparking.has(id)) return null;
  unparking.add(id);
  try {
    const name = parked.uniqueName(e.name, new Set([...tabs.values()].map(t => t.name)));
    const cwd = e.cwd || repoPath;
    let tab;
    wtCache = null; // the restore's cached list is stale by now
    if (e.worktree && !(await worktreeAlive(e.worktree))) {
      // same fallback as restore: never resume into the wrong folder
      tab = createTab({ name, cwd: repoPath });
      toast(`worktree ${e.worktree.name} no longer exists: the conversation can still be resumed from + ▾ → All conversations…`, 'err');
    } else if (!(await vs.sessionCheck(wsId, e.claudeSessionId, cwd).catch(() => false))) {
      // transcript gone: claude's picker instead of a resume id that would error out
      tab = createTab({ name, cwd, pickSession: true, account: e.account || null, accountAt: e.accountAt || 0, worktree: e.worktree || null });
      toast(`${name}: saved session gone — resume picker opened in tab`, 'err');
    } else {
      tab = createTab({ name, cwd, resumeId: e.claudeSessionId, account: e.account || null, accountAt: e.accountAt || 0, worktree: e.worktree || null, activate: true });
    }
    shelf = shelf.filter(x => x.id !== id);
    parked.paintChip();
    notifyAgents();
    persist();
    return tab;
  } finally {
    unparking.delete(id);
  }
}

// forget = off the shelf only; the conversation stays in claude's own history.
// No confirm: nothing is lost.
export function forgetParked(id) {
  const e = (shelf || []).find(x => x.id === id);
  if (!e) return;
  shelf = shelf.filter(x => x.id !== id);
  parked.paintChip();
  notifyAgents();
  persist();
  toast(`forgot ${e.name} — still in All conversations`, 'ok');
}

function openTermFind() {
  $('#term-find').classList.remove('hidden');
  const input = $('#term-find-input');
  input.focus();
  input.select();
}

function closeTermFind() {
  $('#term-find').classList.add('hidden');
  $('#term-find-input').value = '';
  const tab = tabs.get(activeId);
  if (tab?.search) { try { tab.search.clearDecorations(); } catch {} }
  if (tab) tab.term.focus();
}

function termFind(backwards) {
  const tab = tabs.get(activeId);
  const q = $('#term-find-input').value;
  if (!tab || !tab.search || !q) return;
  try {
    tab.search.findNext(q, {
      backwards: Boolean(backwards),
      caseSensitive: false,
      decorations: { matchOverviewRuler: '#6e9cff', activeMatchColorOverviewRuler: '#f0f6fc' },
    });
  } catch {}
}

function nextName(prefix) {
  let i = 1;
  const names = new Set([...tabs.values()].map(t => t.name));
  while (names.has(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}

function newTermId() {
  return 't' + (++counter) + '_' + Math.random().toString(36).slice(2, 6);
}

// ---- clipboard: Windows-Terminal-style copy/paste ----
async function copySelection(term) {
  const text = term.getSelection();
  if (text) await vs.writeClipboard(text);
}

async function pasteInto(term) {
  const text = await vs.readClipboard();
  if (text) term.paste(text);
}

function wireClipboard(term, id) {
  // Ctrl+C copies when something is selected, interrupts otherwise (pass through).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // Shift(+Ctrl)+arrows select text in claude's prompt (ui/inputsel.js)
    if (inputsel.onKey(term, ev, (d) => vs.ptyWrite(id, d))) { ev.preventDefault(); return false; }
    const key = ev.key.toLowerCase();
    if (key === 'insert') {
      if (ev.ctrlKey && term.hasSelection()) { ev.preventDefault(); copySelection(term); return false; }
      if (ev.shiftKey) { ev.preventDefault(); pasteInto(term); return false; }
      return true;
    }
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!ctrl) return true;
    if (key === 'c') {
      if (term.hasSelection()) { ev.preventDefault(); copySelection(term); return false; }
      // Ctrl+Shift+C is copy-only (Windows Terminal convention) — never an interrupt
      if (ev.shiftKey) { ev.preventDefault(); return false; }
      return true; // plain Ctrl+C, no selection: interrupt for the shell/claude
    }
    if (key === 'v') { // Ctrl+V and Ctrl+Shift+V both paste
      ev.preventDefault();
      pasteInto(term);
      return false;
    }
    return true;
  });

  // right-click: copy selection, or paste when nothing is selected.
  // When the program in the terminal has mouse tracking on (Claude Code does, once
  // past its trust screen), xterm forwards the right-click to it and IT pastes from
  // the clipboard — pasting here too doubled every right-click paste. So: leave
  // right-click to the app when it tracks the mouse.
  term.element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      copySelection(term);
      term.clearSelection();
      return;
    }
    const mouseMode = term.modes?.mouseTrackingMode || 'none';
    if (mouseMode !== 'none') return; // the app handles its own right-click paste
    pasteInto(term);
  });
}

// ---- drag-and-drop: Windows-Terminal-style path paste ----
// Dropping files from Explorer pastes their full paths (quoted when they contain
// spaces). Going through term.paste() keeps bracketed paste, so Claude Code sees
// a pasted image path and attaches the image itself.
const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);

function wireDrop(term, host) {
  host.addEventListener('dragover', (ev) => {
    const types = ev.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('text/plain')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  host.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const paths = [...ev.dataTransfer.files].map(f => vs.dropPath(f)).filter(Boolean);
    const text = paths.length ? paths.map(quotePath).join(' ') : ev.dataTransfer.getData('text/plain');
    if (!text) return;
    term.paste(text);
    term.focus();
  });
}

// ---- file:line links ---------------------------------------------------------
// Clicking D:\repo\src\app.js:42 (or src/app.js:42) in claude's output opens the
// file in the preview at that line. Uses xterm's core registerLinkProvider —
// no vendored addon. The lookbehinds keep URLs (https://host/x:1) and paths
// already matched as absolute from producing duplicate/false hits; the \d+
// anchor means a drive colon can never read as a line number.
const ABS_PATH_LINE = /(?<![\w./])([A-Za-z]:(?:[\\/][^\s:"'<>|]+)+):(\d+)(?::(\d+))?/g;
const REL_PATH_LINE = /(?<![\w.\\/:])([\w][\w.\-]*(?:[\\/][^\s:"'<>|]+)+):(\d+)(?::(\d+))?/g;
// quoted paths may contain spaces — claude quotes those; requires a separator
// so arbitrary quoted "text: 5" doesn't light up
const QUOTED_PATH_LINE = /"((?:[A-Za-z]:)?[^"]*?[\\/][^"]*?):(\d+)"/g;

const baseName = (p) => p.split(/[\\/]/).pop();

async function openPathAt(tab, rawPath, line) {
  const p = rawPath.replace(/^["']+|["']+$/g, ''); // claude quotes paths with spaces
  const isAbs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (isAbs) { if (openFile) openFile(p, baseName(p), line); return; }
  // relative: try the terminal's spawn cwd first, then the workspace root
  for (const base of [tab.cwd, repoPath]) {
    if (!base) continue;
    const cand = base.replace(/[\\/]+$/, '') + '/' + p;
    try { await vs.fsRead(cand); } catch { continue; } // existence check
    if (openFile) openFile(cand, baseName(p), line);
    return;
  }
  toast('Not found: ' + p, 'err');
}

function registerFileLinks(term, tab) {
  try {
    term.registerLinkProvider({
      provideLinks(lineNo, cb) {
        try {
          const row = term.buffer.active.getLine(lineNo);
          const text = row ? row.translateToString(true) : '';
          if (!text) return cb(undefined);
          const hits = [];
          const inHit = (i) => hits.some(h => i >= h.start && i < h.start + h.len);
          const add = (m) => hits.push({ start: m.index, len: m[0].length, path: m[1], line: +m[2] });
          for (const m of text.matchAll(QUOTED_PATH_LINE)) add(m); // quoted (spaces) first…
          for (const m of text.matchAll(ABS_PATH_LINE)) if (!inHit(m.index)) add(m); // …then unquoted
          for (const m of text.matchAll(REL_PATH_LINE)) if (!inHit(m.index)) add(m);
          if (!hits.length) return cb(undefined);
          cb(hits.map(h => ({
            range: { start: { x: h.start + 1, y: lineNo }, end: { x: Math.min(h.start + h.len, term.cols), y: lineNo } },
            text: text.slice(h.start, h.start + h.len),
            activate: () => openPathAt(tab, h.path, h.line),
          })));
        } catch { cb(undefined); }
      },
    });
  } catch {} // xterm without link-provider support — links simply don't light up
}

export function createTab({ name = 'agent', cwd = repoPath, claude = false, resumeId = null, activate = true, termId = null, attachBuffer = null, savedIsClaude = null, savedSessionId = null, pickSession = false, run = null, account = null, accountAt = 0, worktree = null } = {}) {
  const id = termId || newTermId();
  const host = el('div', 'term-host');
  host.style.display = 'none';
  $('#term-hosts').appendChild(host);

  const term = new window.Terminal({ ...TERM_OPTS, theme: termTheme() });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  // Unicode 11 widths: xterm's default (v6) counts emoji like 😀 ✅ as 1 cell,
  // ConPTY and Claude's Ink count 2, so every emoji shifted the rest of its row
  // and redraws left mixed-up characters behind.
  const Uni11 = window.Unicode11Addon?.Unicode11Addon;
  if (Uni11) {
    try { term.loadAddon(new Uni11()); term.unicode.activeVersion = '11'; } catch {}
  }
  term.open(host);

  // Ctrl+F search addon (per terminal); the find bar drives the ACTIVE tab
  let search = null;
  const SearchCtor = window.SearchAddon?.SearchAddon;
  if (SearchCtor) {
    try {
      search = new SearchCtor();
      term.loadAddon(search);
    } catch {}
  }

  const tab = {
    id, name, cwd,
    sessionId: savedSessionId || resumeId || null,
    term, fit, host, dead: false, search,
    worktree: worktree && worktree.path ? worktree : null, // { name, path, branch, base }
    named: restoredNamed.get(id) || null, // 'user' | 'auto' | null (still on its default name)
    isClaude: savedIsClaude !== null ? Boolean(savedIsClaude) : Boolean(claude || resumeId || pickSession),
  };
  if (tab.isClaude) {
    // a live (re-attached) agent keeps whatever account it is running on;
    // main relearns it so the feed files its limits under the right account
    tab.account = attachBuffer !== null ? (account || 'login') : resolveAccount(account, accountAt);
    // when this tab's account was chosen: a newer "move all" outranks it
    tab.accountAt = attachBuffer !== null || tab.account === account ? (accountAt || 0) : Date.now();
    // draft = something typed since the last Enter may sit in the prompt. A
    // re-attached agent's prompt can't be seen: assume it has one.
    tab.draft = attachBuffer !== null;
    if (attachBuffer !== null) {
      vs.setTermAccount(id, tab.account)
        .then((used) => { if (typeof used === 'string' && used !== tab.account) { tab.account = used; renderTabBar(); } })
        .catch((e) => console.warn(`account: set failed for ${id}`, e && e.message));
    }
  }
  tabs.set(id, tab);
  registerFileLinks(term, tab);
  renderTabBar();
  if (activate || tabs.size === 1) activateTab(id);

  if (attachBuffer !== null) {
    // Layer 2: attach to a pty that survived a reload — never spawn, never type a
    // resume command; the agent process kept running the whole time.
    if (attachBuffer) term.write(attachBuffer);
    vs.ptyResize(id, Math.max(term.cols, 20), Math.max(term.rows, 10));
  } else {
    // rcLabel feeds the shell's `claude` wrapper (ptyhost), so a claude typed by
    // hand gets the same Remote Control name as one we launch
    vs.ptyCreate({ termId: id, wsId, cwd, cols: Math.max(term.cols, 20), rows: Math.max(term.rows, 10), rcLabel: remote() ? rcLabel(name) : null })
      .then(info => { tab.hookSettings = info && info.settingsPath; })
      .catch(e => toast('Terminal failed: ' + (e.message || e), 'err'));
  }

  term.onData(d => {
    // typed input marks "user may have a half-typed prompt" for syncClaudeName
    // (our own pastes — /exit, /rename, a board reply — are not the user typing)
    if (!appWriting && !/^\x1b\[(M|<|I$|O$)/.test(d)) { // not mouse/focus reports
      tab.lastInputAt = Date.now();
      tab.draft = !d.endsWith('\r'); // Enter submits and empties the prompt
    }
    if (tab.lagT0 == null && isTypedKey(d)) tab.lagT0 = performance.now(); // typing-lag log
    vs.ptyWrite(id, d);
  });
  wireClipboard(term, id);
  if (tab.sessionId) setTimeout(() => autoName(tab), 6000); // a resumed conversation already has its title
  wireDrop(term, host);
  term.onResize(({ cols, rows }) => vs.ptyResize(id, cols, rows));
  host.addEventListener('mousedown', () => { inputsel.reset(term); activateTab(id); }, true);

  if (attachBuffer === null && (claude || resumeId || pickSession)) {
    setTimeout(async () => {
      if (!tabs.has(id)) return;
      // the shell's claude wrapper reads the account file at launch: write it first
      if (tab.account) {
        try {
          const used = await vs.setTermAccount(id, tab.account);
          if (typeof used === 'string') tab.account = used; // removed account → login
        } catch (e) { console.warn(`account: set failed for ${id}`, e && e.message); }
        if (!tabs.has(id)) return;
      }
      const cmd = claudeCommand(tab, pickSession ? '' : resumeId); // '' = picker: saved id is dead
      vs.ptyWrite(id, cmd + '\r');
      tab.launchedAt = Date.now();
      vs.claudeStarted(wsId, id, launchOpts(tab, pickSession));
      if (resumeId) vs.sessionPinned(wsId, id, resumeId);
    }, 900);
  } else if (attachBuffer === null && run) {
    // a one-off command typed into a plain tab (board → background agent attach)
    setTimeout(() => { if (tabs.has(id)) vs.ptyWrite(id, run + '\r'); }, 900);
  }
  persist();
  return tab;
}

// session tracking: offRepo = the cwd isn't the repo root (worktree tab), so
// main's timing heuristic leaves the tab to the feed
function launchOpts(tab, picker) {
  return { picker: Boolean(picker), offRepo: !samePath(tab.cwd, repoPath) };
}

// The ONE builder for a new interactive claude:
//   claude [--resume [<id>]] [--remote-control "<label>"] [--settings "<path>"] ["<prompt>"]
// resumeId: null = fresh, '' = the interactive picker, else that session.
// --remote-control lists the session in the Claude phone app; --settings
// injects the status hooks and merges with the user's own settings. Token
// accounts get no --remote-control (Remote Control refuses setup-tokens).
// prompt: only ever the literal `continue` (account switch after a limit).
function claudeCommand(tab, resumeId = null, prompt = null) {
  let cmd = resumeId == null ? 'claude' : `claude --resume${resumeId ? ' ' + resumeId : ''}`;
  if (remote() && !(tab.account && tab.account !== 'login')) {
    const label = rcLabel(tab.name);
    if (label) cmd += ` --remote-control "${label}"`;
  }
  if (tab.hookSettings) cmd += ` --settings "${tab.hookSettings}"`;
  if (prompt) cmd += ` "${prompt}"`;
  return cmd;
}

// Move a running agent to another account IN THE SAME PTY: /exit claude, wait
// for the PowerShell prompt (main kills claude after the timeout), then resume
// the same conversation on the new account. prompt 'continue' restarts a turn
// that failed on a usage limit; null just resumes and waits.
export async function relaunchOnAccount(tab, to, { prompt = 'continue', gentle = false } = {}) {
  if (!tab || tab.dead || !to) return;
  const id = tab.id;
  if (!tab.sessionId) { console.warn(`account switch: ${id} has no session id — not relaunching`); return; }
  if (tab.switching) { console.warn(`account switch: ${id} already switching`); return; }
  const from = tab.account || 'login';
  const askedAt = Date.now(); // a "move all" issued while this runs must still apply
  tab.switching = true;
  renderTabBar();
  try {
    // a running turn or an open dialog would swallow the typed /exit: Esc first
    if (tab.status === 'working' || tab.status === 'waiting') {
      vs.ptyWrite(id, '\x1b');
      await new Promise(r => setTimeout(r, 500));
    }
    sendToAgent(id, '/exit');
    // gentle ("move all agents"): a claude that doesn't leave is never killed
    const exit = await vs.waitClaudeExit(id, 15000, gentle);
    const how = exit && exit.how;
    console.warn(`account switch: ${id} ${from} -> ${to}, claude exit: ${how}`);
    if (!tabs.has(id) || tab.dead) return;
    // only type into a shell we KNOW claude left; otherwise the command would
    // become a prompt inside the still-running agent
    if (!['prompt', 'gone', 'killed'].includes(how)) {
      toast(`Couldn't move ${tab.name} to another account: claude didn't exit`, 'err');
      return;
    }
    // switch the account only now: until the old claude exited, its statusLine
    // ticks still belong to the old account
    const used = await vs.setTermAccount(id, to);
    tab.account = typeof used === 'string' ? used : to;
    tab.accountAt = askedAt;
    tab.moveFails = 0;
    tab.draft = false; // a new claude starts with an empty prompt
    tab.launchedAt = Date.now();
    // same bookkeeping as createTab's known-resume launch: tracking stays pinned
    vs.ptyWrite(id, claudeCommand(tab, tab.sessionId, prompt) + '\r');
    vs.claudeStarted(wsId, id, launchOpts(tab, false));
    vs.sessionPinned(wsId, id, tab.sessionId);
  } catch (e) {
    console.warn(`account switch: ${id} failed`, e && e.message);
  } finally {
    tab.switching = false;
    renderTabBar();
    persist();
  }
}

// Preferences → "Open a setup-token tab": a plain tab running the token flow
export function openSetupTokenTab() {
  return createTab({ name: nextName('setup-token'), cwd: repoPath, run: 'claude setup-token' });
}

// "<workspace> · <tab>", safe inside a PowerShell double-quoted string: no
// quotes, $, backticks or other specials survive
function rcLabel(tabName) {
  return `${wsName} · ${tabName}`
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ._\-·()]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  for (const t of tabs.values()) t.host.style.display = 'none';
  activeId = id;
  tab.unread = false; // looking at it answers the attention signal
  tab.host.style.display = 'block';
  try { tab.fit.fit(); } catch {}
  tab.term.focus();
  renderTabBar();
  persist(); // main needs the active tab to decide whether a finish deserves a toast
}

// Ctrl+Shift+U: cycle to the next tab that needs you (waiting first, then finished)
export function jumpToAttention() {
  const order = [...tabs.keys()];
  if (!order.length) return false;
  const start = order.indexOf(activeId);
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length];
    const t = tabs.get(id);
    if (t && (t.status === 'waiting' || t.status === 'done')) { activateTab(id); return true; }
  }
  return false;
}

export function refitActive() {
  if (resizeDepth > 0) return; // mid-drag: scheduleRefit handles it, throttled
  const tab = tabs.get(activeId);
  if (tab) { try { tab.fit.fit(); } catch {} }
}

// Dragging resizes the pane on every pointer move; refitting xterm (and the pty)
// on each pixel thrashes ConPTY — so during drags we refit at most every 120ms.
let resizeDepth = 0;
let refitTimer = null;

export function beginResize() {
  resizeDepth++;
}

export function endResize() {
  resizeDepth = Math.max(0, resizeDepth - 1);
  if (resizeDepth === 0) refitActive();
}

export function scheduleRefit() {
  if (refitTimer) return;
  refitTimer = setTimeout(() => {
    refitTimer = null;
    if (resizeDepth > 0) {
      const tab = tabs.get(activeId);
      if (tab) { try { tab.fit.fit(); } catch {} }
    } else {
      refitActive();
    }
  }, 120);
}

function removeTab(termId, kill = true) {
  const tab = tabs.get(termId);
  if (!tab) return;
  if (kill) vs.ptyKill(termId);
  tab.term.dispose();
  tab.host.remove();
  tabs.delete(termId);
  feeds.delete(termId);
  if (activeId === termId) {
    const next = [...tabs.keys()][0];
    if (next) activateTab(next);
  }
  renderTabBar();
  persist();
}

function renderTabBar() {
  // mid-rename: rebuilding the bar would destroy the input (status changes and
  // session captures redraw constantly while agents run) — skip until committed
  if ($('#tabs .rename')) return;
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const tab of tabs.values()) {
    const t = el('div', 'tab' + (tab.id === activeId ? ' active' : '') + (tab.dead ? ' dead' : '') + (tab.unread ? ' unread' : ''));
    t.dataset.termId = tab.id; // drag-to-reorder reads the order back from the bar
    const st = tab.status || '';
    const status = el('span', 'status' + (tab.sessionId ? ' on' : '') + (st ? ' ' + st : ''));
    status.title = st === 'working' ? 'agent is working'
      : st === 'waiting' ? 'agent is asking for you — permission or question'
      : st === 'done' ? 'task completed — agent is idle'
      : (tab.sessionId ? `session ${tab.sessionId.slice(0, 8)}…` : 'no claude session yet');
    const label = el('span', 'label', tab.name);
    label.title = (tab.sessionId ? `${tab.name} — ${tab.sessionId}` : tab.name) + '  (double-click to rename · right-click for options)'
      + (tab.worktree ? '\n' + feedui.wtText(tab.worktree) : '');
    const close = el('span', 'close', '✕');
    close.title = 'close terminal';
    const meter = el('span', 'ctx-meter hidden'); // context-window fill, bottom edge
    const pill = el('span', 'task-pill hidden'); // `3/7` tasks done (claude feed)
    tab.meterEl = meter;
    tab.labelEl = label;
    tab.labelTitle = label.title;
    tab.statusEl = status;
    tab.statusClass = status.className;
    tab.statusTitle = status.title;
    tab.pillEl = pill;

    t.append(status);
    if (tab.worktree) {
      const wt = el('span', 'wt-badge', '⎇');
      wt.title = feedui.wtText(tab.worktree);
      t.append(wt);
    }
    t.append(label);
    const acct = acctChip(tab);
    if (acct) t.append(acct);
    t.append(pill, close, meter);
    paintMeter(tab);
    t.onclick = () => activateTab(tab.id);
    // right-click = options menu (rename, agent info, copy id/name/resume, close)
    t.oncontextmenu = (ev) => {
      ev.preventDefault();
      openTabMenu(ev, tab, {
        rename: () => startRename(t, label, tab),
        close: () => close.onclick(new MouseEvent('click')),
        park: () => parkTab(tab),
        parkable: () => isParkable(tab),
      });
    };
    close.onclick = async (ev) => {
      ev.stopPropagation();
      const hasAgent = tab.sessionId || !tab.dead;
      if (hasAgent && !(await confirmBox(`Close "${tab.name}"?\nIts claude conversation is saved and can be resumed later.`, { ok: 'Close', danger: true }))) return;
      removeTab(tab.id);
      if (tab.worktree) afterWorktreeTabClosed(tab.worktree);
    };
    label.ondblclick = (ev) => {
      ev.stopPropagation();
      startRename(t, label, tab);
    };
    wireTabDrag(bar, t);

    bar.appendChild(t);
  }
  // 🅿 n chip right after the tabs (wraps with them); hidden when nothing is parked
  const chip = parked.chipEl();
  if (chip) { bar.appendChild(chip); parked.paintChip(); }
  feedui.refresh(); // the strip follows the active tab + its base status
  notifyAgents(); // board: status changes, renames, tabs added/removed
}

// account chip next to a claude tab's name — only once there is a choice
function acctChip(tab) {
  if (!tab.isClaude || !multiAccount()) return null;
  if (tab.switching) {
    const c = el('span', 'acct-pill switching', 'switching…');
    c.title = 'Moving this agent to another account…';
    return c;
  }
  const a = accountById(tab.account || 'login');
  const name = a ? a.label : (tab.account || 'login');
  const to = pendingMove(tab);
  if (to) {
    const target = accountById(to);
    const toName = target ? target.label : to;
    const p = el('span', 'acct-pill switching', '→ ' + (toName.length > 9 ? toName.slice(0, 8) + '…' : toName));
    p.title = `On ${name}. Moves to ${toName} after its next finished turn, while the prompt is empty. Right-click → Continue on ${toName} moves it now.`;
    return p;
  }
  const c = el('span', 'acct-pill', name.length > 10 ? name.slice(0, 9) + '…' : name);
  c.title = `Account: ${name}` + (a && a.kind === 'token' ? ' — no phone control' : '');
  return c;
}

// ---- context meter (claude data feed) ----------------------------------------
// Thin bar on the tab's bottom edge, width = context used %. Green < 60 %,
// amber < 85 %, red ≥ 85 %. No bar until the first model response (claude
// reports context % as null until then — "no data", never 0 %).
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

function feedSummary(f) {
  if (!f) return '';
  const parts = [];
  if (f.model && f.model.name) parts.push(f.model.name);
  const c = f.context;
  if (c && typeof c.pct === 'number') parts.push(`context ${Math.round(c.pct)}%` + (c.size ? ` (${fmtTokens(c.used || 0)}/${fmtTokens(c.size)})` : ''));
  if (typeof f.cost === 'number') parts.push('$' + f.cost.toFixed(2));
  if (f.linesAdded || f.linesRemoved) parts.push(`+${f.linesAdded || 0}/−${f.linesRemoved || 0}`);
  return parts.join(' · ');
}

// Also paints the feed's detail on the light (lock / ? / failed ✕ + reason
// tooltip) and the `3/7` task pill. Base classes come from renderTabBar; with no
// feed everything below is a no-op and the tab looks exactly as before.
function paintMeter(tab) {
  const m = tab.meterEl;
  if (!m) return;
  const f = feeds.get(tab.id);
  const c = f && f.context;
  if (c && typeof c.pct === 'number') {
    const pct = Math.max(0, Math.min(100, c.pct));
    m.className = 'ctx-meter ' + (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : 'ok');
    // measured against the whole tab (it is the positioned box), so the bar
    // spans the task pill too
    m.style.width = `calc((100% - 14px) * ${pct / 100})`;
  } else {
    m.className = 'ctx-meter hidden';
  }
  const line = feedSummary(f);
  m.title = line;
  if (tab.labelEl) tab.labelEl.title = tab.labelTitle + (line ? '\n' + line : '');
  if (tab.statusEl) {
    const d = feedui.lightDetail(f, tab.status);
    tab.statusEl.className = tab.statusClass + (d.cls ? ' ' + d.cls : '');
    tab.statusEl.title = d.title || tab.statusTitle;
  }
  if (tab.pillEl) {
    const p = feedui.pillText(f, tab.status);
    tab.pillEl.textContent = p;
    tab.pillEl.classList.toggle('hidden', !p);
    tab.pillEl.title = p ? `${p} tasks done` : '';
  }
}

// ---- drag to reorder tabs ----------------------------------------------------
// Follows the splitter drag rules: window-level capture listeners for the drag,
// absolute clientX, NO setPointerCapture (breaks under remote-control software).
// A 4 px threshold keeps plain clicks and the dblclick rename from ever
// triggering a drag. DOM order is committed into the tabs Map (insertion order
// = display order = persisted snapshot order) on release.
function wireTabDrag(bar, t) {
  t.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.close') || e.target.closest('.rename')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev) => {
      if (!dragging) {
        if (Math.max(Math.abs(ev.clientX - startX), Math.abs(ev.clientY - startY)) < 4) return;
        dragging = true;
        t.classList.add('dragging');
        document.body.classList.add('dragging'); // user-select: none while dragging
      }
      // the bar wraps into rows: drop before the first tab that sits in a row
      // below the pointer, or in the pointer's row past its midpoint
      for (const sib of bar.children) {
        if (sib === t || !sib.classList.contains('tab')) continue; // the 🅿 chip stays last
        const r = sib.getBoundingClientRect();
        if (ev.clientY < r.top || (ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2)) {
          bar.insertBefore(t, sib);
          return;
        }
      }
      bar.insertBefore(t, bar.querySelector(':scope > .parked-chip')); // pointer is past every tab
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      if (!dragging) return;
      t.classList.remove('dragging');
      document.body.classList.remove('dragging');
      const next = new Map();
      for (const el of bar.children) {
        const rec = tabs.get(el.dataset.termId);
        if (rec) next.set(el.dataset.termId, rec);
      }
      if (next.size !== tabs.size) return; // stale bar — next redraw fixes order
      tabs.clear();
      for (const [id, rec] of next) tabs.set(id, rec);
      persist();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  });
}

function startRename(tabEl, labelEl, tab) {
  if (tabEl.querySelector('.rename')) return; // already renaming this tab
  const input = el('input', 'rename');
  input.value = tab.name;
  // clicks inside the input must not bubble to the tab's onclick/oncontextmenu —
  // that runs activateTab → term.focus() and rips focus out mid-rename (double-
  // rename would also re-target a detached label)
  for (const evn of ['mousedown', 'click', 'contextmenu']) {
    input.addEventListener(evn, (e) => e.stopPropagation());
  }
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v && v !== tab.name) tab.named = 'user'; // a name you typed is never auto-renamed
    if (v && v !== tab.name && tab.isClaude) {
      tab.pendingRename = rcLabel(v); // phone + /resume list name: sent when the agent is idle
      tab.name = v;
      syncClaudeName(tab);
    } else if (v) tab.name = v;
    input.remove(); // redraws are skipped while .rename is live — clear it BEFORE rebuilding
    renderTabBar();
    persist();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = tab.name; input.blur(); }
    e.stopPropagation();
  };
}

export function snapshot() {
  return [...tabs.values()].map(t => ({
    termId: t.id,
    name: t.name,
    cwd: t.cwd,
    isClaude: t.isClaude,
    claudeSessionId: t.sessionId || null,
    account: t.account || null,
    accountAt: t.accountAt || 0,
    worktree: t.worktree || null,
    named: t.named || null,
  }));
}

export function isActiveKnown() {
  return activeId !== null;
}

export function activeTermId() {
  return activeId;
}

// ---- read access for the agent board (ui/board.js) and the tab menu ----------
// The board only READS tab + feed state; the status files / feed stay the truth.
const agentListeners = [];
let agentsQueued = false;
export function onAgentsChanged(fn) { agentListeners.push(fn); }
function notifyAgents() {
  if (agentsQueued || !agentListeners.length) return;
  agentsQueued = true;
  queueMicrotask(() => { agentsQueued = false; for (const fn of agentListeners) { try { fn(); } catch {} } });
}

export function feedFor(termId) {
  return feeds.get(termId) || null;
}

export function agents() {
  return [...tabs.values()].map(t => ({
    id: t.id, name: t.name, status: t.status || null, isClaude: t.isClaude, dead: t.dead, feed: feeds.get(t.id) || null,
    worktree: t.worktree || null,
  }));
}

export function activate(id) {
  if (tabs.has(id)) activateTab(id);
}

// board → background agent: a new tab running `claude attach <id>`. A PLAIN
// tab: attach ignores --settings ("extra arguments ignored", verified 2.1.284),
// so no status hooks/feed; the session keeps its own. Ids come from main's
// JSON parse and are re-checked here before being typed into a shell.
export function attachBackground(bgId, name) {
  if (!/^[0-9a-f]{6,64}$/i.test(String(bgId))) return null;
  const label = 'bg-' + String(name || bgId).replace(/[^\w .-]/g, '').trim().slice(0, 18);
  return createTab({ name: nextName(label.replace(/\s+/g, '-')), cwd: repoPath, run: `claude attach ${bgId}` });
}

// A tab rename reaches the running claude as `/rename <ws · name>`, which also
// renames its Remote Control session on the phone (verified 2026-10-01). Only
// sent at a safe moment: the turn is done and nothing was typed since, so it
// never lands inside a half-typed prompt or a dialog. Otherwise it waits for the
// next `done`.
// A tab still called agent-N takes the conversation's name: claude's own title
// (written to the transcript shortly after the first message) or its /rename
// name. Once, and never over a name the user typed (`named`). Main builds the
// name (sessions.tabNameFor). An auto name from claude's title is also sent
// back as /rename, so the phone and the resume list show it too.
const DEFAULT_AGENT_NAME = /^agent-\d+$/;
const restoredNamed = new Map(); // termId -> 'user' | 'auto', from the saved state
async function autoName(tab) {
  const eligible = () => tabs.has(tab.id) && !tab.dead && tab.isClaude && !tab.named && tab.sessionId && DEFAULT_AGENT_NAME.test(tab.name)
    && !document.querySelector('input.rename'); // not while a tab is being renamed by hand
  if (!tab || tab.autoNaming || !eligible()) return;
  tab.autoNaming = true;
  try {
    const taken = [...tabs.values()].filter(t => t !== tab).map(t => t.name);
    const r = await vs.sessionTabName(wsId, tab.sessionId, tab.cwd, taken);
    if (!r || !r.name || !eligible()) return;
    tab.name = r.name;
    tab.named = 'auto';
    if (r.from === 'ai') { tab.pendingRename = rcLabel(r.name); syncClaudeName(tab); }
    renderTabBar();
    persist();
  } catch (e) {
    console.warn(`auto-name failed for ${tab.id}`, e && e.message);
  } finally {
    tab.autoNaming = false;
  }
}

function syncClaudeName(tab) {
  if (!tab.pendingRename || tab.dead || tab.status !== 'done') return;
  if (tab.draft || (tab.lastInputAt || 0) > (tab.doneAt || 0)) return; // draft: typed while the turn ran
  const cmd = `/rename ${tab.pendingRename}`;
  tab.pendingRename = null;
  sendToAgent(tab.id, cmd);
}

// board quick reply: the same path as typing — term.paste (bracketed when the
// app asked for it, so claude takes it as one input), then Enter on its own
// write so it submits instead of landing inside the paste
export function sendToAgent(id, text) {
  const tab = tabs.get(id);
  if (!tab || tab.dead || !text) return false;
  // term.paste fires onData synchronously: flag it so it doesn't count as typing
  appWriting = true;
  try { tab.term.paste(text); } finally { appWriting = false; }
  setTimeout(() => { if (tabs.has(id)) vs.ptyWrite(id, '\r'); }, 120);
  return true;
}

