import { $, el, toast, askText } from './common.js';

let rootPath = '';
let onOpenFile = () => {};
let hooks = { onRename: null, onDeleted: null }; // optional, from init ops
let gitFiles = null; // Map: repo-relative path (forward slashes) -> M|A|U|D
let gitDirs = new Map(); // derived: dir path -> strongest status found under it
const expanded = new Set(); // absolute dir paths currently expanded (persisted)
let activeRel = null; // repo-relative path of the selected file (survives rebuilds)
let rebuildQueued = false;

const GIT_RANK = { U: 1, A: 2, D: 2, M: 3 };

export function init(root, onOpen, savedExpanded, ops = {}) {
  rootPath = root;
  onOpenFile = onOpen;
  hooks = {
    onRename: typeof ops.onRename === 'function' ? ops.onRename : null,
    onDeleted: typeof ops.onDeleted === 'function' ? ops.onDeleted : null,
  };
  expanded.clear();
  // first run (no saved list): root expanded; later runs: exactly what was open
  for (const p of (Array.isArray(savedExpanded) ? savedExpanded : [root])) expanded.add(p);
  buildDom();
  refreshGit();
  // keep colors honest while the window is in use; git itself is cached main-side
  setInterval(() => { if (document.hasFocus()) refreshGit(); }, 30000);
  // live refresh: agents and external tools write files constantly
  vs.onTreeChanged(() => queueRebuild());
  window.addEventListener('focus', () => queueRebuild()); // catches watcher gaps

  // drag-and-drop: files dropped on the tree background land in the repo root
  const pane = $('#tree-pane');
  pane.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer.types.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  pane.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropFiles(ev, rootPath);
  });

  // context menu: delegated on the pane so it survives rebuilds. Lives on
  // document.body (NOT inside #tree) for the same reason.
  pane.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.tree-row');
    if (!row) {
      ev.preventDefault();
      showCtxMenu(ev.clientX, ev.clientY, [
        { label: 'New file', run: () => newFileIn(rootPath) },
        { label: 'New folder', run: () => newFolderIn(rootPath) },
      ]);
      return;
    }
    if (!('rel' in row.dataset)) return;
    ev.preventDefault();
    const rel = row.dataset.rel;
    if (row.dataset.dir) {
      const items = [
        { label: 'New file here', run: () => newFileIn(absOf(rel)) },
        { label: 'New folder here', run: () => newFolderIn(absOf(rel)) },
      ];
      if (rel) { // the repo root itself is never renamed or deleted
        items.push({ label: 'Rename', run: () => startRename(rel) });
        items.push({ label: 'Delete', danger: true, run: () => startDelete(rel, true) });
      }
      showCtxMenu(ev.clientX, ev.clientY, items);
    } else {
      showCtxMenu(ev.clientX, ev.clientY, [
        { label: 'New file', run: () => newFileIn(absOf(parentRelOf(rel))) },
        { label: 'Rename', run: () => startRename(rel) },
        { label: 'Delete', danger: true, run: () => startDelete(rel, false) },
      ]);
    }
  });

  // F2 renames the active row — only when nothing else holds focus
  // (inputs, Monaco, xterm all own their key handling)
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'F2' || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey) return;
    if (ctxMenu || activeRel == null) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const row = document.querySelector('#tree .tree-row.active');
    if (!row || row.dataset.dir === undefined || !('rel' in row.dataset) || !row.dataset.rel) return;
    ev.preventDefault();
    startRename(row.dataset.rel);
  });
}

async function dropFiles(ev, destDir) {
  const files = [...ev.dataTransfer.files];
  if (!files.length) return;
  const paths = files.map(f => vs.dropPath(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await vs.fsCopyInto({ sources: paths, destDir }).catch(err => ({ error: String(err) }));
  if (r && r.copied && r.copied.length) {
    toast(`Copied ${r.copied.length} file${r.copied.length > 1 ? 's' : ''} — ${r.copied.join(', ')}`, 'ok');
    // the tree watcher picks the new files up on its own
  } else {
    toast('Nothing was copied', 'err');
  }
}

// Rebuild everything from current disk state, keeping expanded folders, the
// active file, and the scroll position. Debounced: watchers fire in bursts.
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  setTimeout(() => {
    rebuildQueued = false;
    const pane = $('#tree-pane');
    const scroll = pane ? pane.scrollTop : 0;
    buildDom();
    if (pane) pane.scrollTop = scroll;
    refreshGit();
  }, 150);
}

function buildDom() {
  $('#tree').innerHTML = '';
  const host = el('div');
  $('#tree').appendChild(host);
  addDirNode(host, rootPath, rootPath.split(/[\\/]/).pop() || rootPath, expanded.has(rootPath));
  if (activeRel) {
    const row = document.querySelector(`#tree .tree-row[data-rel="${CSS.escape(activeRel)}"]`);
    if (row) row.classList.add('active');
  }
}

export function expandedPaths() { return [...expanded]; }

async function refreshGit() {
  try {
    const files = await vs.gitStatus(rootPath);
    gitFiles = files || null;
    gitDirs = new Map();
    if (gitFiles) {
      for (const [rel, st] of gitFiles) {
        const parts = rel.split('/');
        parts.pop();
        let acc = '';
        for (const part of parts) {
          acc = acc ? acc + '/' + part : part;
          if (GIT_RANK[st] > GIT_RANK[gitDirs.get(acc) || '']) gitDirs.set(acc, st);
        }
      }
    }
    applyGitClasses();
  } catch {
    gitFiles = null;
  }
}

function relOf(absPath) {
  return absPath.slice(rootPath.length).replace(/\\/g, '/').replace(/^\//, '');
}

function applyGitClasses() {
  if (!gitFiles) return;
  for (const row of document.querySelectorAll('#tree .tree-row[data-rel]')) {
    const st = gitFiles.get(row.dataset.rel) || gitDirs.get(row.dataset.rel);
    row.classList.toggle('git-m', st === 'M');
    row.classList.toggle('git-a', st === 'A');
    row.classList.toggle('git-u', st === 'U');
    row.classList.toggle('git-d', st === 'D');
  }
}

async function addDirNode(container, dirPath, name, expandedHere) {
  const row = el('div', 'tree-row');
  row.dataset.rel = relOf(dirPath);
  row.dataset.dir = '1';
  row.innerHTML = `<span class="caret">${expandedHere ? '▾' : '▸'}</span>📁 <span class="tree-name">${escape(name)}</span>`;
  const children = el('div', 'tree-children');
  if (!expandedHere) children.classList.add('hidden');
  container.append(row, children);

  const loadOnce = async () => {
    if (children.dataset.loaded) return;
    children.dataset.loaded = '1';
    const { entries } = await vs.fsList(dirPath);
    for (const entry of entries) {
      if (entry.dir) {
        await addDirNode(children, entry.path, entry.name, expanded.has(entry.path));
      } else {
        const frow = el('div', 'tree-row');
        frow.dataset.rel = relOf(entry.path);
        frow.innerHTML = `<span class="caret"></span>${icon(entry.name)}<span class="tree-name">${escape(entry.name)}</span>`;
        frow.onclick = (ev) => {
          ev.stopPropagation();
          markActive(frow);
          onOpenFile(entry.path, entry.name);
        };
        children.appendChild(frow);
      }
    }
    applyGitClasses();
  };

  row.onclick = async (ev) => {
    ev.stopPropagation();
    if (!children.dataset.loaded) {
      await loadOnce();
      children.classList.remove('hidden');
      row.querySelector('.caret').textContent = '▾';
      expanded.add(dirPath);
      return;
    }
    const hidden = children.classList.toggle('hidden');
    row.querySelector('.caret').textContent = hidden ? '▸' : '▾';
    if (hidden) expanded.delete(dirPath);
    else expanded.add(dirPath);
  };

  // drag-and-drop target: copy dropped files into THIS folder
  row.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer.types.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    row.classList.add('droptarget');
  });
  row.addEventListener('dragleave', () => row.classList.remove('droptarget'));
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation(); // folder wins over the pane-background root drop
    row.classList.remove('droptarget');
    dropFiles(ev, dirPath);
  });

  if (expandedHere) await loadOnce();
}

function markActive(row) {
  for (const r of document.querySelectorAll('.tree-row.active')) r.classList.remove('active');
  row.classList.add('active');
  activeRel = row.dataset.rel || null;
}

function icon(name) {
  const m = name.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toLowerCase() : '';
  return `<span class="ficon ext-${ext}">${ext ? ext.slice(0, 3) : '·'}</span>`;
}

function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- context menu + file operations ----------

// rows store repo-relative paths (forward slashes); join with '/' for fs calls
// (Node accepts that on Windows). expanded keys, though, come from fsList
// (path.join → backslashes), so record both join forms when expanding.
function absOf(rel) { return rel ? rootPath + '/' + rel : rootPath; }
function nameOf(rel) { return rel.split('/').pop(); }
function parentRelOf(rel) { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }
function expandDir(dirAbs) {
  expanded.add(dirAbs);
  expanded.add(dirAbs.replace(/\//g, '\\'));
}

let ctxMenu = null;

function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = el('div', 'ctx-menu');
  for (const it of items) {
    const item = el('div', 'ctx-item' + (it.danger ? ' danger' : ''), it.label);
    item.onclick = (ev) => { ev.stopPropagation(); closeCtxMenu(); it.run(); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  ctxMenu = menu;
  const r = menu.getBoundingClientRect(); // keep it on screen
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  // close on any outside click / Esc / window blur / resize / scroll
  window.addEventListener('mousedown', ctxCloser, true);
  window.addEventListener('keydown', ctxCloser, true);
  window.addEventListener('blur', ctxCloser);
  window.addEventListener('resize', ctxCloser);
  window.addEventListener('scroll', ctxCloser, true);
}

function ctxCloser(ev) {
  if (!ctxMenu) return;
  if (ev.type === 'keydown' && ev.key !== 'Escape') return;
  if (ev.type === 'mousedown' && ctxMenu.contains(ev.target)) return; // let item clicks run
  closeCtxMenu();
}

function closeCtxMenu() {
  if (!ctxMenu) return;
  const m = ctxMenu;
  ctxMenu = null;
  m.remove();
  window.removeEventListener('mousedown', ctxCloser, true);
  window.removeEventListener('keydown', ctxCloser, true);
  window.removeEventListener('blur', ctxCloser);
  window.removeEventListener('resize', ctxCloser);
  window.removeEventListener('scroll', ctxCloser, true);
}

async function newFileIn(dirAbs) {
  const name = await askText('New file', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('File name cannot be empty', 'err'); return; }
  try {
    const res = await vs.fsCreate(dirAbs, trimmed);
    expandDir(dirAbs);
    queueRebuild(); // watcher also fires (~700ms); this makes it near-immediate
    onOpenFile(res.path, trimmed);
  } catch (e) {
    toast('New file failed: ' + (e.message || e), 'err');
  }
}

async function newFolderIn(dirAbs) {
  const name = await askText('New folder', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('Folder name cannot be empty', 'err'); return; }
  try {
    await vs.fsMkdir(dirAbs, trimmed);
    expandDir(dirAbs + '/' + trimmed);
    queueRebuild();
  } catch (e) {
    toast('New folder failed: ' + (e.message || e), 'err');
  }
}

async function startRename(rel) {
  const name = nameOf(rel);
  const abs = absOf(rel);
  const base = abs.slice(0, abs.length - name.length); // abs ends with the name
  const next = await askText('Rename', name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) { toast('Name cannot be empty', 'err'); return; }
  if (trimmed === name) return;
  try {
    const to = base + trimmed;
    await vs.fsRename(abs, to);
    if (hooks.onRename) hooks.onRename(abs, to);
    queueRebuild();
  } catch (e) {
    toast('Rename failed: ' + (e.message || e), 'err');
  }
}

async function startDelete(rel, isDir) {
  const name = nameOf(rel);
  const abs = absOf(rel);
  const msg = isDir
    ? `Delete folder "${name}" and everything inside it? (moved to Recycle Bin)`
    : `Delete "${name}"? (moved to Recycle Bin)`;
  if (!window.confirm(msg)) return;
  try {
    await vs.fsDelete(abs);
    if (hooks.onDeleted) hooks.onDeleted(abs);
    queueRebuild();
  } catch (e) {
    toast('Delete failed: ' + (e.message || e), 'err');
  }
}
