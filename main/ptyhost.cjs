'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  pty = null;
}

const sessions = new Map(); // termId -> IPty
const lastActivity = new Map(); // termId -> ms of last data in or out (reload guard)
const lastOutput = new Map(); // termId -> ms of last OUTPUT only (input excluded: with
// mouse tracking on, merely moving the mouse over claude's terminal sends input)
const metas = new Map(); // termId -> { cwd, statusFile, wsId } — bookkeeping for list()
const buffers = new Map(); // termId -> { chunks: [], len } — output ring for re-attach
const BUFFER_CAP = 256 * 1024; // per-terminal bytes kept so a reload can restore scrollback

function pushBuffer(termId, chunk) {
  let b = buffers.get(termId);
  if (!b) { b = { chunks: [], len: 0 }; buffers.set(termId, b); }
  b.chunks.push(chunk);
  b.len += chunk.length;
  while (b.len > BUFFER_CAP && b.chunks.length > 1) {
    b.len -= b.chunks[0].length;
    b.chunks.shift();
  }
}
let dataListener = () => {};
let exitListener = () => {};
const logger = require('./logger.cjs');
const U = require('./util.cjs');
const presence = require('./presence.cjs');
const accounts = require('./accounts.cjs');
const { spawn, execFile } = require('node:child_process');

function available() {
  return Boolean(pty);
}

// Windows stores the variable as "Path"; process.env is case-insensitive, but a
// COPY ({ ...process.env }) is a plain object where "Path" and "PATH" are two
// different keys. Writing env.PATH on the copy used to ADD a second, stripped
// PATH next to the full "Path" — and the stripped one won in the child's
// environment block (the "node/python/mcp-postgres not found in VibeSpace
// terminals" bug, 2026-09-29). Always collapse to ONE key.
function withSinglePath(env, value) {
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH') delete env[k];
  }
  env.Path = value;
  return env;
}

function readPath(env) {
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH' && env[k]) return env[k];
  }
  return '';
}

function ensureClaudeOnPath(env) {
  const claudeDir = path.join(os.homedir(), '.local', 'bin');
  if (fs.existsSync(claudeDir)) {
    const cur = readPath(env);
    const already = cur.toLowerCase().split(';').some(p => p.trim().replace(/\\+$/, '') === claudeDir.toLowerCase());
    if (!already) withSinglePath(env, `${claudeDir};${cur}`);
  }
  return env;
}

// A window spawned from a stripped environment (e.g. an agent shell whose PATH lacks
// System32) used to hand that broken PATH to every terminal and every process they
// start — claude hooks then fail with 'node/powershell: command not found'. Repair the
// system-critical entries so every VibeSpace terminal is fully usable regardless of
// how its window was launched.
function repairPath(env) {
  // built with path.join, not literals: 'C:\Windows\...\v1.0' in a JS string is
  // "C:Windows...<vertical-tab>1.0" — this very function was injecting mangled entries
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const mustHave = [
    path.join(sysRoot, 'System32'),
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    sysRoot,
  ];
  const parts = readPath(env).split(';').map(s => s.trim()).filter(Boolean);
  const have = new Set(parts.map(p => p.toLowerCase()));
  for (const dir of mustHave) {
    if (!have.has(dir.toLowerCase())) parts.unshift(dir);
  }
  return withSinglePath(env, parts.join(';'));
}

// Every VibeSpace terminal defines a `claude` function that adds our hook settings
// (and the Remote Control name) unless they're already there, so a claude typed by
// hand is tracked exactly like one VibeSpace launched: without --settings there is
// no feed, so no session tracking, lights or phone control, and its conversation
// would be lost on restart (2026-09-29). Subcommands and print/version/help runs pass
// through untouched: a `-p` run would otherwise report into this tab's feed and pin
// its session. Sent as -EncodedCommand: no quoting issues and no execution policy.
const CLAUDE_SUBCOMMANDS = ['agents', 'attach', 'auth', 'auto-mode', 'config', 'doctor', 'gateway', 'import',
  'install', 'logs', 'mcp', 'migrate-installer', 'plugin', 'project', 'remote-control', 'respawn', 'rm',
  'setup-token', 'stop', 'ultrareview', 'update'];
//
// Accounts (accounts.cjs): the tab's account id is read from
// $VIBESPACE_ACCOUNT_FILE at every launch (missing/empty = 'login'). A token
// account's DPAPI blob is decrypted right here and handed to claude ONLY for this
// call via CLAUDE_CODE_OAUTH_TOKEN (restored afterwards); such agents get no
// --remote-control (Remote Control refuses setup-tokens). The logged-in account
// runs with any inherited CLAUDE_CODE_OAUTH_TOKEN removed for the call.
// An API endpoint account: main wrote <termId>.settings.json (hooks + env) next
// to the account file and claude gets THAT as --settings; a claude typed with
// its own --settings is refused (it would run without the endpoint's env).
// The wrapper never decrypts endpoint settings (Defender, see accounts.cjs).
// DRYRUN prints VSACCT[<id>|token|endpoint|missing] or VSACCT[login], never the token.
const CLAUDE_WRAPPER = `
function global:claude {
  $exe = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $a = @($args | ForEach-Object { "$_" })
  $sub = @(${CLAUDE_SUBCOMMANDS.map(s => `'${s}'`).join(',')})
  $plain = ($a.Count -gt 0 -and $sub -contains $a[0]) -or @($a | Where-Object { $_ -in '-p','--print','-v','--version','-h','--help' }).Count -gt 0
  $acct = 'login'
  $blob = $null
  $own = $false
  if (-not $plain) {
    if ($env:VIBESPACE_ACCOUNT_FILE -and (Test-Path -LiteralPath $env:VIBESPACE_ACCOUNT_FILE)) {
      $r = Get-Content -LiteralPath $env:VIBESPACE_ACCOUNT_FILE -Raw -ErrorAction SilentlyContinue
      if ($r) { $r = $r.Trim() }
      if ($r) { $acct = $r }
    }
    # an API endpoint account: main wrote this tab's settings (hooks + env) next
    # to the account file; claude gets that file INSTEAD of the hook settings
    $eps = $null
    if ($acct -ne 'login' -and $env:VIBESPACE_ACCOUNT_FILE) {
      $f = [IO.Path]::ChangeExtension($env:VIBESPACE_ACCOUNT_FILE, '.settings.json')
      if ([IO.File]::Exists($f)) { $eps = $f }
    }
    if ($acct -ne 'login' -and -not $eps) { $blob = Join-Path "$env:VIBESPACE_ACCOUNT_DIR" "$acct.dpapi" }
    if ($acct -eq 'login' -and $env:VIBESPACE_RC_LABEL -and @($a | Where-Object { $_ -in '--remote-control','--rc' }).Count -eq 0) { $a += '--remote-control', $env:VIBESPACE_RC_LABEL }
    if ($eps) {
      # our hook settings are replaced by the tab's file; any OTHER --settings
      # would be a claude without the endpoint's env, i.e. on the /login
      $b = @()
      for ($i = 0; $i -lt $a.Count; $i++) {
        if ($a[$i] -eq '--settings' -and $i + 1 -lt $a.Count -and ($a[$i + 1] -eq $env:VIBESPACE_CLAUDE_SETTINGS -or $a[$i + 1] -eq $eps)) { $i++; continue }
        if ($a[$i] -eq '--settings' -or $a[$i] -like '--settings=*') { $own = $true }
        $b += $a[$i]
      }
      $a = $b + @('--settings', $eps)
    } elseif ($env:VIBESPACE_CLAUDE_SETTINGS -and $a -notcontains '--settings') { $a += '--settings', $env:VIBESPACE_CLAUDE_SETTINGS }
  }
  if ($own) { Write-Error "This tab runs on the endpoint account '$acct': start claude without --settings"; return }
  if ($env:VIBESPACE_CLAUDE_DRYRUN) {
    if (-not $plain) {
      if ($acct -eq 'login') { $tag = 'login' } elseif ($eps) { $tag = $acct + '|endpoint' } elseif (Test-Path -LiteralPath $blob) { $tag = $acct + '|token' } else { $tag = $acct + '|missing' }
      Write-Output ('VSACCT[' + $tag + ']')
    }
    Write-Output ('VSCLAUDE[' + ($a -join '|') + ']'); return
  }
  if (-not $exe) { Write-Error 'claude is not on PATH'; return }
  if ($plain) { & $exe.Source @a; return }
  $tok = $null
  if ($acct -ne 'login' -and -not $eps) {
    try {
      if (-not (Test-Path -LiteralPath $blob)) { throw 'missing' }
      ${accounts.DECRYPT_PS}
    } catch { $tok = $null }
    if (-not $tok) { Write-Error "VibeSpace: account '$acct' token is unreadable — re-add it in Preferences"; return }
  }
  $hadTok = Test-Path env:CLAUDE_CODE_OAUTH_TOKEN
  $prevTok = $env:CLAUDE_CODE_OAUTH_TOKEN
  try {
    if ($tok) { $env:CLAUDE_CODE_OAUTH_TOKEN = $tok } else { Remove-Item env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue }
    & $exe.Source @a
  } finally {
    if ($hadTok) { $env:CLAUDE_CODE_OAUTH_TOKEN = $prevTok } else { Remove-Item env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue }
    $tok = $null
  }
}`;
const shellArgs = () => ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(CLAUDE_WRAPPER, 'utf16le').toString('base64')];

function create(termId, cwd, cols = 120, rows = 30, wsId = null, { settingsPath = null, rcLabel = null } = {}) {
  if (!pty) throw new Error('node-pty is not available — run: npm install && npm run rebuild');
  if (sessions.has(termId)) kill(termId);
  // start from ONE path key holding the full value (process.env.PATH reads the
  // real, registry-rebuilt value case-insensitively)
  const base = withSinglePath({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, process.env.PATH || '');
  const env = repairPath(ensureClaudeOnPath(base));
  // claude hooks (injected via `claude --settings`) append working|waiting|done to
  // this file; main watches the directory and turns it into tab status lights
  let statusFile = null;
  if (wsId) {
    statusFile = path.join(U.dataRoot(), 'instances', wsId, 'status', `${termId}.status`);
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.rmSync(statusFile, { force: true });
    } catch {}
    env.VIBESPACE_TERM_STATUS = statusFile;
  }
  // claude's statusLine command and HTTP hooks send this back as the x-vs-term
  // header, so the feed server (claudefeed.cjs) knows which tab a payload is for
  env.VIBESPACE_TERM_ID = termId;
  // away mode: claude skips phone pushes while this file exists (presence.cjs owns
  // it machine-wide); read at claude launch, so only new agents pick it up
  env.CLAUDE_CLIENT_PRESENCE_FILE = presence.markerPath();
  // read by the `claude` wrapper (CLAUDE_WRAPPER above)
  if (settingsPath) env.VIBESPACE_CLAUDE_SETTINGS = settingsPath;
  if (rcLabel) env.VIBESPACE_RC_LABEL = rcLabel;
  // the tab's account: setAccount writes the id, no file = the logged-in account.
  // A fresh pty starts without one, so a restored plain tab never inherits a
  // stale account (the renderer sets it before every claude launch).
  const accountFile = accountFileFor(wsId, termId);
  try { fs.rmSync(accountFile, { force: true }); } catch {}
  try { fs.rmSync(endpointSettingsFor(wsId, termId), { force: true }); } catch {}
  env.VIBESPACE_ACCOUNT_FILE = accountFile;
  env.VIBESPACE_ACCOUNT_DIR = accounts.blobDir();
  const proc = pty.spawn('powershell.exe', shellArgs(), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    useConpty: true,
  });
  sessions.set(termId, proc);
  metas.set(termId, { cwd, statusFile, wsId });
  buffers.set(termId, { chunks: [], len: 0 });
  logger.info(`pty spawn: ${termId} cwd=${cwd}`);
  proc.onData(chunk => {
    const t = Date.now();
    lastActivity.set(termId, t);
    lastOutput.set(termId, t);
    pushBuffer(termId, chunk);
    feedWaiters(termId, chunk);
    dataListener(termId, chunk);
  });
  proc.onExit(({ exitCode }) => {
    sessions.delete(termId);
    const meta = metas.get(termId);
    if (meta?.statusFile) { try { fs.rmSync(meta.statusFile, { force: true }); } catch {} }
    try { fs.rmSync(endpointSettingsFor(meta?.wsId, termId), { force: true }); } catch {} // holds a key
    metas.delete(termId);
    buffers.delete(termId);
    lastActivity.delete(termId);
    lastOutput.delete(termId);
    for (const w of [...(waiters.get(termId) || [])]) w.exit();
    logger.info(`pty exit: ${termId} code=${exitCode}`);
    exitListener(termId);
  });
  return proc;
}

// <instance dir>/accounts/<termId>.account: plain text account id, read by the
// wrapper at every claude launch (so a change applies to the NEXT launch in the tab)
function accountFileFor(wsId, termId) {
  return path.join(U.dataRoot(), 'instances', wsId || '_none', 'accounts', `${termId}.account`);
}

// an endpoint account's per-tab claude settings: the hook settings plus its env
// (the key in plain text, like claude's own settings.json; deleted when the tab
// leaves the account or its pty exits)
function endpointSettingsFor(wsId, termId) {
  return path.join(U.dataRoot(), 'instances', wsId || '_none', 'accounts', `${termId}.settings.json`);
}

function writeEndpointSettings(termId, wsId, baseSettingsPath, env) {
  const file = endpointSettingsFor((metas.get(termId) || {}).wsId || wsId, termId);
  let base = {};
  try { if (baseSettingsPath) base = JSON.parse(fs.readFileSync(baseSettingsPath, 'utf8')) || {}; } catch {}
  const settings = { ...base, env: { ...(base.env || {}), ...env } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function clearEndpointSettings(termId, wsId = null) {
  try { fs.rmSync(endpointSettingsFor((metas.get(termId) || {}).wsId || wsId, termId), { force: true }); } catch {}
}

// main start: no pty survives a main restart, so every tab settings file of
// this instance (each may hold an endpoint key) is stale
function clearInstanceEndpointSettings(wsId) {
  const dir = path.join(U.dataRoot(), 'instances', wsId || '_none', 'accounts');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!/\.settings\.json(?:\.\d+\.tmp)?$/.test(f)) continue;
    try { fs.rmSync(path.join(dir, f), { force: true }); n++; } catch {}
  }
  return n;
}

function setAccount(termId, id, wsId = null) {
  const file = accountFileFor((metas.get(termId) || {}).wsId || wsId, termId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(id || 'login'));
  return file;
}

// After '/exit' was sent: resolve { how: 'prompt' } once the output written from
// NOW on ends in a PowerShell prompt (claude gave the shell back). On timeout,
// kill claude processes under the pty's shell -> { how: 'killed' }, or
// { how: 'timeout' } when none were found (also when the pty itself exits).
const waiters = new Map(); // termId -> Set<{ tail, check, exit }>
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const PROMPT_RE = /PS [A-Za-z]:\\[^\r\n]*> ?$/;

function endsAtPrompt(text) {
  const lines = String(text).replace(ANSI_RE, '').split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trimEnd();
    if (l) return PROMPT_RE.test(l);
  }
  return false;
}

function feedWaiters(termId, chunk) {
  const set = waiters.get(termId);
  if (!set) return;
  for (const w of [...set]) {
    w.tail = (w.tail + chunk).slice(-8192);
    w.check();
  }
}

// claude processes anywhere under the shell (children of a claude are its own)
function claudePidsUnder(shellPid) {
  return new Promise((resolve) => {
    const script = '$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name); '
      + `$q = New-Object System.Collections.Queue; $q.Enqueue([uint32]${Number(shellPid) || 0}); `
      + 'while ($q.Count) { $p = $q.Dequeue(); foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and $c.ProcessId -ne $p) { '
      + "if ($c.Name -like 'claude*') { Write-Output $c.ProcessId } else { $q.Enqueue($c.ProcessId) } } } }";
    // null = the scan itself failed (unknown), [] = no claude under the shell
    execFile(accounts._psExe(), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: accounts._psEnv() }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(String(stdout || '').split(/\r?\n/).map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0));
    });
  });
}

function taskkill(pid) {
  const exe = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    const child = spawn(fs.existsSync(exe) ? exe : 'taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function waitClaudeExit(termId, timeoutMs = 15000, { kill = true } = {}) {
  return new Promise((resolve) => {
    const proc = sessions.get(termId);
    if (!proc) { resolve({ how: 'timeout' }); return; }
    let set = waiters.get(termId);
    if (!set) { set = new Set(); waiters.set(termId, set); }
    let finished = false;
    let timer = null;
    const w = { tail: '' };
    const finish = (how) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      set.delete(w);
      if (!set.size && waiters.get(termId) === set) waiters.delete(termId);
      logger.info(`claude exit wait: ${termId} -> ${how}`);
      resolve({ how });
    };
    // resolves: 'prompt' (PowerShell prompt seen), 'gone' (process scan: no claude
    // left), 'killed', or 'ptyexit' / 'unknown' — the caller must NOT type a
    // command then, it could land inside a claude that is still running.
    // A custom prompt (oh-my-posh…) never matches, so the scan polls too.
    w.check = () => { if (endsAtPrompt(w.tail)) finish('prompt'); };
    w.exit = () => finish('ptyexit');
    set.add(w);
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 15000);
    const poll = async () => {
      if (finished) return;
      const pids = await claudePidsUnder(proc.pid);
      if (finished) return;
      if (pids && !pids.length) { finish('gone'); return; }
      if (Date.now() < deadline) { timer = setTimeout(poll, 2500); return; }
      if (!pids) { finish('unknown'); return; }
      // kill = false ("move all agents"): a claude that didn't leave is left alone
      if (!kill) { finish('running'); return; }
      logger.warn(`claude exit wait: ${termId} still running after ${timeoutMs} ms, killing pid ${pids.join(',')}`);
      for (const pid of pids) await taskkill(pid);
      await new Promise(r => setTimeout(r, 800));
      const left = await claudePidsUnder(proc.pid);
      finish(left && !left.length ? 'killed' : 'unknown');
    };
    timer = setTimeout(poll, 2500);
  });
}

// is a claude running under this tab's shell? true / false / null (can't tell)
async function claudeRunning(termId) {
  const proc = sessions.get(termId);
  if (!proc) return null;
  const pids = await claudePidsUnder(proc.pid);
  return pids ? pids.length > 0 : null;
}

function write(termId, data) {
  const s = sessions.get(termId);
  if (s) {
    lastActivity.set(termId, Date.now()); // input counts as activity too (reload guard)
    s.write(data);
  }
}

function resize(termId, cols, rows) {
  const s = sessions.get(termId);
  if (s) {
    try { s.resize(cols, rows); } catch {}
  }
}

function kill(termId) {
  const s = sessions.get(termId);
  if (s) {
    const meta = metas.get(termId);
    if (meta?.statusFile) { try { fs.rmSync(meta.statusFile, { force: true }); } catch {} }
    // here, not only in onExit: the metas entry (its wsId) is gone by then
    try { fs.rmSync(endpointSettingsFor(meta?.wsId, termId), { force: true }); } catch {} // holds a key
    sessions.delete(termId);
    metas.delete(termId);
    buffers.delete(termId);
    lastActivity.delete(termId);
    lastOutput.delete(termId);
    try { s.kill(); } catch {}
  }
}

function killAll() {
  for (const id of [...sessions.keys()]) kill(id);
}

function alive(termId) {
  return sessions.has(termId);
}

// owning workspace of a live pty (null if unknown/dead) — the feed server's
// termId -> wsId lookup
function wsOf(termId) {
  return (sessions.has(termId) && metas.get(termId)?.wsId) || null;
}

// Layer 3: true when any pty produced output or received input recently — lets the
// (opt-in) dev watcher defer its reload/relaunch while agents are mid-run or the
// user is typing. Claude streams continuously while working, so a few seconds of
// silence is a reliable "idle" signal.
function busyNow({ idleMs = 5000, now = Date.now() } = {}) {
  for (const ts of lastActivity.values()) {
    if (now - ts < idleMs) return true;
  }
  return false;
}

// ms since this terminal last produced output (Infinity if never / dead)
function outputAge(termId, now = Date.now()) {
  const ts = lastOutput.get(termId);
  return ts ? now - ts : Infinity;
}

// Live ptys with their buffered output, so a reloaded renderer can re-attach to the
// still-running processes instead of killing and re-spawning them (Layer 2:
// a renderer reload must never kill an agent).
function list() {
  const out = [];
  for (const [termId] of sessions) {
    const b = buffers.get(termId);
    out.push({
      termId,
      cwd: metas.get(termId)?.cwd || '',
      buffer: b ? b.chunks.join('') : '',
    });
  }
  return out;
}

module.exports = {
  available,
  create,
  write,
  resize,
  kill,
  killAll,
  alive,
  wsOf,
  list,
  busyNow,
  outputAge,
  // the file the claude status hooks append to (main writes it too when the
  // feed's HTTP hooks stand in for the Git Bash ones)
  statusFileOf: (termId) => (metas.get(termId) || {}).statusFile || null,
  setAccount,
  accountFileFor,
  waitClaudeExit,
  claudeRunning,
  _endsAtPrompt: endsAtPrompt,
  writeEndpointSettings,
  clearEndpointSettings,
  clearInstanceEndpointSettings,
  endpointSettingsFor,
  _wrapper: CLAUDE_WRAPPER, // smoke parses it with Windows PowerShell's parser
  _withSinglePath: withSinglePath,
  onData: (fn) => { dataListener = fn; },
  onExit: (fn) => { exitListener = fn; },
};
