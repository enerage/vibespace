import { $, el } from './common.js';

let rootPath = '';
let onOpenFile = () => {};
let gitFiles = null; // Map: repo-relative path (forward slashes) -> M|A|U|D
let gitDirs = new Map(); // derived: dir path -> strongest status found under it
const expanded = new Set(); // absolute dir paths currently expanded (persisted)
let activeRel = null; // repo-relative path of the selected file (survives rebuilds)
let rebuildQueued = false;

const GIT_RANK = { U: 1, A: 2, D: 2, M: 3 };

export function init(root, onOpen, savedExpanded) {
  rootPath = root;
  onOpenFile = onOpen;
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
