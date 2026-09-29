import { $, el, toast } from './common.js';

// History mode of the git pane: paged commit list (search, per-file filter),
// drill-down into one commit (message + changed files), and each file's
// before/after in the shared diff editor (diff.js owns it — we hand it pairs).
// Read-only: nothing here writes to the repo.

const PAGE = 150;

let showPair = () => {};   // diff.js: (key, original, modified, rel) → editor
let showEmpty = () => {};  // diff.js: (msg) → centered placeholder
let openFile = () => {};

let commits = [];
let unpushed = new Set();
let more = false;
let loading = false;
let query = '';
let pathFilter = null;     // { rel, dir } — file/folder history
let detail = null;         // commit payload while drilled in
let currentFile = null;    // rel of the file shown in the editor
let loadedOnce = false;
let dirty = false;         // filter changed while hidden — reload on activate
let lastHead = null;       // branch oid when we last loaded — reload on change
let listSeq = 0;           // drops out-of-order list responses (fast typing, filters)
let detailSeq = 0;         // same for commit/file loads
let searchInput = null;

export function init({ pair, empty, open }) {
  showPair = pair;
  showEmpty = empty;
  openFile = open || openFile;
  // the search box is built once and never re-rendered — rebuilding it on every
  // list refresh would steal focus mid-typing
  const host = $('#hist-list');
  const bar = el('div', 'hist-bar hist-search-bar');
  searchInput = el('input', 'hist-search');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search commit messages…';
  searchInput.spellcheck = false;
  let t;
  searchInput.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { query = searchInput.value.trim(); reload(); }, 250);
  };
  bar.appendChild(searchInput);
  host.appendChild(bar);
  host.appendChild(el('div', '', '')).id = 'hist-items';
}

// entering History mode (or re-entering): first time loads, later keeps the
// list DOM (and its drill-down) exactly as it was left
export function activate() {
  if (!loadedOnce || dirty) { dirty = false; return reload(); }
  if (detail && currentFile) selectFile(detail.files.find((f) => f.rel === currentFile));
  else if (!detail) showEmpty('Pick a commit to see what it changed.');
}

// branch chip saw HEAD move (agent committed / pulled / switched): refresh the
// list in place; an open commit detail stays open
export function headMoved(oid) {
  if (oid === lastHead) return;
  const had = lastHead !== null;
  lastHead = oid;
  if (had && loadedOnce) reload({ keepDetail: true });
}

export function hasFilter() { return Boolean(pathFilter); }

// f: null = whole repo, {rel, dir} = file/folder history. Applied on the next
// activate() — the caller decides when the pane shows.
export function setFilter(f) {
  pathFilter = f && f.rel ? { rel: f.rel, dir: Boolean(f.dir) } : null;
  detail = null;
  currentFile = null;
  dirty = true;
}

function reload({ keepDetail = false } = {}) {
  if (!keepDetail) { detail = null; currentFile = null; }
  return loadPage(true);
}

// reset=true starts over (supersedes any in-flight load); false = next page
async function loadPage(reset = false) {
  if (loading && !reset) return;
  loading = true;
  const seq = ++listSeq;
  const skip = reset ? 0 : commits.length;
  if (!detail) render();
  try {
    const r = await vs.gitLog({
      skip, limit: PAGE, query,
      path: pathFilter ? pathFilter.rel : '',
      follow: pathFilter ? !pathFilter.dir : false,
    });
    if (seq !== listSeq) return;
    loadedOnce = true;
    if (!r) { commits = []; more = false; notRepo = true; showEmpty('Not a git repository.'); return; }
    notRepo = false;
    commits = reset ? r.commits : commits.concat(r.commits);
    markSeen();
    unpushed = new Set(r.unpushed);
    more = r.more;
    if (!detail) showEmpty(commits.length ? 'Pick a commit to see what it changed.' : 'No commits yet.');
  } catch (e) {
    toast('History failed: ' + (e.message || e), 'err');
  } finally {
    if (seq === listSeq) {
      loading = false;
      if (!detail) render();
    }
  }
}

// ---------- rendering ----------

let notRepo = false;

// "new since you last looked": the newest sha seen is remembered per repo;
// commits above it get a dot for the rest of this window's life. Only the
// unfiltered, unsearched list moves the marker.
let seenAtOpen;            // undefined = not read yet; null = never looked before
function seenKey() { return 'vs.hist.seen.' + repoRoot.toLowerCase(); }
function markSeen() {
  if (query || pathFilter || !commits.length) return;
  if (seenAtOpen === undefined) seenAtOpen = localStorage.getItem(seenKey());
  localStorage.setItem(seenKey(), commits[0].sha);
}

function render() {
  const host = $('#hist-items');
  host.innerHTML = '';
  $('.hist-search-bar').classList.toggle('hidden', Boolean(detail));
  if (detail) return renderDetail(host);

  if (pathFilter) {
    const chip = el('div', 'hist-filter');
    chip.appendChild(el('span', 'lbl', (pathFilter.dir ? 'Folder: ' : 'File: ') + pathFilter.rel));
    const x = el('span', 'x', '✕');
    x.title = 'Show the whole repository history';
    x.onclick = () => { setFilter(null); activate(); };
    chip.appendChild(x);
    host.appendChild(chip);
  }

  if (notRepo) { host.appendChild(el('div', 'hist-note', 'Not a git repository.')); return; }
  if (!commits.length && !loading) {
    host.appendChild(el('div', 'hist-note', query ? 'No commits match.' : 'No commits yet.'));
    return;
  }

  // dots need the seen sha to actually be in the loaded list — otherwise
  // (history rewritten, very old marker) nothing is marked rather than everything
  const cut = !query && !pathFilter && seenAtOpen ? commits.findIndex((c) => c.sha === seenAtOpen) : -1;
  commits.forEach((c, i) => host.appendChild(commitRow(c, i < cut)));
  if (loading) host.appendChild(el('div', 'hist-note', 'Loading…'));
  else if (more) {
    const btn = el('button', 'btn small ghost hist-more', 'Load older commits');
    btn.onclick = () => loadPage();
    host.appendChild(btn);
  }
}

function commitRow(c, fresh) {
  const row = el('div', 'hist-row' + (c.parents.length > 1 ? ' merge' : ''));
  row.title = `${c.subject}\n${c.short} · ${c.author}${c.agent ? ' + Claude' : ''} · ${new Date(c.time).toLocaleString()}`;
  const subj = el('div', 'hist-subj');
  if (fresh) {
    const dot = el('span', 'hist-new');
    dot.title = 'New since you last looked';
    subj.appendChild(dot);
  }
  if (unpushed.has(c.sha)) {
    const up = el('span', 'hist-unpushed', '↑');
    up.title = 'Not pushed yet';
    subj.appendChild(up);
  }
  subj.appendChild(el('span', 'txt', c.subject || '(no message)'));
  row.appendChild(subj);
  const meta = el('div', 'hist-meta');
  meta.appendChild(el('span', 'sha', c.short));
  meta.appendChild(el('span', '', ago(c.time)));
  meta.appendChild(el('span', 'who', c.author));
  if (c.agent) {
    const a = el('span', 'hist-agent', 'agent');
    a.title = 'Co-authored by Claude (commit trailer)';
    meta.appendChild(a);
  }
  row.appendChild(meta);
  const refs = refPills(c.refs);
  if (refs) row.appendChild(refs);
  row.onclick = () => openCommit(c.sha);
  return row;
}

function refPills(refs) {
  if (!refs || !refs.length) return null;
  const box = el('div', 'hist-refs');
  for (const r of refs) {
    const head = r.startsWith('HEAD -> ');
    const name = head ? r.slice(8) : r.replace(/^tag: /, '');
    const cls = head ? 'head' : r.startsWith('tag: ') ? 'tag' : r.includes('/') ? 'remote' : 'local';
    if (r === 'HEAD') continue; // detached marker — the chip says so already
    box.appendChild(el('span', 'hist-ref ' + cls, name));
  }
  return box.childElementCount ? box : null;
}

async function openCommit(sha) {
  const seq = ++detailSeq;
  const c = await vs.gitCommit(sha).catch(() => null);
  if (seq !== detailSeq) return;
  if (!c) { toast('Could not read that commit', 'err'); return; }
  detail = c;
  currentFile = null;
  render();
  const first = pathFilter && !pathFilter.dir
    ? c.files.find((f) => f.rel === pathFilter.rel || f.from === pathFilter.rel) || c.files[0]
    : c.files[0];
  if (first) selectFile(first, true); // the user clicked a commit → show its first file
  else showEmpty('This commit changes no files (empty or merge-only).');
}

function renderDetail(host) {
  const c = detail;
  const top = el('div', 'hist-bar');
  const back = el('button', 'btn small ghost', '← All commits');
  back.onclick = () => { detailSeq++; detail = null; currentFile = null; render(); showEmpty('Pick a commit to see what it changed.'); };
  top.appendChild(back);
  host.appendChild(top);

  const [subject, ...body] = c.message.split('\n');
  host.appendChild(el('div', 'hist-d-subj', subject || '(no message)'));
  // the Co-Authored-By trailer is shown as the "agent" badge instead
  const bodyText = body.filter((l) => !/^co-authored-by:/i.test(l)).join('\n').trim();
  if (bodyText) host.appendChild(el('div', 'hist-d-body', bodyText));

  const meta = el('div', 'hist-d-meta');
  const sha = el('span', 'sha link', c.sha.slice(0, 10));
  sha.title = 'Copy the full commit id';
  sha.onclick = () => vs.writeClipboard(c.sha).then(() => toast('Commit id copied', 'ok'));
  meta.appendChild(sha);
  meta.appendChild(el('span', '', `${c.author} · ${new Date(c.time).toLocaleString()}`));
  if (c.agent) meta.appendChild(el('span', 'hist-agent', 'agent'));
  if (unpushed.has(c.sha)) meta.appendChild(el('span', 'hist-unpushed', '↑ not pushed'));
  if (c.parents.length > 1) meta.appendChild(el('span', 'dim', `merge — diff vs first parent ${c.parents[0].slice(0, 7)}`));
  host.appendChild(meta);
  const refs = refPills(c.refs);
  if (refs) host.appendChild(refs);

  const add = c.files.reduce((n, f) => n + (f.stat ? f.stat.add : 0), 0);
  const del = c.files.reduce((n, f) => n + (f.stat ? f.stat.del : 0), 0);
  const head = el('div', 'diff-head');
  head.appendChild(el('span', '', `${c.files.length} file${c.files.length === 1 ? '' : 's'}`));
  head.appendChild(el('span', 'spacer'));
  head.appendChild(el('span', 'hist-add', '+' + add));
  head.appendChild(el('span', 'hist-del', '−' + del));
  host.appendChild(head);

  for (const f of c.files) {
    const row = el('div', 'diff-file' + (f.rel === currentFile ? ' active' : ''));
    row.dataset.rel = f.rel;
    row.title = f.from ? `${f.from} → ${f.rel}` : f.rel;
    const st = f.status === 'R' || f.status === 'C' ? 'm' : f.status.toLowerCase();
    row.appendChild(el('span', 'st git-' + st, f.status));
    row.appendChild(el('span', 'rel', f.from ? `${f.from} → ${f.rel}` : f.rel));
    if (f.stat) {
      const n = el('span', 'hist-n');
      n.appendChild(el('span', 'hist-add', '+' + f.stat.add));
      n.appendChild(el('span', 'hist-del', '−' + f.stat.del));
      row.appendChild(n);
    }
    if (f.status !== 'D') {
      const mini = el('span', 'mini', '↗');
      mini.title = 'Open the current version in a tab';
      mini.onclick = (e) => { e.stopPropagation(); openFile(absOf(f.rel), f.rel.split('/').pop()); };
      row.appendChild(mini);
    }
    row.onclick = () => selectFile(f, true);
    host.appendChild(row);
  }
}

let repoRoot = '';
export function setRepo(root) { repoRoot = root; }
function absOf(rel) { return repoRoot + '\\' + rel.replace(/\//g, '\\'); }

async function selectFile(f, open = false) {
  if (!f || !detail) return;
  currentFile = f.rel;
  for (const row of $('#hist-items').querySelectorAll('.diff-file')) row.classList.toggle('active', row.dataset.rel === f.rel);
  const sha = detail.sha;
  const seq = ++detailSeq;
  const d = await vs.gitCommitFileDiff(sha, f).catch(() => null);
  if (seq !== detailSeq || !detail || detail.sha !== sha) return;
  if (!d) { showEmpty('Could not read this file at that commit.', open); return; }
  if (d.binary) { showEmpty('Binary file — no text diff.', open); return; }
  if (d.tooLarge) { showEmpty('File too large to diff (over 1 MB).', open); return; }
  showPair(`${sha}/${f.rel}`, d.original, d.modified, f.rel, open);
}

// "3m ago" / "5h ago" / "2d ago" / date — commit lists are scanned by recency
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 14) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}
