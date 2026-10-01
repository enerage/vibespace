import { $, toast, debounce, confirmBox } from './ui/common.js';
import * as tree from './ui/tree.js';
import * as viewer from './ui/viewer.js';
import * as terms from './ui/terms.js';
import * as finder from './ui/finder.js';
import * as diffpane from './ui/diff.js';
import * as prefs from './ui/prefs.js';
import { applyTheme } from './ui/themes.js';
import * as limits from './ui/limits.js';

const wsId = new URLSearchParams(location.search).get('id');
let ws = null;
let state = {};

function persistNow() {
  if (!ws) return;
  const termsRect = $('#terms-pane').getBoundingClientRect();
  vs.saveState(wsId, {
    terminals: terms.snapshot(),
    activeTerm: terms.activeTermId(),
    autoResume: $('#auto-resume').checked,
    phoneRemote: $('#phone-remote').checked,
    theme: state.theme || 'vibespace',
    termPosition: state.termPosition || 'bottom',
    treeWidth: $('#tree-pane').getBoundingClientRect().width,
    expandedFolders: tree.expandedPaths(),
    sideView,
    termHeight: Math.round(termsRect.height),
    termWidth: Math.round(termsRect.width),
    viewer: viewer.snapshot(),
  });
}
const persist = debounce(persistNow, 350);

// ---------- terminal dock position: bottom <-> right ----------
function layoutTitle() {
  return state.termPosition === 'right'
    ? 'Terminals are on the right — click to move them to the bottom'
    : 'Terminals are at the bottom — click to move them to the right side';
}
function applyTermPosition() {
  const right = state.termPosition === 'right';
  $('#body').classList.toggle('terms-right', right);
  const pane = $('#terms-pane');
  const size = right ? (state.termWidth || 560) : (state.termHeight || 380);
  pane.style.flexBasis = size + 'px';
  $('#btn-layout').title = layoutTitle();
  requestAnimationFrame(() => terms.refitActive());
}

function wireLayoutToggle() {
  // lives inside the ⚙ Preferences modal now (same element id, same behavior)
  $('#btn-layout').onclick = () => {
    state.termPosition = state.termPosition === 'right' ? 'bottom' : 'right';
    applyTermPosition();
    persistNow();
    $('#btn-layout').title = layoutTitle();
  };

  // swap this workspace's logo from inside the window (was launcher-only; the
  // window reloads onto the new icon — agents survive and re-attach).
  // The topbar logo image is the natural click target; the 🏷 button labels it.
  const changeLogo = async () => {
    const file = await vs.pickLogo();
    if (!file) return;
    try {
      await vs.updateLogo(wsId, file);
      // on success the window reloads with the new icon — no toast needed
    } catch (e) {
      toast('Logo update failed: ' + (e.message || e), 'err');
    }
  };
  const logoImg = $('#ws-logo');
  logoImg.title = 'Change this workspace’s logo — window icon updates live; re-pin the taskbar shortcut to refresh it';
  logoImg.onclick = changeLogo;

  // drop an image ON the logo to set it (drag a png from the desktop → logo)
  logoImg.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    logoImg.style.outline = '2px solid var(--accent)';
  });
  logoImg.addEventListener('dragleave', () => { logoImg.style.outline = ''; });
  logoImg.addEventListener('drop', async (e) => {
    e.preventDefault();
    logoImg.style.outline = '';
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = vs.dropPath(f);
    if (!p) return;
    try { await vs.updateLogo(wsId, p); } catch (err) { toast('Logo update failed: ' + (err.message || err), 'err'); }
  });

  // ↻ restart onto new VibeSpace code: the button only exists after main detects a
  // source-tree change; restarting relaunches this window and all conversations
  // auto-resume (busy agents get interrupted — the confirm says so)
  const restartBtn = $('#btn-app-restart');
  // one restart flow for both entry points: the conditional ↻ (new code) and
  // Preferences → "Restart this workspace" (always there, any reason)
  const restartWorkspace = async (question, btn) => {
    persistNow(); // main needs fresh tab names/ids to answer who is busy
    const r = await vs.ptyBusy(wsId).catch(() => null);
    const names = (r && r.names) || [];
    const msg = names.length
      ? `${question}\n\n${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} working right now — ${names.length > 1 ? 'they' : 'it'} will be interrupted and resumed on restart.`
      : `${question}\n\nEvery agent conversation resumes automatically.`;
    if (!(await confirmBox(msg, { ok: 'Restart' }))) return;
    btn.disabled = true;
    try { await vs.appRestart(); } catch { btn.disabled = false; }
  };
  restartBtn.onclick = () => restartWorkspace('Restart VibeSpace to pick up the new code?', restartBtn);
  $('#btn-restart-ws').onclick = () => restartWorkspace('Restart this workspace window?', $('#btn-restart-ws'));
  vs.onAppUpdateAvailable(() => {
    restartBtn.classList.remove('hidden');
    toast('New VibeSpace code detected — click ↻ Restart VibeSpace when ready', 'ok');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      vs.copyDiagnostics(wsId).then(() =>
        toast('Diagnostics copied — paste it to your agent when reporting an issue', 'ok'));
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      if (!terms.jumpToAttention()) toast('No agent needs attention right now', '');
    }
  });
}

function wireSplitters() {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const dragStart = { treeW: 0, termW: 0, termH: 0 };

  // tree | content
  makeSplitter(
    $('#split-v'),
    () => { dragStart.treeW = $('#tree-pane').getBoundingClientRect().width; },
    (dx) => { $('#tree-pane').style.width = clamp(dragStart.treeW + dx, 160, 640) + 'px'; }
  );

  // viewer | terminals — vertical drag when docked bottom, horizontal when right
  makeSplitter(
    $('#split-h'),
    () => {
      const r = $('#terms-pane').getBoundingClientRect();
      dragStart.termW = r.width;
      dragStart.termH = r.height;
    },
    (dx, dy) => {
      const pane = $('#terms-pane');
      if (state.termPosition === 'right') {
        pane.style.flexBasis = clamp(dragStart.termW - dx, 280, window.innerWidth - 560) + 'px';
      } else {
        pane.style.flexBasis = clamp(dragStart.termH - dy, 120, window.innerHeight - 200) + 'px';
      }
    }
  );
}

// Splitter drag: sizes are captured once at drag start and cumulative pointer
// deltas are applied to the frozen value. Deriving each step from the rendered
// size instead feeds flexbox shrink back into the basis and spirals.
// Deltas come from clientX/clientY — movementX/movementY spike unpredictably.
// Listeners live on the WINDOW (capture) for the duration of the drag:
// no setPointerCapture, which misbehaves with injected mouse events.
function makeSplitter(handle, onStart, onDrag) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
    terms.beginResize();
    onStart();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev) => {
      if (ev.clientX === startX && ev.clientY === startY) return;
      moved = true;
      onDrag(ev.clientX - startX, ev.clientY - startY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      document.body.classList.remove('dragging');
      terms.endResize();
      if (moved) persist();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  });
}



// ---------- git: left-pane Files|Git switcher, entry points, branch chip ----------
// The Git view (lists) lives in the left pane like VS Code's Source Control;
// clicking a file there diffs it in the preview's pinned Diff tab.
let sideView = 'files';
function setSideView(v, { save = true } = {}) {
  if (v !== 'files' && v !== 'git') return;
  sideView = v;
  for (const b of document.querySelectorAll('#side-tabs button')) b.classList.toggle('active', b.dataset.side === v);
  $('#tree').classList.toggle('hidden', v === 'git');
  $('#git-side').classList.toggle('hidden', v !== 'git');
  if (v === 'git') diffpane.showSidebar(); else diffpane.hideSidebar();
  if (save) persist();
}

// Diff button / branch chip / tree "Git history": show the Git view in a mode.
// Hitting the same entry point again while that mode shows goes back to Files.
function openGitPane(mode, filter) {
  if (filter === undefined && sideView === 'git' && diffpane.currentMode() === mode) { setSideView('files'); return; }
  diffpane.prepare(mode, filter);
  if (sideView !== 'git') setSideView('git'); // showSidebar applies what prepare recorded
}

// branch ↑ahead ↓behind chip — polled (cheap: one `git status --porcelain=v2
// --branch` without the untracked scan) on an interval, on window focus and
// after tree changes. A HEAD move also refreshes an open History list, so
// agent commits show up live.
function wireGitChip() {
  const chip = $('#git-chip');
  // always the WHOLE repo's history: a file filter left from the tree menu is cleared
  chip.onclick = () => openGitPane('history', diffpane.historyFiltered() ? null : undefined);
  let busy = false;
  // hidden = minimized OR fully covered (Electron occlusion) — skip polling
  // then, but the first paint and every "visible again" always run
  const update = async (force) => {
    if (busy || (document.hidden && force !== true)) return;
    busy = true;
    try {
      const b = await vs.gitBranch().catch(() => null);
      if (!b) { chip.classList.add('hidden'); return; }
      chip.classList.remove('hidden');
      const name = b.head || (b.oid ? 'detached @ ' + b.oid.slice(0, 7) : 'no commits');
      chip.innerHTML = '<span class="git-ico"></span>';
      chip.append(name);
      const tip = [b.upstream ? `${name} → ${b.upstream}` : `${name} (no upstream)`];
      if (b.ahead) { chip.append(Object.assign(document.createElement('span'), { className: 'ab up', textContent: '↑' + b.ahead })); tip.push(`${b.ahead} commit${b.ahead > 1 ? 's' : ''} not pushed`); }
      if (b.behind) { chip.append(Object.assign(document.createElement('span'), { className: 'ab down', textContent: '↓' + b.behind })); tip.push(`${b.behind} behind the remote (as of the last fetch)`); }
      chip.classList.toggle('warn', Boolean(b.operation));
      if (b.operation) { chip.append(Object.assign(document.createElement('span'), { className: 'ab op', textContent: b.operation })); tip.push(`Repository is stuck ${b.operation} — finish or abort it in a terminal`); }
      tip.push('Click for commit history');
      chip.title = tip.join('\n');
      diffpane.headMoved(b.oid);
      // uncommitted-file count on the left pane's Git tab (status is cached main-side)
      const st = await vs.gitStatus(ws.repoPath).catch(() => null);
      const n = st ? st.size : 0;
      const badge = $('#side-git-count');
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', !n);
    } finally {
      busy = false;
    }
  };
  update(true);
  setInterval(update, 10000);
  window.addEventListener('focus', () => update(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(true); });
  vs.onTreeChanged(debounce(update, 800));
}

// 📱 away toggle. Presence is machine-wide (main/presence.cjs): while away/idle
// the at-PC marker is gone and claude pushes agents that need you to the phone.
function wirePresence() {
  const btn = $('#btn-away');
  const paint = (p) => {
    if (!p) return;
    const away = p.mode !== 'present';
    btn.classList.toggle('away', away);
    btn.textContent = away ? '📱 Away' : '📱 At PC';
  };
  btn.onclick = async () => {
    const goAway = !btn.classList.contains('away');
    const p = await vs.presenceSet(goAway ? 'away' : 'present').catch(() => null);
    paint(p);
    if (!p || !goAway) return;
    // claude pushes on the transition INTO waiting — agents already waiting stay silent
    const n = terms.agents().filter(a => a.isClaude && !a.dead && a.status === 'waiting').length;
    toast(n
      ? `Away — ${n} agent${n > 1 ? 's' : ''} already waiting won't re-notify your phone; they're in the Claude app's list.`
      : 'Away — phone pushes on', 'ok');
  };
  vs.onPresence(paint);
  vs.presenceGet().then(paint).catch(() => {});
}

async function main() {
  ws = await vs.getWorkspace(wsId);
  if (!ws) {
    toast('Workspace not found — close this window and open the launcher.', 'err');
    return;
  }
  document.title = ws.name;
  $('#ws-name').textContent = ws.name;
  $('#ws-path').textContent = ws.repoPath;
  const logo = $('#ws-logo');
  logo.src = 'app://local/icons/' + encodeURIComponent(ws.iconPath.split(/[\\/]/).pop());
  logo.onerror = () => { logo.style.visibility = 'hidden'; };

  state = (await vs.loadState(wsId)) || {};
  // theme FIRST — before terminals/viewer exist, so xterm and Monaco are born
  // themed (theme-boot.js already replayed the vars pre-paint)
  applyTheme(state.theme || 'vibespace', wsId);
  if (typeof state.autoResume === 'boolean') $('#auto-resume').checked = state.autoResume;
  if (typeof state.phoneRemote === 'boolean') $('#phone-remote').checked = state.phoneRemote;
  if (state.treeWidth) $('#tree-pane').style.width = state.treeWidth + 'px';
  applyTermPosition();
  wireLayoutToggle();
  prefs.init({
    wsId,
    persist,
    layoutTitle,
    onThemePicked: (id) => { state.theme = id; persistNow(); },
  });

  viewer.init(persist);
  viewer.restore(state.viewer?.openFiles || [], state.viewer?.activePath);
  // git diff review pane: pinned "Changes" tab + Diff toolbar button
  diffpane.init(ws.repoPath, { open: (p, n) => viewer.open(p, n), showEditor: () => viewer.showChangesTab() });
  viewer.setPinnedTab('Diff', (on) => (on ? diffpane.show() : diffpane.hide()));
  $('#btn-diff').onclick = () => openGitPane('changes');
  for (const b of document.querySelectorAll('#side-tabs button')) b.onclick = () => setSideView(b.dataset.side);
  setSideView(state.sideView === 'git' ? 'git' : 'files', { save: false });
  wireGitChip();
  // second tree:changed subscriber alongside tree.js — preload wraps each cb in its
  // own ipcRenderer.on listener, so both fire
  vs.onTreeChanged(() => viewer.onFilesChanged());
  tree.init(ws.repoPath, (path, name) => viewer.open(path, name), state.expandedFolders, {
    // tabs are keyed by fsList/fsRead paths (backslashes); the tree joins with '/'
    onRename: (from, to) => viewer.renameTab(from.replace(/\//g, '\\'), to.replace(/\//g, '\\')),
    // close every open tab at or under the deleted path (separator/case-insensitive)
    onHistory: (rel, dir) => openGitPane('history', { rel, dir }),
    onDeleted: (abs) => {
      const gone = abs.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() + '/';
      for (const f of viewer.snapshot().openFiles) {
        const open = f.path.replace(/\\/g, '/').toLowerCase();
        if (open + '/' === gone || open.startsWith(gone)) viewer.closeTab(f.path, { force: true });
      }
    },
  });
  finder.init(ws.repoPath, (path, name) => viewer.open(path, name));

  const shot = new URLSearchParams(location.search).get('shot');
  limits.init(wsId); // 5h/7d plan-limit chip (claude data feed)
  terms.init({
    wsId,
    repoPath: ws.repoPath,
    openFile: (p, n, l) => viewer.openAt(p, n, l), // file:line links → preview
    savedTerminals: state.terminals,
    autoResume: $('#auto-resume').checked,
    remote: () => $('#phone-remote').checked, // read at each launch: applies to new agents
    wsName: ws.name,
    persist,
    quiet: Boolean(shot),
  });
  wirePresence();
  if (shot) viewer.open(ws.repoPath + '\\README.md', 'README.md'); // docs mode: show code in the preview

  wireSplitters();

  const ver = await vs.claudeVersion();
  if (ver) $('#ws-path').title = ver;

  // periodic save so late-discovered session ids land in state.json
  setInterval(persistNow, 5000);
  window.addEventListener('beforeunload', persistNow);
  new ResizeObserver(() => terms.scheduleRefit()).observe($('#term-hosts'));
}

main();
