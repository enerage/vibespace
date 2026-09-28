import { $, el, toast } from './common.js';
import { onMonaco, LANGS } from './viewer.js';
import { monacoTheme, onThemeChange } from './themes.js';

// Git diff review pane (the pinned "Changes" tab). Read-only side-by-side diff
// of uncommitted work. Diff models live under git:///HEAD/<rel> and
// file:///diff-wt/<rel> URIs so they can never collide with — and are never
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

export function init(repo, open) {
  repoPath = repo;
  openFile = open || (() => {});
  onMonaco((m) => {
    monacoRef = m;
    onThemeChange((t) => { try { diffEditor?.updateOptions({ theme: t.monaco }); } catch {} });
    if (wantEditor) createEditor();
    if (files.length) { buildModels(); renderList(); applySelection(); } // refreshed before Monaco landed
  });
}

export function show() {
  $('#diff-host').classList.remove('hidden');
  wantEditor = true;
  if (monacoRef && !diffEditor) createEditor();
  refresh();
}

export function hide() {
  $('#diff-host').classList.add('hidden');
}

export async function refresh() {
  if (!repoPath || refreshing) return;
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
  applySelection();
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
  if (!diffEditor || !currentRel) return;
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
  $('#diff-empty p').textContent = msg || 'No uncommitted changes.';
  $('#diff-empty').classList.remove('hidden');
  $('#diff-editor').classList.add('hidden');
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
