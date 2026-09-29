'use strict';
// Claude data feed (RESEARCH-CLAUDE-DATA.md Part D). A localhost HTTP server that
// claude itself posts to, injected via the per-instance --settings file:
//   POST /sl            statusLine JSON (model, context %, cost, 5h/7d limits…)
//   POST /hook/<Event>  HTTP hook bodies (tool calls, permission, stop…)
// The tab is identified by the `x-vs-term` header ($VIBESPACE_TERM_ID, expanded
// by claude from the pty env). Every request gets 200 `{}` at once: a hook reply
// must never block, deny or alter claude's behavior.
//
// The server must be listening BEFORE any agent starts — if it's down, claude
// prints red "hook error / ECONNREFUSED" lines into the TUI on every turn.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const logger = require('./logger.cjs');
const U = require('./util.cjs');

const MAX_BODY = 2 * 1024 * 1024;
const EMIT_MS = 250; // ≤ 4 feed pushes per second per terminal

let server = null;
let port = null;
let resolveTerm = () => null; // termId -> wsId (ptyhost owns the mapping)
let listener = () => {};
let limitsListener = () => {};
let hookListener = () => {}; // raw hook events (index.cjs derives status words from them)

const terms = new Map(); // termId -> { wsId, state, timer, lastEmit }
let limits = null; // account-wide 5h/7d rate limits (latest copy from any term)
let limitsKey = '';
let limitsAt = 0; // ms when `limits` was observed (here or by another VibeSpace process)

// Limits are account-wide but each workspace process only sees them from its own
// agents — a window with no running agent would never show the chip. So the latest
// copy is shared through <dataRoot>/limits.json (atomic, written on change only)
// and adopted when it is newer than ours and < 6 h old.
const LIMITS_MAX_AGE = 6 * 3600 * 1000;
const limitsFile = () => path.join(U.dataRoot(), 'limits.json');

function seedLimits() {
  const j = U.readJson(limitsFile(), null);
  if (!j || !j.limits || typeof j.at !== 'number' || j.at <= limitsAt || Date.now() - j.at > LIMITS_MAX_AGE) return false;
  limits = j.limits;
  limitsKey = JSON.stringify(j.limits);
  limitsAt = j.at;
  return true;
}

// ---------- pure reducer ----------
const clip = (s, n) => {
  if (typeof s !== 'string') return null;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// the one line that says what a tool call is about: file path, command, pattern…
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.notebook_path || input.command || input.pattern
    || input.path || input.url || input.query || input.subject || input.description || '';
  return clip(String(v).replace(/\s+/g, ' ').trim(), 80) || '';
}

function readLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => (w && num(w.used_percentage) !== null
    ? { pct: w.used_percentage, resetsAt: num(w.resets_at) } // resets_at: epoch seconds
    : null);
  const out = { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day) };
  return out.fiveHour || out.sevenDay ? out : null;
}

function emptyState() {
  return {
    model: null, context: null, cost: null, linesAdded: 0, linesRemoved: 0,
    sessionId: null, sessionName: null, promptCache: null, rateLimits: null,
    nowDoing: null, attention: null, lastMessage: null, turnStartedAt: null, turnEndedAt: null,
    failure: null, subagents: 0, compacting: null, todos: null, tasks: [],
  };
}

// attention = a real ask: 'permission' | 'question' | 'input'. Notification types
// map onto it; idle_prompt (finished agent idling) and the rest are NOT asks.
const NOTIFY_ATTENTION = {
  permission_prompt: 'permission',
  elicitation_dialog: 'input',
  elicitation_url_dialog: 'input',
  agent_needs_input: 'input',
};
const ASK_TOOLS = new Set(['AskUserQuestion']); // claude's question-with-choices tool

// TaskCreate/TaskUpdate tool calls (PostToolUse) and TaskCreated/TaskCompleted
// hooks all land here; merged by id, 'deleted' removes
function upsertTask(tasks, id, patch) {
  const prev = tasks.find(t => t.id === id);
  if (patch.status === 'deleted') return prev ? tasks.filter(t => t.id !== id) : tasks;
  const next = { id, subject: '', description: null, status: 'pending', activeForm: null, ...prev };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '') next[k] = v;
  const out = tasks.filter(t => t.id !== id);
  out.push(next);
  out.sort((a, b) => (Number(a.id) - Number(b.id)) || a.id.localeCompare(b.id));
  return out;
}

function failureReason(body) {
  const base = typeof body.error === 'string' && body.error ? body.error.replace(/_/g, ' ') : 'turn failed';
  const det = typeof body.error_details === 'string' ? body.error_details.trim()
    : (body.error_details && typeof body.error_details.message === 'string' ? body.error_details.message.trim() : '');
  return clip(det && det !== base ? `${base}: ${det}` : base, 200);
}

// reduce(state, 'sl', null, body) | reduce(state, 'hook', '<Event>', body)
// Returns the SAME object when nothing changed, so callers can skip the push.
// Every hook body carries session_id too: it is the exact termId → session map
// (index.cjs pins it — /clear, /resume and the picker all switch it).
function reduce(state, kind, event, body, now = Date.now()) {
  const next = reduceCore(state, kind, event, body, now);
  if (kind === 'hook' && body && typeof body.session_id === 'string' && body.session_id && next.sessionId !== body.session_id) {
    return { ...next, sessionId: body.session_id };
  }
  return next;
}

function reduceCore(state, kind, event, body, now) {
  const s = state || emptyState();
  if (!body || typeof body !== 'object') return s;
  if (kind === 'sl') {
    const cw = body.context_window || {};
    const cu = cw.current_usage;
    // used_percentage is null until the first model response (and after
    // /compact until the next call): no data, not 0 %
    const pct = num(cw.used_percentage);
    const used = cu
      ? (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0)
      : (num(cw.total_input_tokens) || 0);
    const pc = body.prompt_cache;
    const cost = body.cost || {};
    return {
      ...s,
      model: body.model ? { id: body.model.id || null, name: body.model.display_name || body.model.id || null } : s.model,
      context: pct === null ? null : { pct, used, size: num(cw.context_window_size) },
      cost: num(cost.total_cost_usd),
      linesAdded: num(cost.total_lines_added) || 0,
      linesRemoved: num(cost.total_lines_removed) || 0,
      sessionId: body.session_id || s.sessionId,
      sessionName: body.session_name || null,
      promptCache: pc && typeof pc === 'object'
        ? { warm: Boolean(pc.warm), ttl: pc.ttl || null, expiresAt: num(pc.expires_at), hitRatio: num(pc.hit_ratio) }
        : null,
      // windows can be absent on a tick (seen on the very first one): keep the last
      rateLimits: readLimits(body.rate_limits) || s.rateLimits,
      // a context % again means the compaction is over (PostCompact may not come)
      compacting: pct === null ? s.compacting : null,
    };
  }
  if (kind !== 'hook') return s;
  const lastMsg = typeof body.last_assistant_message === 'string' ? clip(body.last_assistant_message, 2000) : s.lastMessage;
  switch (event) {
    case 'PreToolUse': {
      const next = { ...s, nowDoing: { tool: body.tool_name || '?', detail: toolDetail(body.tool_input) } };
      if (ASK_TOOLS.has(body.tool_name)) next.attention = 'question';
      // a new tool call means the previous dialog is gone (e.g. a denied
      // permission, which fires no PostToolUse)
      else if (s.attention === 'permission' || s.attention === 'question') next.attention = null;
      return next;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const next = { ...s, nowDoing: null };
      // the tool ran, so its permission dialog / question has been answered
      if (s.attention === 'permission' || s.attention === 'question') next.attention = null;
      if (event !== 'PostToolUse') return next;
      const input = body.tool_input || {};
      if (body.tool_name === 'TodoWrite' && Array.isArray(input.todos)) {
        next.todos = input.todos.map(t => ({
          content: clip(String(t.content || ''), 200), status: t.status || 'pending', activeForm: clip(t.activeForm || '', 200) || null,
        }));
      } else if (body.tool_name === 'TaskCreate') {
        // fields seen live: tool_input {subject, description}, tool_response {task: {id, subject}}
        const resp = body.tool_response && typeof body.tool_response === 'object' ? body.tool_response : {};
        const id = resp.task && resp.task.id != null ? String(resp.task.id) : null;
        if (id) {
          next.tasks = upsertTask(s.tasks, id, {
            subject: clip(input.subject || resp.task.subject || '', 200),
            description: clip(input.description || '', 500),
            activeForm: clip(input.activeForm || '', 200),
          });
        }
      } else if (body.tool_name === 'TaskUpdate' && input.taskId != null) {
        // seen live: tool_input {taskId, status}; subject/activeForm when renamed
        next.tasks = upsertTask(s.tasks, String(input.taskId), {
          status: typeof input.status === 'string' ? input.status : undefined,
          subject: clip(input.subject || '', 200),
          activeForm: clip(input.activeForm || '', 200),
        });
      }
      return next;
    }
    case 'PermissionRequest':
      // arrives ~0.1 s after PreToolUse and carries the same tool: keep it as nowDoing
      return { ...s, attention: 'permission', nowDoing: { tool: body.tool_name || '?', detail: toolDetail(body.tool_input) } };
    case 'Notification': {
      const a = NOTIFY_ATTENTION[body.notification_type];
      return a && s.attention !== a ? { ...s, attention: a } : s;
    }
    case 'UserPromptSubmit':
      return { ...s, attention: null, failure: null, turnStartedAt: now };
    case 'SubagentStart':
      return { ...s, subagents: (s.subagents || 0) + 1 };
    case 'SubagentStop':
      // also fires for internal agents that never had a SubagentStart: floor at 0
      return s.subagents > 0 ? { ...s, subagents: s.subagents - 1 } : s;
    case 'Stop':
      return { ...s, nowDoing: null, attention: null, failure: null, subagents: 0, lastMessage: lastMsg, turnEndedAt: now };
    case 'StopFailure':
      return {
        ...s, nowDoing: null, attention: null, subagents: 0, lastMessage: lastMsg, turnEndedAt: now,
        failure: { reason: failureReason(body), at: now },
      };
    case 'TaskCreated':
    case 'TaskCompleted': {
      if (body.task_id == null) return s;
      return {
        ...s,
        tasks: upsertTask(s.tasks, String(body.task_id), {
          subject: clip(body.task_subject || '', 200),
          description: clip(body.task_description || '', 500),
          status: event === 'TaskCompleted' ? 'completed' : undefined,
        }),
      };
    }
    // compaction payloads are unverified live: only trigger is read, defensively
    case 'PreCompact':
      return { ...s, compacting: { trigger: typeof body.trigger === 'string' ? body.trigger : null, at: now } };
    case 'PostCompact':
      return s.compacting ? { ...s, compacting: null } : s;
    default:
      return s; // collected but not modeled
  }
}

// One line for "why does this agent need you" — tab light tooltip, activity
// strip, toast body. null when the feed has no reason (base state speaks alone).
function attentionText(s) {
  if (!s) return null;
  if (s.failure) return `turn failed: ${s.failure.reason}`;
  const what = s.nowDoing ? [s.nowDoing.tool, s.nowDoing.detail].filter(Boolean).join(' — ') : '';
  if (s.attention === 'permission') return what ? `needs permission: ${what}` : 'needs permission';
  if (s.attention === 'question') return 'is asking you a question';
  if (s.attention === 'input') return 'needs your input';
  return null;
}

// ---------- emit (throttled per term) ----------
// pushed/snapshotted states carry the computed attention line for the renderer
const withReason = (st) => ({ ...st, reason: attentionText(st) });

function flushTerm(termId) {
  const t = terms.get(termId);
  if (!t) return;
  t.timer = null;
  t.lastEmit = Date.now();
  try { listener(t.wsId, termId, withReason(t.state)); } catch (e) { logger.warn('feed listener: ' + e.message); }
}

function scheduleEmit(termId) {
  const t = terms.get(termId);
  if (!t || t.timer) return;
  const wait = Math.max(0, EMIT_MS - (Date.now() - (t.lastEmit || 0)));
  t.timer = setTimeout(() => flushTerm(termId), wait);
}

function ingest(termId, kind, event, body) {
  const wsId = resolveTerm(termId);
  if (!wsId) return false; // unknown term (stale claude, other process) — drop
  let t = terms.get(termId);
  if (!t) { t = { wsId, state: emptyState(), timer: null, lastEmit: 0 }; terms.set(termId, t); }
  t.wsId = wsId;
  if (kind === 'hook') {
    try { hookListener(wsId, termId, event, body); } catch (e) { logger.warn('hook listener: ' + e.message); }
  }
  const next = reduce(t.state, kind, event, body);
  if (kind === 'sl') {
    const rl = readLimits(body && body.rate_limits);
    const key = rl ? JSON.stringify(rl) : '';
    if (rl && key !== limitsKey) {
      limits = rl;
      limitsKey = key;
      limitsAt = Date.now();
      try { U.ensureDir(U.dataRoot()); U.writeJsonAtomic(limitsFile(), { at: limitsAt, limits }); } catch (e) { logger.warn('limits.json write failed: ' + e.message); }
      try { limitsListener(limits); } catch (e) { logger.warn('limits listener: ' + e.message); }
    }
  }
  if (next === t.state) return true;
  t.state = next;
  scheduleEmit(termId);
  return true;
}

// ---------- server ----------
function handle(req, res) {
  let done = false;
  const reply = () => {
    if (done) return;
    done = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  };
  if (req.method !== 'POST') { req.resume(); reply(); return; }
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { over = true; chunks.length = 0; return; } // drain, don't keep
    chunks.push(c);
  });
  req.on('error', reply);
  req.on('end', () => {
    reply(); // answer first — parsing/reducing never delays claude
    if (over) return;
    try {
      const termId = String(req.headers['x-vs-term'] || '');
      if (!termId) return;
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; } // bad JSON: ignore
      if (pathname === '/sl') ingest(termId, 'sl', null, body);
      else if (pathname.startsWith('/hook/')) ingest(termId, 'hook', decodeURIComponent(pathname.slice(6)), body);
    } catch (e) {
      logger.warn('feed request failed: ' + e.message);
    }
  });
}

// start({ resolveTerm }) → Promise<{ port }>; port is null if listening failed
// (callers then leave the feed out of the settings file — no ECONNREFUSED spam)
function start(opts = {}) {
  if (typeof opts.resolveTerm === 'function') resolveTerm = opts.resolveTerm;
  seedLimits();
  if (server) return Promise.resolve({ port });
  return new Promise((resolve) => {
    const srv = http.createServer(handle);
    srv.keepAliveTimeout = 5000;
    srv.on('error', (e) => {
      logger.warn('claude feed server error: ' + e.message);
      if (!port) { server = null; resolve({ port: null }); }
    });
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      port = srv.address().port;
      logger.info(`claude feed listening on 127.0.0.1:${port}`);
      resolve({ port });
    });
  });
}

function stop() {
  if (server) { try { server.close(); } catch {} }
  server = null;
  port = null;
}

// ---------- settings injection (called by index.cjs ensureHookSettings) ----------
// Adds a statusLine command and HTTP hooks posting here, ON TOP of the existing
// command hooks (lights/toasts/badge keep working if the feed fails). No server →
// no feed entries at all: a dead port prints red ECONNREFUSED lines in the TUI.
const HOOK_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact',
  'PostCompact', 'TaskCreated', 'TaskCompleted',
  // SessionStart never fires as an HTTP hook (verified live) — not listed
];

// the user's own statusLine command (~/.claude/settings.json), if any — ours
// replaces it for the session (--settings wins), so we hand its stdin on
function userStatusLineCommand(home = os.homedir()) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); } catch {}
  const sl = s && s.statusLine;
  return sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim() ? sl.command : null;
}

// Runs in Git Bash. curl stays silent (stdout IS the visible status row), so with
// no user statusLine the row stays empty. NO refreshInterval: countdowns tick in
// the UI, and a spawn every few seconds × N agents is waste.
function statusLineCommand(p, userCmd) {
  const post = `curl -s -m 2 -X POST -H "x-vs-term: $VIBESPACE_TERM_ID" -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:${p}/sl >/dev/null 2>&1`;
  if (!userCmd) return `${post}; exit 0`;
  // hand-off: the same stdin goes to the user's command, and ITS output is the row
  const quoted = "'" + userCmd.replace(/'/g, "'\\''") + "'";
  return `vs_user=${quoted}; vs_json=$(cat); printf '%s' "$vs_json" | ${post}; printf '%s' "$vs_json" | eval "$vs_user"`;
}

function addSettings(settings, opts = {}) {
  const p = opts.port !== undefined ? opts.port : port;
  if (!p) return settings;
  const userCmd = opts.userCommand !== undefined ? opts.userCommand : userStatusLineCommand();
  settings.statusLine = { type: 'command', command: statusLineCommand(p, userCmd) };
  settings.hooks = settings.hooks || {};
  for (const ev of HOOK_EVENTS) {
    const hook = {
      type: 'http',
      url: `http://127.0.0.1:${p}/hook/${ev}`,
      headers: { 'x-vs-term': '$VIBESPACE_TERM_ID' },
      allowedEnvVars: ['VIBESPACE_TERM_ID'],
      timeout: 3, // the server answers at once; this only bounds a wedged main
    };
    settings.hooks[ev] = [...(settings.hooks[ev] || []), { hooks: [hook] }];
  }
  return settings;
}

// a pty exited: its agent is gone, so is its feed
function forget(termId) {
  const t = terms.get(termId);
  if (t && t.timer) clearTimeout(t.timer);
  terms.delete(termId);
}

// every term state of a workspace + the account limits (renderer reload/re-attach)
function snapshot(wsId) {
  const out = {};
  for (const [termId, t] of terms) if (t.wsId === wsId) out[termId] = withReason(t.state);
  seedLimits(); // another process may have seen newer limits
  return { terms: out, limits };
}

module.exports = {
  start,
  stop,
  forget,
  snapshot,
  reduce,
  attentionText,
  addSettings,
  stateOf: (termId) => (terms.get(termId) || {}).state || null,
  port: () => port,
  limits: () => limits,
  onData: (fn) => { listener = fn; },
  onLimits: (fn) => { limitsListener = fn; },
  onHook: (fn) => { hookListener = fn; },
};
