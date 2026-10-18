import { el, modKey } from './common.js';
import { agoShort } from './parked.js';
import { CLOUD_ID, shortTask } from './shellcmd.js';

// Send to cloud (0.6.58). A Claude Code cloud session (`claude --cloud`) runs
// on Anthropic's machines against a clone of the repo's GitHub remote, on the
// chosen account; `claude --teleport <id>` brings it back into a local tab.
// terms.js owns the list (state.json `cloud`, newest first) and the flows;
// this module holds the pure helpers (smoke imports them), the + ▾ menu rows
// and the Send dialog. Cloud tabs are PLAIN tabs: no hooks, no feed, no
// session tracking, no account moves.

export const MAX_ENTRIES = 50; // kept in state.json
export const MENU_MAX = 8; // rows in the + ▾ menu, then "More cloud sessions…"
export const CLOUD_TAB_KINDS = ['send', 'teleport', 'setup'];

// ---------- pure helpers ----------
// a valid list: entries with a cloud session id, one per id, newest first
export function normalizeCloud(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !CLOUD_ID.test(String(e.id || '')) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      url: typeof e.url === 'string' && /^https:\/\/claude\.ai\//.test(e.url) ? e.url : `https://claude.ai/code/${e.id}`,
      task: String(e.task || ''),
      account: typeof e.account === 'string' && e.account ? e.account : 'login',
      branch: typeof e.branch === 'string' && e.branch ? e.branch : null,
      startedAt: Number(e.startedAt) || 0,
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_ENTRIES);
}

export function makeEntry({ id, url, task, account, branch = null, now = Date.now() }) {
  return { id, url: url || `https://claude.ai/code/${id}`, task: String(task || ''), account: account || 'login', branch: branch || null, startedAt: now };
}

// accounts that can start cloud sessions (login + token kinds, signed in for
// cloud), in the automatic order (or the manual one when it is off)
export function readyAccounts(st, ready) {
  const rows = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  const order = Array.isArray(st && st.ranked) ? st.ranked : rows.map(a => a.id);
  return order.map(id => rows.find(a => a.id === id))
    .filter(a => a && (a.kind === 'login' || a.kind === 'token') && ready && ready[a.id] && ready[a.id].ready);
}

// the dialog's preselected account: the top of the automatic order (the
// account new agents start on) when it is cloud-ready, else the first ready one
export function defaultAccount(st, ready) {
  const rows = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  const order = Array.isArray(st && st.ranked) ? st.ranked : rows.map(a => a.id);
  const top = order.map(id => rows.find(a => a.id === id))
    .find(a => a && a.family === 'anthropic' && a.available !== false && a.room !== false);
  const list = readyAccounts(st, ready);
  if (top && list.some(a => a.id === top.id)) return top.id;
  return list.length ? list[0].id : null;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// the dialog's branch line from main's cloud:gitInfo → { text, warn }.
// A cloud session clones the GitHub remote at the current branch: commits
// that aren't pushed, and uncommitted changes, are not in it.
export function branchNote(g) {
  if (!g) return { warn: true, text: "Can't read this repo's git state: a cloud session clones the repo from GitHub." };
  if (g.detached || !g.head) return { warn: true, text: 'Detached HEAD: check out a branch and push it first (cloud clones GitHub at a branch).' };
  const dirty = Number(g.dirty) > 0 ? ` ${plural(Number(g.dirty), 'uncommitted change')} stay on this PC.` : '';
  if (!g.upstream) return { warn: true, text: `⚠ ${g.head} has no upstream: cloud clones GitHub at ${g.head}: push first (git push -u origin ${g.head}).${dirty}` };
  if (Number(g.ahead) > 0) return { warn: true, text: `⚠ ${plural(Number(g.ahead), 'unpushed commit')} on ${g.head}: cloud clones GitHub at ${g.head}: push first.${dirty}` };
  return { warn: Boolean(dirty), text: `Cloud clones GitHub at ${g.head} (in sync with ${g.upstream}).${dirty}` };
}

// "Bring back" (claude --teleport) needs a clean tree: why not, or null
export function teleportBlocker(g) {
  if (!g) return "can't read this repo's git state";
  if (g.operation) return `git is ${g.operation} here: finish or abort it first`;
  if (g.dirty == null) return "git couldn't tell whether the tree is clean";
  if (Number(g.dirty) > 0) return `${plural(Number(g.dirty), 'uncommitted change')}: commit or stash first, teleport needs a clean git tree`;
  return null;
}

// ---------- UI ----------
// + ▾ rows: click = open it on claude.ai, ↩ = bring it back, ✕ = forget.
// ctx: { open(id), bringBack(id), forget(id), accountLabel(id) }
export function menuItems(list, ctx, { max = Infinity, more = null } = {}) {
  const rows = list.slice(0, max).map(e => ({
    label: `☁ ${shortTask(e.task, 36)}`,
    meta: `${agoShort(e.startedAt)} · ${ctx.accountLabel(e.account)}`,
    hint: `${e.task}\n\n${e.url}${e.branch ? `\nfrom branch ${e.branch}` : ''}\nClick: open it on claude.ai`,
    run: () => ctx.open(e.id),
    actions: [
      { label: '↩', hint: 'Bring back: continue this cloud session here (claude --teleport, needs a clean git tree)', run: () => ctx.bringBack(e.id) },
      { label: '✕', hint: 'Forget: take it off this list (the session stays on claude.ai)', run: () => ctx.forget(e.id) },
    ],
  }));
  if (list.length > max && more) rows.push({ label: `More cloud sessions… (${list.length - max})`, run: more });
  return rows;
}

// The Send dialog (in-page, never window.prompt). Resolves { task, account }
// or null. opts: { accounts: rows (readyAccounts), selected, git (cloud:gitInfo),
// setupFor: { id, label } | null (no account ready: offer its sign-in), onSetup(id) }
export function openSendDialog({ accounts = [], selected = null, git = null, setupFor = null, onSetup = null, ready = {} } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = el('div', 'info-modal');
    const box = el('div', 'info-box cloud-box');
    box.append(el('h3', '', '☁ Send to cloud'));
    box.append(el('div', 'cloud-hint', 'A Claude Code cloud session works on a copy of this repo cloned from GitHub, on the account you pick. It keeps running when this PC sleeps; + ▾ → Cloud sessions lists it, and ↩ brings it back here.'));
    const task = el('textarea', 'cloud-task');
    task.placeholder = 'What should the cloud agent do?';
    task.rows = 5;
    task.spellcheck = true;
    box.append(task);

    const row = el('div', 'cloud-row');
    row.append(el('span', 'cloud-k', 'Account'));
    let select = null;
    if (accounts.length) {
      select = el('select', 'cloud-account');
      for (const a of accounts) {
        const o = el('option', '', a.label + (ready[a.id] && ready[a.id].email ? ` · ${ready[a.id].email}` : a.kind === 'login' ? ' · logged in' : ''));
        o.value = a.id;
        if (a.id === selected) o.selected = true;
        select.append(o);
      }
      row.append(select);
    } else {
      row.append(el('span', 'cloud-none', 'No account is signed in for cloud yet (⚙ Preferences → Accounts → Set up cloud…).'));
    }
    box.append(row);

    const bn = branchNote(git);
    box.append(el('div', 'cloud-branch' + (bn.warn ? ' warn' : ''), bn.text));
    box.append(el('div', 'cloud-hint', "Your own ~/.claude (settings, skills, MCP servers) doesn't travel; the repo's .claude/ does."));
    const err = el('div', 'acct-error hidden');
    box.append(err);

    const actions = el('div', 'info-actions');
    const no = el('button', 'btn small', 'Cancel');
    actions.append(no);
    let setupBtn = null;
    if (!accounts.length && setupFor && onSetup) {
      setupBtn = el('button', 'btn small', `Set up cloud for ${setupFor.label}…`);
      actions.append(setupBtn);
    }
    const yes = el('button', 'btn small primary', 'Send to cloud');
    yes.disabled = !accounts.length;
    actions.append(yes);
    box.append(actions);
    back.append(box);
    document.body.append(back);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      // focus back like confirmBox: what had it, else the visible terminal
      const target = prevFocus && prevFocus !== document.body && prevFocus.isConnected
        ? prevFocus
        : [...document.querySelectorAll('.xterm-helper-textarea')].find((t) => t.offsetParent !== null);
      try { target && target.focus(); } catch {}
      resolve(v);
    };
    const submit = () => {
      const t = task.value.trim();
      if (!t) { err.textContent = 'Describe the task first'; err.classList.remove('hidden'); task.focus(); return; }
      if (!select || !select.value) return;
      finish({ task: task.value, account: select.value });
    };
    // capture + stop: Esc / Ctrl+Enter must not reach xterm or the app shortcuts
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === 'Enter' && modKey(e)) { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    window.addEventListener('keydown', onKey, true);
    no.onclick = () => finish(null);
    yes.onclick = submit;
    if (setupBtn) setupBtn.onclick = () => { finish(null); onSetup(setupFor.id); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) finish(null); });
    task.focus();
  });
}
