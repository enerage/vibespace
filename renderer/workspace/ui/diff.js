import { $, el, toast } from './common.js';
import { onMonaco, LANGS } from './viewer.js';
import { monacoTheme, onThemeChange } from './themes.js';
import * as history from './history.js';

// Git pane (the pinned "Git" tab), two modes sharing one DiffEditor:
//   Changes — read-only side-by-side diff of uncommitted work
//   History — commit list → commit detail → per-file before/after (history.js)
// Diff models live under git:///HEAD/<rel>, file:///diff-wt/<rel> and
// git:///c/<sha>/… URIs so they can never collide with — and are never
// confused for — viewer-owned file:///<abs> tab models.

let repoPath = null;
let openFile = () => {};

let monacoRef = null;
let diffEditor = null;
let wantEditor = false;   // show() was called at least once
let files = [];           // last gitDiff payload
let models = [];          // [{rel, original, modified}] — ours to dispose each refresh
let currentRel = null;
let refreshing = false;
const rowEls = new Map(); // rel -> row element
let mode = 'changes';     // 'changes' | 'history'
let histPair = null;      // {original, modified} models for the history file on screen

export function init(repo, open) {
  repoPath = repo;
  openFile = open || (() => {});
  history.setRepo(repo);
  // history reloads in the background (HEAD moved) — it may only paint the
  // editor area while History is the mode on screen
  history.init({ pair: showHistoryPair, empty: (msg) => { if (mode === 'history') showMessage(msg); }, open: openFile });
  for (const b of document.querySelectorAll('#git-modes button')) b.onclick = () => setMode(b.dataset.mode);
  onMonaco((m) => {
    monacoRef = m;
    onThemeChange((t) => { try { diffEditor?.updateOptions({ theme: t.monaco }); } catch {} });
    if (wantEditor) createEditor();
    if (files.length) { buildModels(); renderList(); applySelection(); } // refreshed before Monaco landed
  });
}

export function show(want) {
  $('#diff-host').classList.remove('hidden');
  wantEditor = true;
  if (monacoRef && !diffEditor) createEditor();
  setMode(want || mode, true);
}

export function currentMode() { return mode; }

export function setMode(m, force = false) {
  if (m !== 'changes' && m !== 'history') return;
  if (m === mode && !force) return;
  mode = m;
  for (const b of document.querySelectorAll('#git-modes button')) b.classList.toggle('active', b.dataset.mode === m);
  $('#diff-files').classList.toggle('hidden', m !== 'changes');
  $('#hist-list').classList.toggle('hidden', m !== 'history');
  $('#git-side').classList.toggle('wide', m === 'history');
  if (m === 'changes') { disposeHistPair(); refresh(); } else history.activate();
}

// Entry points (Diff button, branch chip, tree "Git history") call this, then
// show the pinned tab. filter: undefined = keep, null = whole repo, {rel, dir}.
// While the pane is hidden only the target is recorded — show() applies it, so
// nothing loads twice.
export function prepare(m, filter) {
  if (filter !== undefined) history.setFilter(filter);
  if ($('#diff-host').classList.contains('hidden')) { if (m) mode = m; return; }
  if (m && m !== mode) setMode(m);
  else if (mode === 'history') history.activate();
}

export function headMoved(oid) { history.headMoved(oid); }

function showMessage(msg) {
  $('#diff-empty p').textContent = msg;
  $('#diff-empty').classList.remove('hidden');
  $('#diff-editor').classList.add('hidden');
}

function showHistoryPair(key, original, modified, rel) {
  if (mode !== 'history' || !monacoRef) return;
  disposeHistPair();
  const lang = langFor(rel);
  const k = encodeURIComponent(key);
  histPair = {
    original: monacoRef.editor.createModel(original ?? '', lang, monacoRef.Uri.parse('git:///c/before/' + k)),
    modified: monacoRef.editor.createModel(modified ?? '', lang, monacoRef.Uri.parse('git:///c/after/' + k)),
  };
  $('#diff-empty').classList.add('hidden');
  $('#diff-editor').classList.remove('hidden');
  if (diffEditor) diffEditor.setModel(histPair);
}

function disposeHistPair() {
  if (!histPair) return;
  if (diffEditor) { try { diffEditor.setModel(null); } catch {} }
  try { histPair.original.dispose(); } catch {}
  try { histPair.modified.dispose(); } catch {}
  histPair = null;
}

export function hide() {
  $('#diff-host').classList.add('hidden');
}

export async function refresh() {
  if (!repoPath || refreshing || mode !== 'changes') return;
  refreshing = true;
  try {
    const d = await vs.gitDiff(repoPath, { refresh: true });
    disposeModels();
    rowEls.clear();
    if (!d) {
      toast('Not a git repository', 'err');
      files = [];
      renderEmpty('Not a git repository.');
      return;
    }
    files = d.files || [];
    if (!files.length) { renderEmpty(); return; }
    currentRel = files.some((f) => f.rel === currentRel) ? currentRel : files[0].rel;
    buildModels();
    renderList();
    $('#diff-empty').classList.add('hidden');
    $('#diff-editor').classList.remove('hidden');
    applySelection();
  } catch (e) {
    toast('Diff failed: ' + (e.message || e), 'err');
  } finally {
    refreshing = false;
  }
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
  $('#diff-empty').classList.add('hidden');
  $('#diff-editor').classList.remove('hidden');
  applySelection();
}

function renderEmpty(msg) {
  currentRel = null;
  renderList();
  showMessage(msg || 'No uncommitted changes.');
}

function renderList() {
  const host = $('#diff-files');
  host.innerHTML = '';
  rowEls.clear();
  const head = el('div', 'diff-head');
  head.appendChild(el('span', '', 'Changes'));
  head.appendChild(el('span', 'spacer'));
  const btn = el('button', 'btn small ghost', '⟳');
  btn.id = 'btn-diff-refresh';
  btn.title = 'Re-scan the working tree';
  btn.onclick = () => refresh();
  head.appendChild(btn);
  host.appendChild(head);
  for (const f of files) {
    const row = el('div', 'diff-file' + (f.rel === currentRel ? ' active' : ''));
    row.title = f.path;
    row.appendChild(el('span', 'st git-' + (f.status || '').toLowerCase(), f.status));
    row.appendChild(el('span', 'rel', f.rel));
    const mini = el('span', 'mini', '↗');
    mini.title = 'Open in a tab';
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
