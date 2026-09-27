import { $, el, toast } from './common.js';

const VS_URL = 'app://local/vendor/monaco-editor/min/vs/';

const LANGS = {
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
const models = new Map(); // path -> {model, saved}
const viewStates = new Map(); // path -> editor view state
let current = null; // {path, name, kind: 'text'|'binary'|'toolarge'}
let editMode = false;
let onStateChange = () => {};

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
    try {
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
    } catch {}
    editor = monaco.editor.create($('#monaco-host'), {
      theme: 'vs-dark',
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
  }, (err) => {
    toast('Monaco failed to load: ' + err, 'err');
  });
}

function wireControls() {
  $('#btn-edit').onclick = () => {
    editMode = !editMode;
    editor.updateOptions({ readOnly: !editMode });
    $('#btn-edit').textContent = editMode ? 'Read-only' : 'Edit';
    $('#btn-edit').classList.toggle('primary', editMode);
    if (editMode && current) toast('Editing enabled — Ctrl+S saves to disk', 'ok');
    updateSaveButton();
  };
  $('#btn-save').onclick = save;
  $('#btn-reveal').onclick = () => { if (current) vs.reveal(current.path); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (editMode) save();
    }
  });
  editor.onDidChangeModelContent(() => updateSaveButton());
  window.addEventListener('resize', () => editor && editor.layout());
}

async function save() {
  if (!current || current.kind !== 'text' || !editMode) return;
  const entry = models.get(current.path);
  if (!entry) return;
  try {
    await vs.fsWrite(current.path, entry.model.getValue());
    entry.saved = entry.model.getValue();
    updateSaveButton();
    toast('Saved ' + current.name, 'ok');
    onStateChange();
  } catch (e) {
    toast('Save failed: ' + (e.message || e), 'err');
  }
}

function updateSaveButton() {
  const entry = current && models.get(current.path);
  const dirty = Boolean(editMode && entry && entry.model.getValue() !== entry.saved);
  $('#btn-save').disabled = !dirty;
}

export async function open(path, name) {
  if (!monaco || !editor) return;
  // keep view state of previous file
  if (current) viewStates.set(current.path, editor.saveViewState());

  let res;
  try {
    res = await vs.fsRead(path);
  } catch (e) {
    toast('Cannot read file: ' + (e.message || e), 'err');
    return;
  }

  $('#viewer-name').textContent = name;
  $('#viewer-path').textContent = path;

  if (res.tooLarge) { showPlaceholder(`File too large to preview (${(res.size / 1048576).toFixed(1)} MB).`); current = { path, name, kind: 'toolarge' }; updateSaveButton(); return; }
  if (res.binary) { showPlaceholder('Binary file — nothing to preview.'); current = { path, name, kind: 'binary' }; updateSaveButton(); return; }
  hidePlaceholder();

  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  let entry = models.get(path);
  if (!entry) {
    const model = monaco.editor.createModel(res.content, LANGS[ext] || 'plaintext', monaco.Uri.parse('file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')));
    entry = { model, saved: res.content };
    models.set(path, entry);
  }
  editor.setModel(entry.model);
  const vs_ = viewStates.get(path);
  if (vs_) editor.restoreViewState(vs_);
  editor.updateOptions({ readOnly: !editMode });
  current = { path, name, kind: 'text' };
  updateSaveButton();
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
