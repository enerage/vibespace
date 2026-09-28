import { $, toast, debounce } from './ui/common.js';
import * as tree from './ui/tree.js';
import * as viewer from './ui/viewer.js';
import * as terms from './ui/terms.js';
import * as finder from './ui/finder.js';
import * as diffpane from './ui/diff.js';
import * as prefs from './ui/prefs.js';
import { applyTheme } from './ui/themes.js';

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
    theme: state.theme || 'vibespace',
    termPosition: state.termPosition || 'bottom',
    treeWidth: $('#tree-pane').getBoundingClientRect().width,
    expandedFolders: tree.expandedPaths(),
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
  restartBtn.onclick = async () => {
    const busy = await vs.ptyBusy().catch(() => false);
    const msg = busy
      ? 'Restart VibeSpace to pick up the new code?\n\nSome agents look busy right now — they will be interrupted and their conversations resumed on restart.'
      : 'Restart VibeSpace to pick up the new code?\n\nEvery agent conversation resumes automatically.';
    if (!confirm(msg)) return;
    restartBtn.disabled = true;
    try { await vs.appRestart(); } catch { restartBtn.disabled = false; }
  };
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
  diffpane.init(ws.repoPath, (p, n) => viewer.open(p, n));
  viewer.setPinnedTab('⟳ Changes', (on) => (on ? diffpane.show() : diffpane.hide()));
  $('#btn-diff').onclick = () => viewer.toggleChangesTab();
  // second tree:changed subscriber alongside tree.js — preload wraps each cb in its
  // own ipcRenderer.on listener, so both fire
  vs.onTreeChanged(() => viewer.onFilesChanged());
  tree.init(ws.repoPath, (path, name) => viewer.open(path, name), state.expandedFolders, {
    // tabs are keyed by fsList/fsRead paths (backslashes); the tree joins with '/'
    onRename: (from, to) => viewer.renameTab(from.replace(/\//g, '\\'), to.replace(/\//g, '\\')),
    // close every open tab at or under the deleted path (separator/case-insensitive)
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
  terms.init({
    wsId,
    repoPath: ws.repoPath,
    openFile: (p, n, l) => viewer.openAt(p, n, l), // file:line links → preview
    savedTerminals: state.terminals,
    autoResume: $('#auto-resume').checked,
    persist,
    quiet: Boolean(shot),
  });
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
