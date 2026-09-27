import { $, el } from './common.js';

// Ctrl+P fuzzy file finder. Index comes from main (recursive walk honoring the
// same ignore list as the tree). Keyboard listener uses CAPTURE so it fires even
// when an xterm terminal has focus.

let rootPath = '';
let onOpen = () => {};
let files = []; // { abs, rel }
let visible = [];
let sel = 0;
let idxLoadedAt = 0;

export function init(root, openFile) {
  rootPath = root;
  onOpen = openFile;
  wire();
}

function fuzzyScore(query, target) {
  // subsequence match with bonuses for consecutive chars and segment starts
  let ti = 0;
  let sc = 0;
  let last = -2;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi].toLowerCase();
    let found = -1;
    for (let t = ti; t < target.length; t++) {
      if (target[t].toLowerCase() === ch) { found = t; break; }
    }
    if (found === -1) return -1;
    const consecutive = found === last + 1;
    const segmentStart = found === 0 || '/._- '.includes(target[found - 1]);
    sc += consecutive ? 3 : segmentStart ? 2 : 1;
    sc -= Math.min(found - ti, 8) * 0.1;
    last = found;
    ti = found + 1;
  }
  return sc - target.length * 0.005; // shorter paths win ties
}

function search(q) {
  if (!q) return files.slice(0, 14);
  const out = [];
  for (const f of files) {
    const s = fuzzyScore(q, f.rel);
    if (s >= 0) out.push({ f, s });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, 14).map(x => x.f);
}

function render() {
  const list = $('#finder-list');
  list.innerHTML = '';
  visible.forEach((f, i) => {
    const item = el('div', 'finder-item' + (i === sel ? ' sel' : ''));
    item.dataset.i = String(i);
    const slash = f.rel.lastIndexOf('/');
    const dir = slash >= 0 ? f.rel.slice(0, slash + 1) : '';
    const name = slash >= 0 ? f.rel.slice(slash + 1) : f.rel;
    item.innerHTML = `<span class="finder-name">${name}</span><span class="finder-dir">${dir}</span>`;
    list.appendChild(item);
  });
  const chosen = list.querySelector('.sel');
  if (chosen) chosen.scrollIntoView({ block: 'nearest' });
}

function move(d) {
  if (!visible.length) return;
  sel = (sel + d + visible.length) % visible.length;
  render();
}

function choose() {
  const f = visible[sel];
  if (!f) return;
  close();
  onOpen(f.abs, f.rel.split('/').pop());
}

function close() {
  $('#finder').classList.add('hidden');
}

async function openPalette() {
  $('#finder').classList.remove('hidden');
  const input = $('#finder-input');
  input.value = '';
  sel = 0;
  input.focus();
  // refresh the index if it's stale (agents change files constantly)
  if (Date.now() - idxLoadedAt > 5000) {
    const abs = await vs.fsFileIndex(rootPath).catch(() => []) || [];
    files = abs.map(p => ({
      abs: p,
      rel: p.slice(rootPath.length).replace(/\\/g, '/').replace(/^\//, ''),
    }));
    idxLoadedAt = Date.now();
  }
  visible = search('');
  render();
}

function wire() {
  // capture: true — must win over xterm's textarea when a terminal has focus
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if ($('#finder').classList.contains('hidden')) openPalette();
      else close();
    }
    if (e.key === 'Escape' && !$('#finder').classList.contains('hidden')) close();
  }, true);

  $('#finder-input').addEventListener('input', (e) => {
    sel = 0;
    visible = search(e.target.value);
    render();
  });
  $('#finder-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    if (e.key === 'Enter') { e.preventDefault(); choose(); }
  });
  $('#finder-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-i]');
    if (item) { sel = +item.dataset.i; choose(); }
  });
  $('#finder').addEventListener('mousedown', (e) => {
    if (e.target === $('#finder')) close();
  });
}
