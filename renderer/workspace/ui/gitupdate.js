// ⬇ Update pill in the top bar (0.7.3, main/gitpull.cjs). The background fetch
// found commits on the upstream that this copy doesn't have → one click brings
// them in as a fast-forward. Everything the fast-forward refuses (a file
// changed here AND in the update, commits on both sides, a git error) goes to
// a NEW agent with the task spelled out, so a conflict is never the user's to
// solve by hand. A background fetch that can't sign in turns the pill into
// "can't check for updates" (else the button would just never appear).
import { $, toast, confirmBox } from './common.js';
import * as terms from './terms.js';

let ctx = null;           // { wsId, refresh, persistNow }
let last = null;          // the latest git:branch result
let tipKey = '';          // which state the tooltip's commit list belongs to
let running = false;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function init({ wsId, refresh, persistNow }) {
  ctx = { wsId, refresh, persistNow };
  $('#git-update').onclick = () => { run(); };
}

const authFailing = (b) => Boolean(b && b.upstream && b.fetch && b.fetch.enabled && b.fetch.failures && b.fetch.auth);
const behindOf = (b) => (b && b.upstream && !b.operation ? b.behind || 0 : 0);

// called with every chip refresh (null = no repo)
export function paint(b) {
  last = b;
  const btn = $('#git-update');
  if (!btn || running) return;
  const behind = behindOf(b);
  const auth = !behind && authFailing(b);
  btn.classList.toggle('hidden', !behind && !auth);
  btn.classList.toggle('warn', auth);
  if (behind) {
    btn.textContent = `⬇ Update (${behind})`;
    const key = `${b.oid}:${b.upstream}:${behind}`;
    if (key === tipKey) return;
    tipKey = key;
    const click = `Click to get ${behind === 1 ? 'it' : 'them'}. Your own work is kept.`;
    btn.title = `${plural(behind, 'new commit')} on ${b.upstream}\n\n${click}`;
    vs.gitIncoming().then((inc) => {
      if (!inc || tipKey !== key || !inc.subjects.length) return;
      const lines = inc.subjects.map((s) => '• ' + s);
      if (inc.count > inc.subjects.length) lines.push(`… and ${inc.count - inc.subjects.length} more`);
      btn.title = [`${plural(inc.count, 'new commit')} on ${b.upstream}:`, ...lines, '', click].join('\n');
    }).catch(() => {});
  } else if (auth) {
    tipKey = '';
    btn.textContent = "⚠ Can't check for updates";
    btn.title = `VibeSpace can't sign in to ${b.upstream.split('/')[0]} to look for new commits.\nGit said: ${b.fetch.error}\n\nClick: an agent helps you set up the sign-in.`;
  } else {
    tipKey = '';
  }
}

function askAgent(task) {
  terms.newAgentWithTask('update', task);
}

// the agent's first message. No ", $ or backticks (PowerShell "…" on Windows;
// newAgentWithTask strips them anyway)
function mergeTask(b, why) {
  const up = b.upstream;
  return `Bring the latest commits from ${up} into this project. VibeSpace could not do it by itself: ${why}. `
    + `Keep every change made here: commit uncommitted work first with a clear message, then merge ${up}. `
    + 'If there are conflicts, resolve them keeping both sides where you can, and ask me when a choice matters. '
    + 'Do not push. Finish with two or three plain sentences about what changed.';
}

function authTask(b) {
  return `VibeSpace looks for new commits on ${b.upstream} with a background git fetch, and it fails: ${b.fetch.error}. `
    + 'Help me set up git so that git fetch works in this project without asking for a password '
    + '(for GitHub the GitHub CLI is the simplest: gh auth login, then gh auth setup-git). '
    + 'Explain each step in plain words and wait for me whenever I have to do something.';
}

async function run() {
  const b = last;
  const btn = $('#git-update');
  if (running || !b || !ctx) return;
  if (!behindOf(b)) {
    if (authFailing(b)) askAgent(authTask(b));
    return;
  }
  // asks only when it would change files under a working agent
  ctx.persistNow(); // main needs fresh tab names/ids to answer who is busy
  const busy = await vs.ptyBusy(ctx.wsId).catch(() => null);
  const names = (busy && busy.names) || [];
  if (names.length) {
    const many = names.length > 1;
    const msg = `${names.join(', ')} ${many ? 'are' : 'is'} working right now. The update changes files in the project while ${many ? 'they work' : 'it works'}.\n\nUpdate anyway?`;
    if (!(await confirmBox(msg, { ok: 'Update anyway' }))) return;
  }
  running = true;
  btn.disabled = true;
  btn.textContent = '⬇ Updating…';
  let r;
  try { r = await vs.gitPull(); } catch (e) { r = { ok: false, reason: 'error', error: (e && e.message) || 'failed' }; }
  running = false;
  btn.disabled = false;
  tipKey = '';
  if (r && r.ok) btn.classList.add('hidden'); // don't wait for the refresh
  try { await ctx.refresh(); } catch {}
  report(b, r || { ok: false, reason: 'error', error: 'no answer' });
}

async function report(b, r) {
  if (r.ok) {
    toast(r.upToDate ? 'Already up to date' : `Updated: ${plural(r.count, 'new commit')} from ${b.upstream}`, 'ok');
    return;
  }
  if (r.reason === 'busy') { toast('An agent is committing right now. Try again in a moment.', 'err'); return; }
  if (r.reason === 'operation') { toast(`The project is in the middle of ${r.operation}. Finish that first, or ask an agent.`, 'err'); return; }
  if (r.reason === 'no-upstream') { toast('This branch has no upstream to update from.', 'err'); return; }
  if (r.reason === 'local-changes') {
    const files = [...(r.tracked || []), ...(r.untracked || [])];
    const more = r.more ? `\n  … and ${r.more} more` : '';
    const one = files.length === 1 && !r.more;
    const msg = `Couldn't update by itself: ${one ? 'this file was' : 'these files were'} changed here and in the update:\n\n`
      + files.map((f) => '  ' + f).join('\n') + more
      + '\n\nNothing was changed. An agent can bring the update in and keep your changes.';
    if (await confirmBox(msg, { ok: 'Ask an agent' })) {
      askAgent(mergeTask(b, `${one ? 'this file was' : 'these files were'} changed here and in the update: ${files.slice(0, 8).join(', ')}${r.more || files.length > 8 ? ' and more' : ''}`));
    }
    return;
  }
  if (r.reason === 'diverged') {
    const msg = `This copy has ${plural(r.ahead, 'commit')} that ${b.upstream} doesn't have, and ${b.upstream} has ${plural(r.behind, 'new commit')}.\n\n`
      + 'Nothing was changed. An agent can combine them.';
    if (await confirmBox(msg, { ok: 'Ask an agent' })) {
      askAgent(mergeTask(b, `this copy has ${plural(r.ahead, 'commit')} that ${b.upstream} does not have`));
    }
    return;
  }
  toast(`Update failed: ${r.error || 'unknown error'}`, 'err', {
    action: { label: 'Ask an agent', run: () => askAgent(mergeTask(b, `git said: ${r.error || 'unknown error'}`)) },
  });
}
