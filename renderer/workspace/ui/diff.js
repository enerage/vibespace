import { $, el, toast, debounce } from './common.js';
import { onMonaco, LANGS } from './viewer.js';
import { monacoTheme, onThemeChange } from './themes.js';
import * as history from './history.js';

// Git, split VS Code style:
//   left sidebar (#git-side, the "Git" tab above the file tree) — the lists:
//     Changes — uncommitted files · History — commits → one commit's files
//   preview area (#diff-host, the pinned "Diff" tab) — ONE read-only DiffEditor
//     showing whichever file was last clicked in either list.
// Clicking a file in the sidebar opens the Diff tab; merely switching the
// sidebar to Git never covers the file you're reading.
// Diff models live under git:///HEAD/<rel>, file:///diff-wt/<rel> and
// git:///c/<sha>/… URIs so they can never collide with — and are never
// confused for — viewer-owned file:///<abs> tab models.

let repoPath = null;
let openFile = () => {};
let openEditor = () => {}; // viewer: switch the preview to the pinned Diff tab

let monacoRef = null;
let diffEditor = null;
let wantEditor = false;   // the Diff tab was shown at least once
let files = [];           // last gitDiff payload
let models = [];          // [{rel, original, modified}] — ours to dispose each refresh
let currentRel = null;
let refreshing = false;
const rowEls = new Map(); // rel -> row element
let mode = 'changes';     // 'changes' | 'history'
let histPair = null;      // {original, modified} models for the history file on screen
let sidebarOn = false;

export function init(repo, { open, showEditor } = {}) {
  repoPath = repo;
  openFile = open || openFile;
  openEditor = showEditor || openEditor;
  history.setRepo(repo);
  // history reloads in the background (HEAD moved) — it may only paint the
  // editor area while History is the active mode
  history.init({
    pair: showHistoryPair,
    empty: (msg, open) => { if (mode === 'history') { showMessage(msg); if (open) openEditor(); } },
    open: openFile,
  });
  for (const b of document.querySelectorAll('#git-modes button')) b.onclick = () => setMode(b.dataset.mode);
  // agents edit files constantly: keep the Changes list live while it's visible
  vs.onTreeChanged(debounce(() => { if (sidebarOn && mode === 'changes') refresh(); }, 1000));
  onMonaco((m) => {
    monacoRef = m;
    onThemeChange((t) => { try { diffEditor?.updateOptions({ theme: t.monaco }); } catch {} });
    if (wantEditor) createEditor();
    if (files.length) { buildModels(); renderList(); applySelection(); } // refreshed before Monaco landed
  });
}

// ---------- sidebar (lists) ----------

export function showSidebar() {
  sidebarOn = true;
  setMode(mode, true);
}

export function hideSidebar() { sidebarOn = false; }

export function currentMode() { return mode; }

export function setMode(m, force = false) {
  if (m !== 'changes' && m !== 'history') return;
  if (m === mode && !force) return;
  mode = m;
  for (const b of document.querySelectorAll('#git-modes button')) b.classList.toggle('active', b.dataset.mode === m);
  $('#diff-files').classList.toggle('hidden', m !== 'changes');
  $('#hist-list').classList.toggle('hidden', m !== 'history');
  if (m === 'changes') { disposeHistPair(); refresh(); } else history.activate();
}

// Entry points (Diff button, branch chip, tree "Git history") call this, then
// show the sidebar. filter: undefined = keep, null = whole repo, {rel, dir}.
// While the sidebar is hidden only the target is recorded — showSidebar()
// applies it, so nothing loads twice.
export function prepare(m, filter) {
  if (filter !== undefined) history.setFilter(filter);
  if (!sidebarOn) { if (m) mode = m; return; }
  if (m && m !== mode) setMode(m);
  else if (mode === 'history') history.activate();
}

export function headMoved(oid) { history.headMoved(oid); }
export function remoteMoved() { history.remoteMoved(); }
export function historyFiltered() { return history.hasFilter(); }

// ---------- preview (the one DiffEditor) ----------

// pinned Diff tab turned on/off by the viewer
export function show() {
  $('#diff-host').classList.remove('hidden');
  wantEditor = true;
  if (monacoRef && !diffEditor) createEditor();
  if (mode === 'history' && histPair) diffEditor?.setModel(histPair);
  else if (mode === 'changes' && currentRel) applySelection();
  else showMessage(mode === 'history' ? 'Pick a commit in the Git sidebar to see what it changed.' : 'Pick a changed file in the Git sidebar.');
}

export function hide() {
  $('#diff-host').classList.add('hidden');
}

function showMessage(msg) {
  $('#diff-empty p').textContent = msg;
  $('#diff-empty').classList.remove('hidden');
  $('#diff-editor').classList.add('hidden');
}

function showEditorArea() {
  $('#diff-empty').classList.add('hidden');
  $('#diff-editor').classList.remove('hidden');
}

// open = the user clicked this file → bring the Diff tab up
function showHistoryPair(key, original, modified, rel, open) {
  if (mode !== 'history' || !monacoRef) return;
  disposeHistPair();
  const lang = langFor(rel);
  const k = encodeURIComponent(key);
  histPair = {
    original: monacoRef.editor.createModel(original ?? '', lang, monacoRef.Uri.parse('git:///c/before/' + k)),
    modified: monacoRef.editor.createModel(modified ?? '', lang, monacoRef.Uri.parse('git:///c/after/' + k)),
  };
  showEditorArea();
  if (diffEditor) diffEditor.setModel(histPair);
  if (open) openEditor();
}

function disposeHistPair() {
  if (!histPair) return;
  if (diffEditor) { try { diffEditor.setModel(null); } catch {} }
  try { histPair.original.dispose(); } catch {}
  try { histPair.modified.dispose(); } catch {}
  histPair = null;
}

function createEditor() {
  if (diffEditor || !monacoRef) return;
  diffEditor = monacoRef.editor.createDiffEditor($('#diff-editor'), {
    theme: monacoTheme(),
    readOnly: true,
    renderSideBySide: true,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    renderOverviewRuler: false,
  });
  if (mode === 'history' && histPair) diffEditor.setModel(histPair);
  else applySelection();
}

// ---------- Changes mode ----------

export async function refresh() {
  if (!repoPath || refreshing || mode !== 'changes') return;
  refreshing = true;
  try {
    const d = await vs.gitDiff(repoPath, { refresh: true });
    disposeModels();
    rowEls.clear();
    if (!d) {
      files = [];
      renderEmpty('Not a git repository.');
      return;
    }
    files = d.files || [];
    if (!files.length) { renderEmpty(); return; }
    // keep the file you were looking at; don't auto-pick one (that would be a
    // diff you never asked for the next time the Diff tab opens)
    if (!files.some((f) => f.rel === currentRel)) currentRel = null;
    buildModels();
    renderList();
    if (currentRel) { showEditorArea(); applySelection(); }
    else showMessage('Pick a changed file in the Git sidebar.');
  } catch (e) {
    toast('Diff failed: ' + (e.message || e), 'err');
  } finally {
    refreshing = false;
  }
}

function buildModels() {
  disposeModels();
  if (!monacoRef) return;
  for (const f of files) {
    const lang = langFor(f.rel);
    models.push({
      rel: f.rel,
      original: monacoRef.editor.createModel(f.original ?? '', lang, monacoRef.Uri.parse('git:///HEAD/' + f.rel)),
      modified: monacoRef.editor.createModel(f.modified ?? '', lang, monacoRef.Uri.parse('file:///diff-wt/' + f.rel)),
    });
  }
}

function disposeModels() {
  if (diffEditor) { try { diffEditor.setModel(null); } catch {} }
  for (const m of models) {
    try { m.original.dispose(); } catch {}
    try { m.modified.dispose(); } catch {}
  }
  models = [];
}

function applySelection() {
  if (!diffEditor || !currentRel || mode !== 'changes') return;
  const pair = models.find((m) => m.rel === currentRel);
  if (pair) diffEditor.setModel({ original: pair.original, modified: pair.modified });
}

function select(rel) {
  currentRel = rel;
  for (const [r, row] of rowEls) row.classList.toggle('active', r === rel);
  showEditorArea();
  applySelection();
  openEditor();
}

function renderEmpty(msg) {
  currentRel = null;
  renderList(msg || 'No uncommitted changes.');
  showMessage(msg || 'No uncommitted changes.');
}

function renderList(emptyMsg) {
  const host = $('#diff-files');
  host.innerHTML = '';
  rowEls.clear();
  const head = el('div', 'diff-head');
  head.appendChild(el('span', '', files.length ? `${files.length} changed` : 'Changes'));
  head.appendChild(el('span', 'spacer'));
  const btn = el('button', 'btn small ghost', '⟳');
  btn.id = 'btn-diff-refresh';
  btn.title = 'Re-scan the working tree';
  btn.onclick = () => refresh();
  head.appendChild(btn);
  host.appendChild(head);
  if (emptyMsg) host.appendChild(el('div', 'hist-note', emptyMsg));
  for (const f of files) {
    const row = el('div', 'diff-file' + (f.rel === currentRel ? ' active' : ''));
    row.title = f.path;
    row.appendChild(el('span', 'st git-' + (f.status || '').toLowerCase(), f.status));
    row.appendChild(el('span', 'rel', f.rel));
    const mini = el('span', 'mini', '↗');
    mini.title = 'Open the file in a tab';
    mini.onclick = (e) => { e.stopPropagation(); openFile(f.path, f.rel.split(/[\\/]/).pop()); };
    row.appendChild(mini);
    row.onclick = () => select(f.rel);
    rowEls.set(f.rel, row);
    host.appendChild(row);
  }
}

function langFor(rel) {
  const ext = (rel.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  return LANGS[ext] || 'plaintext';
}
