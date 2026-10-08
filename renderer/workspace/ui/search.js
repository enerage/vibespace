import { $, el, debounce, fileIcon } from './common.js';

// Search tab of the left pane (Files | Git | Search), also Ctrl+Shift+F.
// main/textsearch.cjs runs `git grep` in this window's repo (a bounded walk for
// non-git folders) and returns hits grouped by file. Every result is built with
// text nodes, never innerHTML, so file content can't inject markup.
// The query and toggles live in this module: kept per window until it reloads.

let cb = { show: () => {}, openAt: () => {}, focusTerminal: () => {}, selection: () => '' };
const opts = { caseSensitive: false, wholeWord: false, regex: false };
let seq = 0;                 // newest request; older replies are dropped
let shownKey = '';           // query + toggles of the results on screen
const collapsed = new Set(); // file rels folded by the user (reset per query)
let lastHitText = null;      // the selection a hit click made (not a prefill)
let activeRow = null;

const keyOf = (q) => JSON.stringify([q, opts.caseSensitive, opts.wholeWord, opts.regex]);

export function init(callbacks) {
  cb = { ...cb, ...callbacks };
  const input = $('#search-input');
  const later = debounce(() => run(), 300);
  input.addEventListener('input', later);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run({ force: true }); }
  });
  for (const b of document.querySelectorAll('#search-toggles button')) {
    b.onclick = () => {
      opts[b.dataset.opt] = !opts[b.dataset.opt];
      b.classList.toggle('active', opts[b.dataset.opt]);
      run();
      input.focus();
    };
  }
  // Esc anywhere in the pane hands the keyboard back to the active terminal
  $('#search-side').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cb.focusTerminal(); }
  });
  // capture + stopPropagation: neither xterm nor Monaco may also act on it
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
    }
  }, true);
}

// Ctrl+Shift+F: show the pane, prefill from the preview's selection, focus
function openSearch() {
  const sel = cb.selection() || '';
  const input = $('#search-input');
  cb.show();
  if (sel && sel !== lastHitText && sel.length <= 200) {
    input.value = sel;
    run();
  }
  focusInput();
}

// the Search tab was clicked (or opened by the shortcut)
export function focusInput() {
  const input = $('#search-input');
  input.focus();
  input.select();
}

async function run({ force = false } = {}) {
  const q = $('#search-input').value;
  const key = keyOf(q);
  if (!force && key === shownKey) return;
  const my = ++seq;
  if (key !== shownKey) collapsed.clear();
  if (!q) {
    shownKey = key;
    renderEmpty('');
    return;
  }
  setSummary('Searching…', 'busy');
  let r;
  try {
    r = await vs.searchText({ query: q, ...opts });
  } catch (e) {
    r = { error: String(e.message || e) };
  }
  if (my !== seq || (r && r.aborted)) return; // a newer search owns the pane
  shownKey = key;
  if (!r) return renderEmpty('Search is not available for this workspace.', 'err');
  if (r.error) return renderEmpty(r.error, 'err');
  render(r);
}

function setSummary(text, kind = '') {
  const s = $('#search-summary');
  s.className = kind;
  s.textContent = text;
}

function renderEmpty(msg, kind) {
  $('#search-results').replaceChildren();
  activeRow = null;
  setSummary(msg, kind);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function render(r) {
  if (!r.files.length) {
    renderEmpty(r.timedOut ? 'No results before the search timed out.' : 'No results.');
    return;
  }
  const parts = [`${plural(r.hitCount, 'result')} in ${plural(r.fileCount, 'file')}`];
  if (r.timedOut) parts.push('timed out — showing what was found');
  else if (r.truncated) parts.push(`showing first ${r.hitCount} — refine the search`);
  setSummary(parts.join(' · '), r.truncated || r.timedOut ? 'warn' : '');
  const frag = document.createDocumentFragment();
  for (const f of r.files) frag.appendChild(fileGroup(f));
  activeRow = null;
  $('#search-results').replaceChildren(frag);
}

function fileGroup(f) {
  const group = el('div', 'search-group' + (collapsed.has(f.rel) ? ' collapsed' : ''));
  const head = el('div', 'search-file');
  head.title = f.rel;
  const slash = f.rel.lastIndexOf('/');
  const name = f.rel.slice(slash + 1);
  head.appendChild(el('span', 'tw', '▾'));
  head.insertAdjacentHTML('beforeend', fileIcon(name)); // label = [a-z0-9] extension only
  head.appendChild(el('span', 'name', name));
  head.appendChild(el('span', 'dir', slash > 0 ? f.rel.slice(0, slash) : ''));
  head.appendChild(el('span', 'count', String(f.hits.length)));
  head.onclick = () => {
    const fold = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed', fold);
    if (fold) collapsed.add(f.rel); else collapsed.delete(f.rel);
  };
  group.appendChild(head);
  const hits = el('div', 'search-hits');
  for (const h of f.hits) hits.appendChild(hitRow(f, name, h));
  group.appendChild(hits);
  return group;
}

function hitRow(f, name, h) {
  const row = el('div', 'search-hit');
  row.title = `${f.rel}:${h.line}:${h.col}`;
  row.appendChild(el('span', 'ln', String(h.line)));
  const txt = el('span', 'txt');
  // leading indentation is noise in a narrow pane, and a match far into the
  // line would sit behind the ellipsis: start a little before it instead
  let lead = h.text.length - h.text.replace(/^\s+/, '').length;
  const first = h.ranges && h.ranges[0] ? h.ranges[0][0] : 0;
  if (first - lead > 24) {
    lead = first - 12;
    txt.appendChild(document.createTextNode('…'));
  }
  let at = lead;
  for (const [s, e] of h.ranges || []) {
    if (e <= at) continue;
    const start = Math.max(s, at);
    if (start > at) txt.appendChild(document.createTextNode(h.text.slice(at, start)));
    txt.appendChild(el('mark', '', h.text.slice(start, e)));
    at = e;
  }
  if (at < h.text.length) txt.appendChild(document.createTextNode(h.text.slice(at)));
  row.appendChild(txt);
  row.onclick = async () => {
    if (activeRow) activeRow.classList.remove('active');
    activeRow = row;
    row.classList.add('active');
    await cb.openAt(f.path, name, h.line, h.col, h.len);
    lastHitText = cb.selection() || null;
  };
  return row;
}
