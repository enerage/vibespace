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
const { spawn, spawnSync, execFile } = require('node:child_process');

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
  // macOS env is case-sensitive: PATH is the one key ("Path" would be another variable)
  if (process.platform === 'darwin') { env.PATH = value; return env; }
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH') delete env[k];
  }
  env.Path = value;
  return env;
}

function readPath(env) {
  if (process.platform === 'darwin') return env.PATH || '';
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH' && env[k]) return env[k];
  }
  return '';
}

function ensureClaudeOnPath(env) {
  const claudeDir = path.join(os.homedir(), '.local', 'bin');
  if (process.platform === 'darwin') {
    if (fs.existsSync(claudeDir)) {
      const cur = readPath(env);
      const already = cur.split(path.delimiter).some(p => p.trim().replace(/(.)\/+$/, '$1') === claudeDir);
      if (!already) withSinglePath(env, cur ? `${claudeDir}${path.delimiter}${cur}` : claudeDir);
    }
    return env;
  }
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
  // macOS: no System32. The login shell rebuilds PATH itself (path_helper, brew
  // shellenv); this only guarantees the basics for whatever runs before it.
  if (process.platform === 'darwin') {
    const parts = readPath(env).split(path.delimiter).map(s => s.trim()).filter(Boolean);
    const have = new Set(parts);
    for (const dir of U.darwinFallbackDirs()) {
      if (!have.has(dir)) { parts.push(dir); have.add(dir); }
    }
    return withSinglePath(env, parts.join(path.delimiter));
  }
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

// macOS: the same `claude` function for zsh and bash (POSIX syntax plus `local`),
// defined by our rc files (shellInitFiles) after the user's own rc ran. Same
// semantics as CLAUDE_WRAPPER, incl. the DRYRUN lines smoke parses. A token
// account's token is a Keychain generic password (service
// VibeSpace-account-<id>, account `vibespace`, stored by accounts.cjs): read
// here and exported ONLY into the subshell that runs this one claude (never
// argv, never printed). `command claude` is the real binary, never this function.
const KEYCHAIN_ACCOUNT = 'vibespace';
function posixClaudeFunction(kind) {
  const findExe = kind === 'zsh' ? 'whence -p claude' : 'type -P claude';
  return `unalias claude 2>/dev/null
function claude {
${kind === 'zsh' ? '  emulate -L zsh\n' : ''}  local __vs_plain=0 __vs_acct=login __vs_eps= __vs_own=0 __vs_has=0 __vs_x= __vs_r= __vs_n=0 __vs_i=0 __vs_tag= __vs_line= __vs_tok=
  case "\${1-}" in
    ${CLAUDE_SUBCOMMANDS.join('|')}) __vs_plain=1 ;;
  esac
  for __vs_x in "$@"; do
    case "$__vs_x" in -p|--print|-v|--version|-h|--help) __vs_plain=1 ;; esac
  done
  if [ "$__vs_plain" = 0 ]; then
    if [ -n "\${VIBESPACE_ACCOUNT_FILE-}" ] && [ -f "$VIBESPACE_ACCOUNT_FILE" ]; then
      __vs_r=$(<"$VIBESPACE_ACCOUNT_FILE")
      __vs_r=\${__vs_r#"\${__vs_r%%[![:space:]]*}"}
      __vs_r=\${__vs_r%"\${__vs_r##*[![:space:]]}"}
      if [ -n "$__vs_r" ]; then __vs_acct=$__vs_r; fi
    fi
    # an API endpoint account: main wrote this tab's settings (hooks + env) next
    # to the account file; claude gets that file INSTEAD of the hook settings
    if [ "$__vs_acct" != login ] && [ -n "\${VIBESPACE_ACCOUNT_FILE-}" ]; then
      case "\${VIBESPACE_ACCOUNT_FILE##*/}" in
        *.*) __vs_x="\${VIBESPACE_ACCOUNT_FILE%.*}.settings.json" ;;
        *) __vs_x="$VIBESPACE_ACCOUNT_FILE.settings.json" ;;
      esac
      if [ -f "$__vs_x" ]; then __vs_eps=$__vs_x; fi
    fi
    if [ "$__vs_acct" = login ] && [ -n "\${VIBESPACE_RC_LABEL-}" ]; then
      __vs_has=0
      for __vs_x in "$@"; do case "$__vs_x" in --remote-control|--rc) __vs_has=1 ;; esac; done
      if [ "$__vs_has" = 0 ]; then set -- "$@" --remote-control "$VIBESPACE_RC_LABEL"; fi
    fi
    if [ -n "$__vs_eps" ]; then
      # our hook settings are replaced by the tab's file; any OTHER --settings
      # would be a claude without the endpoint's env, i.e. on the /login.
      # Rotates the args: each original is shifted off and re-appended or dropped.
      __vs_n=$#
      __vs_i=0
      while [ "$__vs_i" -lt "$__vs_n" ]; do
        __vs_x=$1
        shift
        __vs_i=$((__vs_i + 1))
        if [ "$__vs_x" = --settings ] && [ "$__vs_i" -lt "$__vs_n" ] && { { [ -n "\${VIBESPACE_CLAUDE_SETTINGS-}" ] && [ "$1" = "$VIBESPACE_CLAUDE_SETTINGS" ]; } || [ "$1" = "$__vs_eps" ]; }; then
          shift
          __vs_i=$((__vs_i + 1))
          continue
        fi
        case "$__vs_x" in --settings|--settings=*) __vs_own=1 ;; esac
        set -- "$@" "$__vs_x"
      done
      set -- "$@" --settings "$__vs_eps"
    elif [ -n "\${VIBESPACE_CLAUDE_SETTINGS-}" ]; then
      __vs_has=0
      for __vs_x in "$@"; do if [ "$__vs_x" = --settings ]; then __vs_has=1; fi; done
      if [ "$__vs_has" = 0 ]; then set -- "$@" --settings "$VIBESPACE_CLAUDE_SETTINGS"; fi
    fi
  fi
  if [ "$__vs_own" = 1 ]; then
    printf '%s\\n' "This tab runs on the endpoint account '$__vs_acct': start claude without --settings" >&2
    return 1
  fi
  if [ -n "\${VIBESPACE_CLAUDE_DRYRUN-}" ]; then
    if [ "$__vs_plain" = 0 ]; then
      if [ "$__vs_acct" = login ]; then __vs_tag=login
      elif [ -n "$__vs_eps" ]; then __vs_tag="$__vs_acct|endpoint"
      elif /usr/bin/security find-generic-password -s "VibeSpace-account-$__vs_acct" -a ${KEYCHAIN_ACCOUNT} >/dev/null 2>&1; then __vs_tag="$__vs_acct|token"
      else __vs_tag="$__vs_acct|missing"
      fi
      printf 'VSACCT[%s]\\n' "$__vs_tag"
    fi
    __vs_line=
    __vs_i=0
    for __vs_x in "$@"; do
      if [ "$__vs_i" = 0 ]; then __vs_line=$__vs_x; else __vs_line="$__vs_line|$__vs_x"; fi
      __vs_i=1
    done
    printf 'VSCLAUDE[%s]\\n' "$__vs_line"
    return 0
  fi
  if ! ${findExe} >/dev/null 2>&1; then printf '%s\\n' 'claude is not on PATH' >&2; return 127; fi
  if [ "$__vs_plain" = 1 ]; then command claude "$@"; return; fi
  if [ "$__vs_acct" != login ] && [ -z "$__vs_eps" ]; then
    __vs_tok=$(/usr/bin/security find-generic-password -s "VibeSpace-account-$__vs_acct" -a ${KEYCHAIN_ACCOUNT} -w 2>/dev/null)
    if [ -z "$__vs_tok" ]; then
      printf '%s\\n' "VibeSpace: account '$__vs_acct' token is unreadable — re-add it in Preferences" >&2
      return 1
    fi
    ( export CLAUDE_CODE_OAUTH_TOKEN="$__vs_tok"; command claude "$@" )
    __vs_x=$?
    __vs_tok=
    return "$__vs_x"
  fi
  # the login and endpoint accounts: no inherited token for this call
  if [ -n "\${CLAUDE_CODE_OAUTH_TOKEN+x}" ]; then ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" ); return; fi
  command claude "$@"
}
`;
}

// macOS prompt detection: our rc's precmd prints this private OSC before every
// prompt (zsh precmd / bash PROMPT_COMMAND). xterm.js ignores OSC numbers it has
// no handler for (6.0: the OSC parser's fallback handler is a no-op), so it is
// forwarded as-is. "The marker arrived" = the shell has its prompt back.
const PROMPT_MARK = '\x1b]7777;vibespace-prompt\x07';
const PROMPT_MARK_PRINTF = '\\033]7777;vibespace-prompt\\007';

// The rc files, VS Code shell-integration style: ZDOTDIR points at our dir, and
// each of our zsh files first runs the user's own one from their real ZDOTDIR
// (or $HOME; passed as VIBESPACE_USER_ZDOTDIR), with ZDOTDIR set to theirs while
// it runs. .zshrc then gives ZDOTDIR back (zsh reads the user's .zlogin directly
// after that, and shells started from this one are plain shells) and defines
// claude() + the precmd marker. bash: --rcfile starts a NON-login shell, so the
// file runs the login files itself.
function shellInitFiles() {
  const head = '# Written by VibeSpace (main/ptyhost.cjs) at start; edits are overwritten.\n';
  const giveBack = `if [[ -n "\${VIBESPACE_USER_ZDOTDIR_SET-}" ]]; then export ZDOTDIR=$VIBESPACE_USER_ZDOTDIR; else unset ZDOTDIR; fi
unset VIBESPACE_USER_ZDOTDIR_SET
`;
  const runUser = (name, cond = '') => `if [[ ${cond}-f "$VIBESPACE_USER_ZDOTDIR/${name}" && "$VIBESPACE_USER_ZDOTDIR" != "$VIBESPACE_ZDOTDIR" ]]; then
  ZDOTDIR=$VIBESPACE_USER_ZDOTDIR
  builtin source "$VIBESPACE_USER_ZDOTDIR/${name}"
`;
  return {
    '.zshenv': `${head}: \${VIBESPACE_USER_ZDOTDIR:=$HOME}
VIBESPACE_ZDOTDIR=\${VIBESPACE_ZDOTDIR:-$ZDOTDIR}
${runUser('.zshenv')}  # a .zshenv may move ZDOTDIR (e.g. to ~/.config/zsh): follow it
  if [[ "\${ZDOTDIR-}" != "$VIBESPACE_USER_ZDOTDIR" ]]; then
    if [[ -n "\${ZDOTDIR-}" ]]; then VIBESPACE_USER_ZDOTDIR=$ZDOTDIR; VIBESPACE_USER_ZDOTDIR_SET=1; else VIBESPACE_USER_ZDOTDIR=$HOME; VIBESPACE_USER_ZDOTDIR_SET=; fi
  fi
fi
ZDOTDIR=$VIBESPACE_ZDOTDIR
`,
    '.zprofile': `${head}${runUser('.zprofile', '-o login && ')}fi
ZDOTDIR=$VIBESPACE_ZDOTDIR
`,
    '.zshrc': `${head}# /etc/zshrc ran with ZDOTDIR=here: keep the history where the user's is
if [[ "\${HISTFILE-}" == "$VIBESPACE_ZDOTDIR"/* ]]; then HISTFILE=$VIBESPACE_USER_ZDOTDIR/\${HISTFILE##*/}; fi
${runUser('.zshrc')}fi
${giveBack}${posixClaudeFunction('zsh')}__vibespace_precmd() { local s=$?; builtin printf '${PROMPT_MARK_PRINTF}'; return $s; }
autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook precmd __vibespace_precmd 2>/dev/null || precmd_functions+=(__vibespace_precmd)
`,
    // only reached when ZDOTDIR is still ours here (.zshrc not read)
    '.zlogin': `${head}${runUser('.zlogin', '-o login && ')}fi
${giveBack}`,
    bashrc: `${head}if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
elif [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"
fi
${posixClaudeFunction('bash')}__vibespace_precmd() { local s=$?; builtin printf '${PROMPT_MARK_PRINTF}'; return $s; }
case "\${PROMPT_COMMAND-}" in
  *__vibespace_precmd*) ;;
  *) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND
}__vibespace_precmd" ;;
esac
`,
  };
}

// <dataRoot>/shell/<content hash>/: written once per process (idempotent, one
// dir per content so two VibeSpace versions never fight over the same files)
let shellDirCache = null;
function shellInitDir() {
  if (shellDirCache && fs.existsSync(path.join(shellDirCache, '.zshrc'))) return shellDirCache;
  const files = shellInitFiles();
  const hash = require('node:crypto').createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  const dir = path.join(U.dataRoot(), 'shell', hash);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(dir, name);
    let cur = null;
    try { cur = fs.readFileSync(f, 'utf8'); } catch {}
    if (cur === text) continue;
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
  }
  shellDirCache = dir;
  return dir;
}

// macOS: the user's $SHELL when it is zsh or bash (else zsh), interactive, as a
// login shell like Terminal.app (zsh -l; bash via its rc file, see above).
// Mutates env (ZDOTDIR & co). Without our rc dir it still starts a plain shell.
function posixLaunch(env) {
  const user = U.darwinLoginShell();
  const base = path.posix.basename(user);
  const file = base === 'zsh' || base === 'bash' ? user : '/bin/zsh';
  const kind = base === 'bash' ? 'bash' : 'zsh';
  let dir = null;
  try { dir = shellInitDir(); } catch (e) { logger.warn(`pty shell rc files not written: ${e.message}`); }
  if (kind === 'bash') return { file, args: dir ? ['--rcfile', path.join(dir, 'bashrc'), '-i'] : ['-l', '-i'] };
  if (dir) {
    // the user's own ZDOTDIR; one of ours (a VibeSpace started from a VibeSpace
    // terminal) counts as unset
    const ours = path.join(U.dataRoot(), 'shell') + path.sep;
    const orig = env.ZDOTDIR && !String(env.ZDOTDIR).startsWith(ours) ? String(env.ZDOTDIR) : '';
    env.VIBESPACE_USER_ZDOTDIR = orig || os.homedir();
    if (orig) env.VIBESPACE_USER_ZDOTDIR_SET = '1'; else delete env.VIBESPACE_USER_ZDOTDIR_SET;
    env.VIBESPACE_ZDOTDIR = dir;
    env.ZDOTDIR = dir;
  }
  return { file, args: ['-l', '-i'] };
}

// node-pty 1.1.0 ships its darwin spawn-helper as mode 0644, and every spawn then
// fails with "posix_spawnp failed". Dev installs get it fixed here once; the
// packaged app is fixed at build time (a read-only bundle must not crash this).
let spawnHelperChecked = false;
function ensureSpawnHelper() {
  if (spawnHelperChecked || process.platform !== 'darwin') return;
  spawnHelperChecked = true;
  let root;
  try { root = path.dirname(require.resolve('node-pty/package.json')); } catch { return; }
  root = root.replace('app.asar', 'app.asar.unpacked');
  const helpers = [path.join(root, 'build', 'Release', 'spawn-helper')];
  try {
    for (const d of fs.readdirSync(path.join(root, 'prebuilds'))) {
      if (d.startsWith('darwin-')) helpers.push(path.join(root, 'prebuilds', d, 'spawn-helper'));
    }
  } catch {}
  for (const h of helpers) {
    try {
      if ((fs.statSync(h).mode & 0o111) === 0o111) continue;
      fs.chmodSync(h, 0o755);
      logger.info(`pty spawn-helper made executable: ${h}`);
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn(`pty spawn-helper chmod failed: ${h}: ${e.message}`);
    }
  }
}

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
  let proc;
  if (process.platform === 'darwin') {
    ensureSpawnHelper();
    // a Finder-launched app has no locale: zsh's line editor and claude's UI
    // then mangle anything non-ASCII (Terminal.app sets this too)
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
    // Apple's bash 3.2 prints "The default interactive shell is now zsh…" in
    // every new terminal of a bash user (seen on the CI runner)
    env.BASH_SILENCE_DEPRECATION_WARNING = '1';
    const sh = posixLaunch(env);
    proc = pty.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env });
  } else {
    proc = pty.spawn('powershell.exe', shellArgs(), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConpty: true,
    });
  }
  sessions.set(termId, proc);
  promptState.delete(termId);
  metas.set(termId, { cwd, statusFile, wsId });
  buffers.set(termId, { chunks: [], len: 0 });
  logger.info(`pty spawn: ${termId} cwd=${cwd}`);
  proc.onData(chunk => {
    // a killed pty stays open until its tree kill is done (~1 s): its last
    // output belongs to no tab (and must not stamp busyNow or a re-created id)
    if (sessions.get(termId) !== proc) return;
    const t = Date.now();
    lastActivity.set(termId, t);
    lastOutput.set(termId, t);
    pushBuffer(termId, chunk);
    if (process.platform === 'darwin') notePrompt(termId, chunk);
    feedWaiters(termId, chunk);
    dataListener(termId, chunk);
  });
  proc.onExit(({ exitCode }) => {
    // create() on a live termId kills the old pty, whose exit lands after the
    // new one took the id (kill closes the pty only after its tree kill, ~1 s):
    // that exit must not clean up, or report as dead, the NEW pty
    const owner = sessions.get(termId);
    if (owner && owner !== proc) { logger.info(`pty exit: ${termId} code=${exitCode} (replaced pty, ignored)`); return; }
    sessions.delete(termId);
    const meta = metas.get(termId);
    if (meta?.statusFile) { try { fs.rmSync(meta.statusFile, { force: true }); } catch {} }
    try { fs.rmSync(endpointSettingsFor(meta?.wsId, termId), { force: true }); } catch {} // holds a key
    metas.delete(termId);
    buffers.delete(termId);
    lastActivity.delete(termId);
    lastOutput.delete(termId);
    promptState.delete(termId);
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

// On top of base + env: the endpoint's /model picker rows, slot names and the
// Fable slot (accounts.endpointTabSettings, derived from the env at every
// write), and opts.hooks (claudefeed.modelSwitchHooks: endpoint tabs only).
function writeEndpointSettings(termId, wsId, baseSettingsPath, env, opts = {}) {
  const file = endpointSettingsFor((metas.get(termId) || {}).wsId || wsId, termId);
  let base = {};
  try { if (baseSettingsPath) base = JSON.parse(fs.readFileSync(baseSettingsPath, 'utf8')) || {}; } catch {}
  const extra = accounts.endpointTabSettings(env);
  const settings = { ...base, env: { ...(base.env || {}), ...extra.env, ...env } };
  if (extra.modelPicker) settings.modelPicker = extra.modelPicker;
  if (opts.hooks && typeof opts.hooks === 'object') {
    settings.hooks = { ...(settings.hooks || {}) };
    for (const [ev, list] of Object.entries(opts.hooks)) settings.hooks[ev] = [...(settings.hooks[ev] || []), ...list];
  }
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

// macOS: no prompt regex (zsh themes vary endlessly); our precmd marker in the
// output written since the wait began = the shell printed its prompt again
function endsAtPrompt(text, platform = process.platform) {
  if (platform === 'darwin') return String(text).includes(PROMPT_MARK);
  const lines = String(text).replace(ANSI_RE, '').split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trimEnd();
    if (l) return PROMPT_RE.test(l);
  }
  return false;
}

// macOS, per pty: did the shell print our prompt marker after the last Enter
// typed into it? (the marker can be split across two chunks: keep a tail)
const promptState = new Map(); // termId -> { at, carry }
function notePrompt(termId, chunk) {
  let p = promptState.get(termId);
  if (!p) { p = { at: false, carry: '' }; promptState.set(termId, p); }
  const s = p.carry + chunk;
  if (s.includes(PROMPT_MARK)) p.at = true;
  p.carry = s.slice(-(PROMPT_MARK.length - 1));
}

// true / false; null = unknown (not macOS, or no such pty)
function atPrompt(termId) {
  if (process.platform !== 'darwin' || !sessions.has(termId)) return null;
  return Boolean(promptState.get(termId)?.at);
}

function feedWaiters(termId, chunk) {
  const set = waiters.get(termId);
  if (!set) return;
  for (const w of [...set]) {
    w.tail = (w.tail + chunk).slice(-8192);
    w.check();
  }
}

// ---- macOS process tree: ONE `ps` snapshot, walked in JS ----
// → [{ pid, ppid, pgid, args }]. args (not comm): the native claude runs from
// ~/.local/share/claude/versions/<version>, so its exec name may be the
// version, while argv[0] is what the shell ran ("claude").
function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4].trim() });
  }
  return out;
}

const PS_ARGS = ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'args='];

// null = the snapshot failed (unknown)
function psSnapshot() {
  return new Promise((resolve) => {
    execFile('/bin/ps', PS_ARGS, { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parsePs(stdout));
    });
  });
}

function psSnapshotSync() {
  try {
    const r = spawnSync('/bin/ps', PS_ARGS, { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? parsePs(r.stdout) : null;
  } catch { return null; }
}

// the mirror of Windows' Name -like 'claude*': argv[0] named claude*, the native
// installer's versions/<v> binary, or node/bun running claude (npm installs)
function isClaudeProc(args) {
  const t = String(args || '').trim().split(/\s+/);
  const a0 = path.posix.basename(t[0] || '');
  if (/^claude/i.test(a0) || /\/claude\/versions\//.test(t[0] || '')) return true;
  return /^(node|bun)$/.test(a0) && Boolean(t[1]) && (/\/claude-code\//.test(t[1]) || /^claude/i.test(path.posix.basename(t[1])));
}

// claude's own daemon and its --bg-pty-host jobs are never ours to kill (they are
// normally not under a tab anyway; `claude stop <id>` is the way to end them)
function isClaudeService(args) {
  return isClaudeProc(args) && /\s(?:daemon|--bg-pty-host)(?:\s|$)/.test(String(args));
}

function childrenOf(snap) {
  const kids = new Map();
  for (const p of snap) {
    if (p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  return kids;
}

// claude processes under the shell (children of a claude are its own) — pure
function claudePidsIn(snap, shellPid) {
  const kids = childrenOf(snap);
  const found = [];
  const seen = new Set([Number(shellPid)]);
  const q = [Number(shellPid)];
  while (q.length) {
    for (const c of kids.get(q.shift()) || []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      if (isClaudeProc(c.args)) found.push(c.pid); else q.push(c.pid);
    }
  }
  return found;
}

// what a tree kill signals — pure. pids: every descendant of the roots (+ the
// roots when includeRoots); pgids: their process groups, so members that were
// already re-parented to launchd die too. Never our own group, never a shell's
// group (signalling it would hit the tab's shell itself), never 0/1.
function treeTargets(snap, rootPids, { includeRoots = false, shellPids = [] } = {}) {
  const kids = childrenOf(snap);
  const byPid = new Map(snap.map(p => [p.pid, p]));
  const protect = new Set([process.pid, ...shellPids.map(Number)]);
  const pids = new Set();
  const q = [];
  for (const r of rootPids.map(Number)) {
    const e = byPid.get(r);
    if (includeRoots && e && !isClaudeService(e.args)) pids.add(r);
    q.push(r);
  }
  const seen = new Set(q);
  while (q.length) {
    for (const c of kids.get(q.shift()) || []) {
      if (seen.has(c.pid) || isClaudeService(c.args)) continue;
      seen.add(c.pid);
      pids.add(c.pid);
      q.push(c.pid);
    }
  }
  for (const p of protect) pids.delete(p);
  const noGroup = new Set([0, 1]);
  for (const p of protect) { noGroup.add(p); const g = byPid.get(p)?.pgid; if (g) noGroup.add(g); }
  const pgids = new Set();
  for (const pid of pids) {
    const g = byPid.get(pid)?.pgid;
    if (g > 1 && !noGroup.has(g)) pgids.add(g);
  }
  return { pids: [...pids], pgids: [...pgids] };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function signalTargets({ pids, pgids }, sig) {
  for (const pid of pids) { try { process.kill(pid, sig); } catch {} }
  for (const g of pgids) { try { process.kill(-g, sig); } catch {} }
}

const KILL_GRACE_MS = 1500;

// SIGTERM the tree + its groups, wait up to ~1.5 s, SIGKILL whatever survived.
// Resolves when done (false = the snapshot failed, nothing was signalled).
async function killTreesPosix(rootPids, opts = {}) {
  const snap = await psSnapshot();
  if (!snap) return false;
  const t = treeTargets(snap, rootPids, opts);
  if (!t.pids.length && !t.pgids.length) return true;
  signalTargets(t, 'SIGTERM');
  const end = Date.now() + KILL_GRACE_MS;
  while (Date.now() < end && t.pids.some(pidAlive)) await new Promise(r => setTimeout(r, 100));
  signalTargets({ pids: t.pids.filter(pidAlive), pgids: t.pgids }, 'SIGKILL');
  return true;
}

// the same, synchronously (killAll at quit: an async kill would race the exit)
function killTreesPosixSync(rootPids, opts = {}) {
  const snap = psSnapshotSync();
  if (!snap) return false;
  const t = treeTargets(snap, rootPids, opts);
  if (!t.pids.length && !t.pgids.length) return true;
  signalTargets(t, 'SIGTERM');
  const end = Date.now() + KILL_GRACE_MS;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end && t.pids.some(pidAlive)) Atomics.wait(nap, 0, 0, 50);
  signalTargets({ pids: t.pids.filter(pidAlive), pgids: t.pgids }, 'SIGKILL');
  return true;
}

// claude processes anywhere under the shell (children of a claude are its own)
function claudePidsUnder(shellPid) {
  if (process.platform === 'darwin') return psSnapshot().then(snap => (snap ? claudePidsIn(snap, shellPid) : null));
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

function taskkillExe() {
  const exe = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
  return fs.existsSync(exe) ? exe : 'taskkill.exe';
}

function taskkill(pid) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(taskkillExe(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { resolve(false); return; }
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
    // resolves: 'prompt' (PowerShell prompt / macOS precmd marker seen), 'gone' (process scan: no claude
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
      if (process.platform === 'darwin') await killTreesPosix(pids, { includeRoots: true, shellPids: [proc.pid] });
      else for (const pid of pids) await taskkill(pid);
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
    // macOS: Enter submits a command line, so the shell no longer sits at its prompt
    if (process.platform === 'darwin' && String(data).includes('\r')) { const p = promptState.get(termId); if (p) p.at = false; }
    s.write(data);
  }
}

function resize(termId, cols, rows) {
  const s = sessions.get(termId);
  if (s) {
    try { s.resize(cols, rows); } catch {}
  }
}

// Closing the pty alone (s.kill() = ClosePseudoConsole) only ends processes
// ATTACHED to the pseudoconsole. Claude starts its MCP stdio servers hidden
// (`cmd /c npx …` with their own invisible console), so they are not attached,
// and one that ignores stdin EOF lives on forever (124 orphaned mcp-postgres
// node processes, 2026-09-29). So the whole tree under the shell is killed
// first. ORDER MATTERS: taskkill /T walks the tree from the shell pid, and once
// the pty is closed the shell is gone and taskkill finds nothing (a
// fire-and-forget taskkill next to s.kill() lost that race 3 times out of 3).
// So the pty closes when taskkill is done (~1 s), or after 5 s at the latest.
function killTreeThenPty(s) {
  let closed = false;
  let timer = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { s.kill(); } catch {}
  };
  timer = setTimeout(close, 5000);
  const pid = Number(s.pid) || 0;
  // macOS: the same contract with signals. The shell itself is left to the pty
  // close (SIGHUP); its descendants and their groups go first (killTreesPosix)
  if (pid > 0 && process.platform === 'darwin') killTreesPosix([pid], { shellPids: [pid] }).then(close, close);
  else if (pid > 0) taskkill(pid).then(close, close);
  else close();
}

// tree = false: the caller already killed the process trees (killAll)
function kill(termId, { tree = true } = {}) {
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
    promptState.delete(termId);
    if (tree) killTreeThenPty(s);
    else { try { s.kill(); } catch {} }
  }
}

// window close / app quit: ONE synchronous taskkill for every shell tree (blocks
// main ~1 s). An async one would race the process exit: the exit closes the
// ptys, the shells die first, and taskkill /T then finds no tree to walk.
function killAll() {
  const ids = [...sessions.keys()];
  if (!ids.length) return;
  if (process.platform === 'darwin') {
    const shells = ids.map(id => Number(sessions.get(id)?.pid) || 0).filter(pid => pid > 0);
    if (shells.length) { try { killTreesPosixSync(shells, { shellPids: shells }); } catch {} }
    for (const id of ids) kill(id, { tree: false });
    return;
  }
  const pidArgs = [];
  for (const id of ids) {
    const pid = Number(sessions.get(id)?.pid) || 0;
    if (pid > 0) pidArgs.push('/PID', String(pid));
  }
  if (pidArgs.length) {
    try {
      spawnSync(taskkillExe(), [...pidArgs, '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    } catch {}
  }
  for (const id of ids) kill(id, { tree: false });
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
  atPrompt, // macOS: the shell printed its prompt marker after the last Enter
  writeEndpointSettings,
  clearEndpointSettings,
  clearInstanceEndpointSettings,
  endpointSettingsFor,
  _wrapper: CLAUDE_WRAPPER, // smoke parses it with Windows PowerShell's parser
  _withSinglePath: withSinglePath,
  // macOS pieces smoke checks: the zsh/bash claude() text (zsh -n / bash -n), the
  // rc dir, the prompt marker, and the pure ps-snapshot walks
  _wrapperPosix: { zsh: posixClaudeFunction('zsh'), bash: posixClaudeFunction('bash') },
  _shellInitDir: shellInitDir,
  _shellInitFiles: shellInitFiles,
  _promptMark: PROMPT_MARK,
  _parsePs: parsePs,
  _isClaudeProc: isClaudeProc,
  _claudePidsIn: claudePidsIn,
  _treeTargets: treeTargets,
  onData: (fn) => { dataListener = fn; },
  onExit: (fn) => { exitListener = fn; },
};
