'use strict';
// Model guard: a /model pick in an API endpoint tab (z.ai GLM…) must not change
// the default model of every Claude tab.
//
// Claude saves every /model pick (Enter) as `model` in the USER settings
// (~/.claude/settings.json, "Your pick becomes the default for new sessions").
// All tabs share that file, so a GLM pick there once set the user's `opus[1m]`
// to "sonnet", and every new Claude tab started on another model (2026-10-19).
// Verified on claude 2.1.303 that nothing native prevents it: `--model`,
// ANTHROPIC_MODEL and a `model` key in the tab's --settings file all still
// write (the --settings key even made a "Default" pick DELETE the user's
// value). Only "s" in the picker ("this session only") skips the save.
// Running sessions don't follow the file (checked: a running Claude tab kept
// its model across the change), so it only matters for the NEXT claude start.
//
// So main watches the file and writes the previous value back when the change
// is attributable to an endpoint tab of THIS process:
//   1. that tab switched model (its PostModelSwitch hook or its feed model
//      changed) to what was saved, within WINDOW_MS; or
//   2. the saved value is one of that tab's endpoint model ids (exact GLM ids:
//      the endpoint picker rows carry them, accounts.endpointTabSettings) and
//      that tab posted to the feed within WINDOW_MS (claude re-runs the
//      statusLine ~0.3 s after a pick, even one that keeps the model).
// Never when a Claude tab here switched model in the same window, and never on
// a machine with no Claude account (no /login, no token account: z.ai only),
// where a GLM pick as the default is what the user expects. A change
// nobody here explains is kept (and becomes the new remembered value).
// Known gap: picking "Default" (or typing `/model opus`) while the endpoint
// tab is ALREADY on that model saves an alias / removes the key with no
// switch, and that value is something a Claude tab could write too, so it is
// kept. The tab keeps its own model across restarts through the renderer's
// per-tab model (terms.js followModel → --model), not through this file.
// Log: `model guard:`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logger = require('./logger.cjs');

const WINDOW_MS = 5000;
const POLL_MS = 2000;

// ---------- pure ----------
const CLAUDE_ALIAS_RE = /^(default|best|opus|sonnet|haiku|fable|opusplan)(\[1m\])?$/i;
// names a Claude tab could save: aliases, claude-* ids, Bedrock ids
const isClaudeName = (v) => CLAUDE_ALIAS_RE.test(v) || /^claude-/i.test(v) || /^(?:[a-z]{2}\.)?anthropic\./i.test(v);
const bare = (m) => String(m == null ? '' : m).trim().replace(/\[1m\]$/i, '').toLowerCase();
const same = (a, b) => (a === undefined ? b === undefined : b !== undefined && a === b);

// the endpoint model a saved value stands for in a tab with these slot models
// (`sonnet` → models.sonnet), bare and lowercased; null when it names none
function resolveFor(value, models) {
  if (value === undefined || value === null) return null;
  const m = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(String(value).trim());
  if (m) {
    const slot = m[1].toLowerCase() === 'fable' ? 'opus' : m[1].toLowerCase();
    return models && models[slot] ? bare(models[slot]) : null;
  }
  return bare(value);
}
const isEndpointModel = (value, models) => typeof value === 'string' && !isClaudeName(value)
  && Object.values(models || {}).some(m => m && bare(m) === bare(value));

// { prev, next, at } = the saved `model` before/after (undefined = no key) and
// when the change was seen; signals = [{ termId, at, endpoint, models, kind:
// 'switch'|'activity', to?, requested? }] → { restore, termId?, why }
// claudeAccount false = no Claude login/token on this machine (z.ai only):
// no Claude tab to protect, and a GLM pick as the default is what that user
// expects.
function decide({ prev, next, at, signals = [], claudeAccount = true }) {
  if (same(prev, next)) return { restore: false, why: 'unchanged' };
  if (!claudeAccount) return { restore: false, why: 'no Claude account on this machine' };
  const near = signals.filter(s => s && Math.abs(s.at - at) <= WINDOW_MS);
  if (near.some(s => !s.endpoint && s.kind === 'switch')) return { restore: false, why: 'a Claude tab switched model in the same moment' };
  for (const s of near) {
    if (!s.endpoint || s.kind !== 'switch') continue;
    const hit = next === undefined
      ? true // "Default" removes the key; this tab just switched
      : (typeof s.requested === 'string' && s.requested.trim() === next)
        || (typeof s.to === 'string' && resolveFor(next, s.models) === bare(s.to));
    if (hit) return { restore: true, termId: s.termId, why: `it switched to ${s.to || next}` };
  }
  if (typeof next === 'string' && !isClaudeName(next)) {
    const s = near.find(x => x.endpoint && isEndpointModel(next, x.models));
    if (s) return { restore: true, termId: s.termId, why: 'the saved value is its endpoint model' };
  }
  return { restore: false, why: 'not attributable to an endpoint tab here' };
}

// ---- JSON text patching: change only the top-level "model" member ----
function skipWs(t, i) { while (i < t.length && /\s/.test(t[i])) i++; return i; }
function endOfString(t, i) { // i at the opening quote → index after the closing one
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') { j++; continue; }
    if (t[j] === '"') return j + 1;
  }
  return -1;
}
function endOfValue(t, i) {
  if (t[i] === '"') return endOfString(t, i);
  if (t[i] === '{' || t[i] === '[') {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (c === '"') { j = endOfString(t, j) - 1; if (j < 0) return -1; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  }
  let j = i;
  while (j < t.length && !/[\s,}\]]/.test(t[j])) j++;
  return j > i ? j : -1;
}
// top-level members of the object text: [{ key, keyStart, valueStart, valueEnd }]
function members(t) {
  let i = skipWs(t, t.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (t[i] !== '{') return null;
  const open = i;
  const out = [];
  i = skipWs(t, i + 1);
  while (i < t.length && t[i] !== '}') {
    if (t[i] !== '"') return null;
    const ke = endOfString(t, i);
    if (ke < 0) return null;
    let key;
    try { key = JSON.parse(t.slice(i, ke)); } catch { return null; }
    let j = skipWs(t, ke);
    if (t[j] !== ':') return null;
    const vs = skipWs(t, j + 1);
    const ve = endOfValue(t, vs);
    if (ve < 0) return null;
    out.push({ key, keyStart: i, valueStart: vs, valueEnd: ve });
    j = skipWs(t, ve);
    if (t[j] === ',') j = skipWs(t, j + 1);
    i = j;
  }
  return t[i] === '}' ? { open, close: i, list: out } : null;
}
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);

// the settings text with only "model" set to `value` (undefined = removed);
// everything else byte for byte. Falls back to a re-serialization (same
// indent and line ends) if the patch would not parse to exactly that.
function patchModel(text, value) {
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const want = { ...parsed };
  if (value === undefined) delete want.model; else want.model = value;
  let out = null;
  const m = members(text);
  if (m) {
    const at = m.list.findIndex(x => x.key === 'model');
    const mem = m.list[at];
    if (mem && value !== undefined) {
      out = text.slice(0, mem.valueStart) + JSON.stringify(value) + text.slice(mem.valueEnd);
    } else if (mem) {
      const next = m.list[at + 1];
      if (next) out = text.slice(0, mem.keyStart) + text.slice(next.keyStart);
      else if (at > 0) {
        const prevEnd = m.list[at - 1].valueEnd;
        out = text.slice(0, prevEnd) + text.slice(mem.valueEnd).replace(/^\s*,/, '');
      } else out = text.slice(0, mem.keyStart) + text.slice(mem.valueEnd);
    } else if (value !== undefined) {
      const first = m.list[0];
      if (first) {
        const lead = text.slice(m.open + 1, first.keyStart); // e.g. "\n  "
        out = text.slice(0, m.open + 1) + lead + `"model": ${JSON.stringify(value)},` + text.slice(m.open + 1);
      } else {
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        out = text.slice(0, m.open + 1) + `${eol}  "model": ${JSON.stringify(value)}${eol}` + text.slice(m.close);
      }
    } else out = text;
  }
  let ok = false;
  try { ok = out !== null && JSON.stringify(canon(JSON.parse(out.charCodeAt(0) === 0xfeff ? out.slice(1) : out))) === JSON.stringify(canon(want)); } catch {}
  if (ok) return out;
  const indent = (/\n([ \t]+)"/.exec(text) || [])[1] || '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let s = JSON.stringify(want, null, indent);
  if (eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  return s + (/\r?\n$/.test(text) ? eol : '');
}

// ---------- the watcher ----------
let file = null;
let termInfo = () => null; // termId -> { endpoint, models } (index.cjs)
let hasClaude = () => true; // this machine has a Claude login/token account (index.cjs: accounts.hasClaudeAccount)
let known = undefined; // the remembered `model` (undefined = no key)
let started = false;
let pending = null; // { prev, next, at }
let timer = null;
let lastMtime = 0;
let writing = false;
const signals = [];
const feedModels = new Map(); // termId -> last feed model id

const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const show = (v) => (v === undefined ? '(none)' : JSON.stringify(v));

// the file's `model`: { ok, value } (ok false = missing file is ok, unreadable/mid-write is not)
function readModel() {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { ok: true, value: undefined, text: null } : { ok: false }; }
  try {
    const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false };
    return { ok: true, value: typeof j.model === 'string' ? j.model : undefined, text };
  } catch { return { ok: false }; }
}

function start(opts = {}) {
  if (typeof opts.termInfo === 'function') termInfo = opts.termInfo;
  if (typeof opts.hasClaude === 'function') hasClaude = opts.hasClaude;
  if (started) return;
  started = true;
  file = opts.file || settingsFile();
  const r = readModel();
  known = r.ok ? r.value : undefined;
  try { lastMtime = fs.statSync(file).mtimeMs; } catch {}
  logger.info(`model guard: watching ${file} (model=${show(known)})`);
  try {
    const w = fs.watch(path.dirname(file), (ev, name) => { if (!name || String(name).toLowerCase() === 'settings.json') check(); });
    w.on('error', () => {});
    w.unref();
  } catch (e) { logger.warn(`model guard: watch failed (${e.message}); polling only`); }
  setInterval(() => {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    if (m !== lastMtime) check();
  }, POLL_MS).unref();
}

function note(termId, kind, extra = {}) {
  if (!started) return;
  let info = null;
  try { info = termInfo(termId); } catch {}
  if (!info) return;
  if (kind === 'activity' && !info.endpoint) return; // only endpoint tabs' activity counts
  const now = Date.now();
  signals.push({ termId, at: now, endpoint: Boolean(info.endpoint), models: info.models || null, kind, ...extra });
  while (signals.length && now - signals[0].at > 3 * WINDOW_MS) signals.shift();
  if (signals.length > 500) signals.splice(0, signals.length - 500);
  if (pending) evaluate();
}

// PostModelSwitch hook body (endpoint tabs carry the hook)
function noteSwitch(termId, body) {
  if (!body || typeof body !== 'object') return;
  note(termId, 'switch', {
    to: typeof body.to_model === 'string' ? body.to_model : null,
    requested: typeof body.requested_model === 'string' ? body.requested_model : null,
  });
}
// every feed emit: a model id that differs from the tab's last one = a switch
function noteFeedModel(termId, id) {
  if (!id) return;
  const prev = feedModels.get(termId);
  feedModels.set(termId, id);
  if (prev && prev !== id) note(termId, 'switch', { to: id, requested: null });
}
function noteActivity(termId) { note(termId, 'activity'); }
function forget(termId) { feedModels.delete(termId); }

function check() {
  if (!started || writing) return;
  try { lastMtime = fs.statSync(file).mtimeMs; } catch { lastMtime = 0; }
  const r = readModel();
  if (!r.ok) return; // mid-write or broken: the next change event tries again
  const cur = r.value;
  if (pending) {
    if (same(cur, pending.prev)) { pending = null; return; }
    if (!same(cur, pending.next)) { pending.next = cur; pending.at = Date.now(); pending.claudeAccount = claudeAccountNow(); }
  } else {
    if (same(cur, known)) return;
    // judged once per change, never per feed tick
    pending = { prev: known, next: cur, at: Date.now(), claudeAccount: claudeAccountNow() };
  }
  evaluate();
}

function claudeAccountNow() {
  try { return hasClaude() !== false; } catch { return true; }
}

function evaluate() {
  if (!pending) return;
  const d = decide({ ...pending, signals });
  if (d.restore) { restore(d); return; }
  const age = Date.now() - pending.at;
  if (age > WINDOW_MS) {
    logger.info(`model guard: kept model ${show(pending.next)} (was ${show(pending.prev)}): ${d.why}`);
    known = pending.next;
    pending = null;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(evaluate, WINDOW_MS - age + 50);
  timer.unref();
}

function restore(d, tries = 0) {
  const p = pending;
  if (!p) return;
  const r = readModel();
  if (!r.ok || r.text === null || !same(r.value, p.next)) {
    // changed again (or unreadable) since: judge the file as it is now
    if (tries < 5 && !r.ok) { setTimeout(() => restore(d, tries + 1), 100).unref(); return; }
    pending = null;
    known = r.ok ? r.value : known;
    logger.info(`model guard: no restore, the file changed again (model=${show(r.ok ? r.value : '?')})`);
    return;
  }
  let text;
  try { text = patchModel(r.text, p.prev); } catch (e) { logger.warn(`model guard: patch failed (${e.message})`); pending = null; known = p.next; return; }
  const tmp = `${file}.vs-${process.pid}.tmp`;
  writing = true;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    writing = false;
    try { fs.rmSync(tmp, { force: true }); } catch {}
    if (tries < 5 && /EPERM|EBUSY|EACCES/.test(e.code || '')) { setTimeout(() => restore(d, tries + 1), 150).unref(); return; }
    logger.warn(`model guard: restore failed (${e.message})`);
    pending = null; known = p.next;
    return;
  }
  writing = false;
  try { lastMtime = fs.statSync(file).mtimeMs; } catch {}
  pending = null;
  known = p.prev;
  logger.info(`model guard: restored model ${show(p.prev)} (an API endpoint tab ${d.termId} saved ${show(p.next)}: ${d.why})`);
}

module.exports = {
  start,
  noteSwitch,
  noteFeedModel,
  noteActivity,
  forget,
  // pure (smoke)
  decide,
  patchModel,
  resolveFor,
  isClaudeName,
  WINDOW_MS,
};
