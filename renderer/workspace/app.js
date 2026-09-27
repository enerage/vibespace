import { $, toast, debounce } from './ui/common.js';
import * as tree from './ui/tree.js';
import * as viewer from './ui/viewer.js';
import * as terms from './ui/terms.js';
import * as finder from './ui/finder.js';

const wsId = new URLSearchParams(location.search).get('id');
let ws = null;
let state = {};

function persistNow() {
  if (!ws) return;
  const termsRect = $('#terms-pane').getBoundingClientRect();
  vs.saveState(wsId, {
    terminals: terms.snapshot(),
    autoResume: $('#auto-resume').checked,
    termPosition: state.termPosition || 'bottom',
    treeWidth: $('#tree-pane').getBoundingClientRect().width,
    expandedFolders: tree.expandedPaths(),
    termHeight: Math.round(termsRect.height),
    termWidth: Math.round(termsRect.width),
  });
}
const persist = debounce(persistNow, 350);

// ---------- terminal dock position: bottom <-> right ----------
function applyTermPosition() {
  const right = state.termPosition === 'right';
  $('#body').classList.toggle('terms-right', right);
  const pane = $('#terms-pane');
  const size = right ? (state.termWidth || 560) : (state.termHeight || 380);
  pane.style.flexBasis = size + 'px';
  $('#btn-layout').title = right
    ? 'Terminals are on the right — click to move them to the bottom'
    : 'Terminals are at the bottom — click to move them to the right side';
  requestAnimationFrame(() => terms.refitActive());
}

function wireLayoutToggle() {
  $('#btn-layout').onclick = () => {
    state.termPosition = state.termPosition === 'right' ? 'bottom' : 'right';
    applyTermPosition();
    persistNow();
  };
  $('#btn-logs').onclick = () => vs.openLogs();

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
  $('#btn-logo').onclick = changeLogo;
  const logoImg = $('#ws-logo');
  logoImg.title = 'Change this workspace’s logo';
  logoImg.onclick = changeLogo;

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
  if (typeof state.autoResume === 'boolean') $('#auto-resume').checked = state.autoResume;
  if (state.treeWidth) $('#tree-pane').style.width = state.treeWidth + 'px';
  $('#auto-resume').addEventListener('change', persist);
  applyTermPosition();
  wireLayoutToggle();

  viewer.init(persist);
  tree.init(ws.repoPath, (path, name) => viewer.open(path, name), state.expandedFolders);
  finder.init(ws.repoPath, (path, name) => viewer.open(path, name));

  terms.init({
    wsId,
    repoPath: ws.repoPath,
    savedTerminals: state.terminals,
    autoResume: $('#auto-resume').checked,
    persist,
  });

  wireSplitters();

  const ver = await vs.claudeVersion();
  if (ver) $('#ws-path').title = ver;

  // periodic save so late-discovered session ids land in state.json
  setInterval(persistNow, 5000);
  window.addEventListener('beforeunload', persistNow);
  new ResizeObserver(() => terms.scheduleRefit()).observe($('#term-hosts'));
}

main();
