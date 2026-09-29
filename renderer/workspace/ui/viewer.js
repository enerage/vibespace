import { $, el, toast, debounce, confirmBox } from './common.js';
import { monacoTheme, onThemeChange } from './themes.js';

const VS_URL = 'app://local/vendor/monaco-editor/min/vs/';

export const LANGS = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', svg: 'xml', xml: 'xml',
  py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  sql: 'sql', yml: 'yaml', yaml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'bat',
  txt: 'plaintext', env: 'plaintext', gitignore: 'plaintext', dockerfile: 'dockerfile',
};

let monaco = null;
let editor = null;
const tabs = new Map(); // path -> {name, kind, model?, saved?, editable, message?, el}
const viewStates = new Map(); // path -> editor view state
let activePath = null;
let onStateChange = () => {};
let pendingRestore = null; // restore() args stashed until Monaco finishes loading
let monacoWaiters = [];    // onMonaco() callbacks flushed once the AMD module lands
let pinnedEl = null;       // pinned pseudo-tab ("Changes") — persists across renderTabs() rebuilds
let pinnedOn = false;
let pinnedToggle = null;

export function init(cb) {
  onStateChange = cb || onStateChange;
  window.MonacoEnvironment = {
    getWorkerUrl: () => URL.createObjectURL(new Blob(
      [`self.MonacoEnvironment={baseUrl:'${VS_URL}'};importScripts('${VS_URL}base/worker/workerMain.js');`],
      { type: 'text/javascript' }
    )),
  };
  window.require.config({ paths: { vs: VS_URL } });
  window.require(['vs/editor/editor.main'], (m) => {
    monaco = m;
    // theme switches flip the Monaco base live (the diff editor follows via diff.js)
    onThemeChange((t) => { try { editor?.updateOptions({ theme: t.monaco }); } catch {} });
    try {
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
    } catch {}
    editor = monaco.editor.create($('#monaco-host'), {
      theme: monacoTheme(),
      readOnly: true,
      minimap: { enabled: true, maxColumn: 80 },
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderWhitespace: 'none',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
    });
    wireControls();
    cb && cb();
    if (pendingRestore) {
      const { files, active } = pendingRestore;
      pendingRestore = null;
      restore(files, active);
    }
    for (const cb of monacoWaiters.splice(0)) cb(monaco);
  }, (err) => {
    toast('Monaco failed to load: ' + err, 'err');
  });
}

function wireControls() {
  $('#btn-edit').onclick = () => {
    const t = tabs.get(activePath);
    if (!t || t.kind !== 'text') return;
    t.editable = !t.editable;
    editor.updateOptions({ readOnly: !t.editable });
    refreshEditButton(t);
    if (t.editable) toast('Editing enabled — Ctrl+S saves to disk', 'ok');
    updateSaveButton();
  };
  $('#btn-save').onclick = save;
  $('#btn-reveal').onclick = () => { if (tabs.has(activePath)) vs.reveal(activePath); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const t = tabs.get(activePath);
      if (t && t.editable) save();
    }
  });
  // keystrokes update button + tab dot only — no onStateChange there
  editor.onDidChangeModelContent(() => {
    const t = tabs.get(activePath);
    if (!t || !t.model || editor.getModel() !== t.model) return;
    updateSaveButton();
    updateTabDot(t);
  });
  window.addEventListener('resize', () => editor && editor.layout());
}

async function save() {
  const t = tabs.get(activePath);
  if (!t || t.kind !== 'text' || !t.editable) return;
  try {
    const content = t.model.getValue();
    await vs.fsWrite(activePath, content);
    t.saved = content;
    updateSaveButton();
    updateTabDot(t);
    toast('Saved ' + t.name, 'ok');
    onStateChange();
  } catch (e) {
    toast('Save failed: ' + (e.message || e), 'err');
  }
}

function refreshEditButton(t) {
  const on = Boolean(t && t.editable);
  $('#btn-edit').textContent = on ? 'Read-only' : 'Edit';
  $('#btn-edit').classList.toggle('primary', on);
}

function updateSaveButton() {
  const t = tabs.get(activePath);
  const dirty = Boolean(t && t.editable && t.model && t.model.getValue() !== t.saved);
  $('#btn-save').disabled = !dirty;
}

// dot-only refresh — content changes are frequent, no full tab re-render per keystroke
function updateTabDot(t) {
  if (!t.el) return;
  const dirty = Boolean(t.model && t.model.getValue() !== t.saved);
  t.el.querySelector('.dot').classList.toggle('hidden', !dirty);
}

// full rebuild is fine at this scale (open/close/switch/rename only)
function renderTabs() {
  const host = $('#file-tabs');
  host.innerHTML = '';
  for (const [path, t] of tabs) {
    const tab = el('div', 'ftab' + (path === activePath ? ' active' : ''));
    tab.title = path;
    tab.appendChild(el('span', 'label', t.name));
    const dot = el('span', 'dot');
    if (!(t.model && t.model.getValue() !== t.saved)) dot.classList.add('hidden');
    tab.appendChild(dot);
    const close = el('span', 'close', '×');
    close.onclick = (e) => { e.stopPropagation(); closeTab(path); };
    tab.appendChild(close);
    tab.onclick = () => activate(path);
    tab.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); }; // no middle-click autoscroll
    tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(path); } };
    t.el = tab;
    host.appendChild(tab);
  }
  if (pinnedEl) host.appendChild(pinnedEl); // same node survives every rebuild
}

export async function open(path, name, { quiet = false } = {}) {
  if (!monaco || !editor) return;
  const existing = tabs.get(path);
  if (existing) {
    if (name) existing.name = name;
    activate(path);
    renderTabs();
    return;
  }

  let res;
  try {
    res = await vs.fsRead(path);
  } catch (e) {
    if (!quiet) toast('Cannot read file: ' + (e.message || e), 'err');
    return;
  }

  const t = { name, kind: 'text', editable: false, el: null };
  if (res.tooLarge) {
    t.kind = 'toolarge';
    t.message = `File too large to preview (${(res.size / 1048576).toFixed(1)} MB).`;
  } else if (res.binary) {
    t.kind = 'binary';
    t.message = 'Binary file — nothing to preview.';
  } else {
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    t.model = monaco.editor.createModel(res.content, LANGS[ext] || 'plaintext', monaco.Uri.parse('file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')));
    t.saved = res.content;
  }
  tabs.set(path, t);
  activate(path);
  renderTabs();
}

// file:line links from the terminal — open, then jump (the reveal after
// activate's viewState restore is what wins, so no special-casing needed)
export async function openAt(path, name, line) {
  await open(path, name);
  const t = tabs.get(path);
  if (!t || t.kind !== 'text' || !t.model || !line) return;
  const ln = Math.max(1, Math.min(line, t.model.getLineCount()));
  editor.revealLineInCenter(ln);
  editor.setPosition({ lineNumber: ln, column: 1 });
  editor.focus();
}

function activate(path) {
  const t = tabs.get(path);
  if (!t) return;
  if (pinnedOn) togglePinned(false); // opening a file tab hands the viewer back to Monaco
  // keep view state of the outgoing file
  if (activePath && activePath !== path && tabs.has(activePath)) viewStates.set(activePath, editor.saveViewState());
  activePath = path;
  $('#viewer-name').textContent = t.name;
  $('#viewer-path').textContent = path;

  if (t.kind === 'text' && t.model) {
    hidePlaceholder();
    editor.setModel(t.model);
    const vs_ = viewStates.get(path);
    if (vs_) editor.restoreViewState(vs_);
    editor.updateOptions({ readOnly: !t.editable });
  } else {
    editor.setModel(null);
    showPlaceholder(t.message || 'Binary file — nothing to preview.');
  }
  refreshEditButton(t);
  updateSaveButton();
  onStateChange();
}

function showEmptyState() {
  togglePinned(false); // no-op unless the Changes pane is up
  activePath = null;
  $('#viewer-name').textContent = 'pick a file to preview';
  $('#viewer-path').textContent = '';
  editor.setModel(null);
  const ph = $('#viewer-placeholder');
  ph.innerHTML = '';
  ph.appendChild(el('p', '', 'Open a file from the tree.'));
  ph.appendChild(el('p', 'dim', 'Editing is off by default — hit Edit for a quick fix, Ctrl+S saves.'));
  ph.classList.remove('hidden');
  $('#monaco-host').style.visibility = 'hidden';
  refreshEditButton(null);
  updateSaveButton();
}

export function closeTab(path, { force } = {}) {
  const t = tabs.get(path);
  if (!t) return;
  if (!force && t.model && t.model.getValue() !== t.saved) {
    // async confirm (never window.confirm — see common.js confirmBox): re-enter
    // with force once the user agrees
    confirmBox(`${t.name} has unsaved changes. Close anyway?`, { ok: 'Close without saving', danger: true })
      .then((ok) => { if (ok) closeTab(path, { force: true }); });
    return;
  }
  const wasActive = path === activePath;
  const order = [...tabs.keys()];
  const idx = order.indexOf(path);
  tabs.delete(path);
  viewStates.delete(path);
  if (t.model) t.model.dispose();
  t.el = null;
  if (wasActive) {
    const next = order[idx + 1] || order[idx - 1]; // successor after the closed slot, else predecessor
    if (next) activate(next); else showEmptyState();
  }
  renderTabs();
  onStateChange();
}

export function renameTab(oldPath, newPath) {
  const t = tabs.get(oldPath);
  if (!t) return;
  t.name = newPath.split(/[\\/]/).pop();
  // rekey in place so the tab keeps its position
  const entries = [...tabs.entries()].map(([k, v]) => (k === oldPath ? [newPath, t] : [k, v]));
  tabs.clear();
  for (const [k, v] of entries) tabs.set(k, v);
  const vs_ = viewStates.get(oldPath);
  if (vs_) { viewStates.delete(oldPath); viewStates.set(newPath, vs_); }
  if (activePath === oldPath) {
    activePath = newPath;
    $('#viewer-name').textContent = t.name;
    $('#viewer-path').textContent = newPath;
  }
  renderTabs();
  onStateChange();
}

// tree watcher fired — refresh open files from disk (never clobber unsaved edits)
export const onFilesChanged = debounce(async () => {
  for (const [path, t] of [...tabs]) {
    if (!t.model || t.model.getValue() !== t.saved) continue;
    try {
      const res = await vs.fsRead(path);
      if (res.tooLarge || res.binary || res.content === t.saved) continue;
      const wasActive = path === activePath;
      const st = wasActive ? editor.saveViewState() : null;
      t.model.setValue(res.content);
      t.saved = res.content;
      if (wasActive) editor.restoreViewState(st); // don't visibly jump the active editor
      updateSaveButton();
      updateTabDot(t);
    } catch {
      closeTab(path, { force: true }); // file vanished from disk — close silently
    }
  }
}, 300);

export function snapshot() {
  const openFiles = [...tabs.entries()].map(([path, t]) => ({ path, name: t.name, kind: t.kind }));
  return { openFiles, activePath: tabs.has(activePath) ? activePath : null };
}

export async function restore(files, active) {
  if (!monaco || !editor) { pendingRestore = { files: files || [], active: active || null }; return; }
  for (const f of files || []) {
    if (!f || !f.path || tabs.has(f.path)) continue;
    await open(f.path, f.name || f.path.split(/[\\/]/).pop(), { quiet: true }); // vanished files skip silently
  }
  if (active && tabs.has(active) && active !== activePath) activate(active);
}

function showPlaceholder(msg) {
  const ph = $('#viewer-placeholder');
  ph.innerHTML = '';
  ph.appendChild(el('p', '', msg));
  ph.classList.remove('hidden');
  $('#monaco-host').style.visibility = 'hidden';
}

function hidePlaceholder() {
  $('#viewer-placeholder').classList.add('hidden');
  $('#monaco-host').style.visibility = 'visible';
}

// ---- pinned pseudo-tab (git diff "Changes" pane) ----
// Lives OUTSIDE the tabs Map: renderTabs() re-appends the same node after each
// rebuild, and activate()/showEmptyState() force it off so a real file always
// restores #monaco-host. snapshot/restore never see it.

export function onMonaco(cb) {
  if (monaco) cb(monaco);
  else monacoWaiters.push(cb);
}

export function setPinnedTab(label, onToggle) {
  pinnedToggle = onToggle || null;
  pinnedEl = el('div', 'ftab pinned');
  pinnedEl.title = 'Diff view — the file you last clicked in the Git sidebar (left pane → Git)';
  pinnedEl.appendChild(el('span', 'label', label));
  pinnedEl.onclick = () => togglePinned();
  renderTabs();
}

export function showChangesTab() {
  if (pinnedEl) togglePinned(true);
}

export function changesTabOn() { return pinnedOn; }

export function toggleChangesTab() {
  if (!pinnedEl) return; // setPinnedTab never called — nothing to toggle
  togglePinned();
}

function togglePinned(force) {
  const on = force === undefined ? !pinnedOn : Boolean(force);
  if (on === pinnedOn) return;
  pinnedOn = on;
  if (pinnedEl) pinnedEl.classList.toggle('active', on);
  if (on) {
    // the diff pane owns the viewer area. display:none, not just visibility —
    // a visibility-hidden flex child still claims half the pane.
    $('#monaco-host').style.display = 'none';
    $('#monaco-host').style.visibility = 'hidden';
    $('#viewer-placeholder').classList.add('hidden');
  } else {
    restoreViewerVisibility();
  }
  if (pinnedToggle) pinnedToggle(on);
}

// un-pin: put the viewer back exactly as the active tab (or empty state) wants
function restoreViewerVisibility() {
  const t = activePath ? tabs.get(activePath) : null;
  $('#monaco-host').style.display = '';
  if (t && t.kind === 'text' && t.model) {
    $('#viewer-placeholder').classList.add('hidden');
    $('#monaco-host').style.visibility = 'visible';
  } else if (t) {
    showPlaceholder(t.message || 'Binary file — nothing to preview.');
  } else {
    $('#monaco-host').style.visibility = 'hidden';
    $('#viewer-placeholder').classList.remove('hidden'); // still holds the empty-state text
  }
}
