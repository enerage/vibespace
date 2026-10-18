// Text that terms.js types into a tab's PowerShell, or reads back from it.
// Pure, no imports, so node can test it (smoke imports this file directly).
// On a Mac the tab's shell is zsh (or bash): the builders that type a command
// take a `platform` ('darwin' = the POSIX twins at the end of this file),
// which defaults to the window's (vs.platform), or node's when smoke runs it.
const HOST_PLATFORM = (globalThis.vs && globalThis.vs.platform)
  || (typeof process !== 'undefined' && process.platform) || 'win32';

// A PowerShell single-quoted literal. Inside one only quote characters are
// special, and PowerShell counts the typographic ones (‘ ’ ‚ ‛) as quotes too:
// doubling each one escapes it.
export function psQuote(s) {
  return "'" + String(s).replace(/['‘’‚‛]/g, (q) => q + q) + "'";
}

// the worktree setup command (⚙ Preferences) as its non-empty lines
export function setupLines(setup) {
  return String(setup || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

// A fresh worktree's setup command, typed in front of claude on the same line,
// so its output (npm ci…) shows in the tab. The setup goes in as a quoted
// string that PowerShell parses as its own script block and dot-sources: a `#`
// then comments out only the rest of ITS line, never the claude after it, and
// quotes or a syntax error in it can't break our line either (a parse error is
// caught like any other failure). Lines stay lines (joined with a newline).
// No -EncodedCommand: Defender flagged that pattern once (CLAUDE.md).
// claude starts even when the setup fails (the agent can fix it), after a
// one-line warning. Failed = a native exit code, a new $Error entry
// (non-terminating errors) or a terminating error (catch).
export function setupPrefix(setup, platform = HOST_PLATFORM) {
  if (platform === 'darwin') return setupPrefixSh(setup);
  const lines = setupLines(setup);
  if (!lines.length) return '';
  const src = lines.length === 1 ? psQuote(lines[0]) : `((${lines.map(psQuote).join(', ')}) -join [char]10)`;
  return '$vsE = $Error.Count; $global:LASTEXITCODE = 0; '
    + `try { . ([scriptblock]::Create(${src})) } catch { $vsE = -1; Write-Host $_ -ForegroundColor Red }; `
    + "if ($LASTEXITCODE -or $Error.Count -gt $vsE) { Write-Host 'VibeSpace: the worktree setup command failed; starting claude anyway' -ForegroundColor Yellow }; ";
}

// Claude refuses to resume a conversation that runs as one of its background
// jobs: "That session is running in the background (<job>). Run `claude attach
// <job>` … or `claude stop <job>` first". Found in a tab's pty output (escape
// sequences removed, so a wrapped line still matches) → { job } (job = the short
// id `claude attach` takes, or null when it doesn't look like one), else null.
const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g;
export const JOB_ID = /^[0-9a-f]{6,64}$/i;
export function bgRefusal(text) {
  const t = String(text || '').replace(ANSI, '').replace(/\s+/g, ' ');
  const m = /session\s*is\s*running\s*in\s*the\s*background\s*(?:\(\s*([^)\s]{1,64})\s*\))?[\s\S]{0,400}?claude\s*(?:stop|attach)/i.exec(t);
  if (!m) return null;
  return { job: m[1] && JOB_ID.test(m[1]) ? m[1] : null };
}

// ---------- Send to cloud (0.6.58) ----------
// Cloud sessions (`claude --cloud`, `--teleport`) run the REAL claude
// executable, never the tab's `claude` function (it adds our hook settings,
// --remote-control and the tab's account token, and a setup-token can't use
// cloud features). The task goes to claude as ONE argument, unchanged.

// One argument of a Windows command line, quoted so the C runtime /
// CommandLineToArgvW split gives back exactly `s`: always in double quotes, a
// quote as \", and backslashes doubled only where they precede a quote (or
// the closing one). Spaces, #, $, quotes and line breaks all survive.
export function crtQuote(s) {
  let out = '"';
  let bs = 0;
  for (const ch of String(s)) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') out += '\\'.repeat(bs * 2 + 1) + '"';
    else out += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

// A PowerShell expression for any string that is safe to TYPE into the
// prompt: a typed line break would submit the line and a typed tab would
// trigger completion, so those go in as [char]10 / [char]9; other control
// characters (escape sequences included) are dropped; CRLF becomes LF.
export function psString(s) {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const parts = t.split(/([\n\t])/).filter(p => p !== '')
    .map(p => (p === '\n' ? '[char]10' : p === '\t' ? '[char]9' : psQuote(p)));
  if (!parts.length) return "''";
  return parts.length === 1 ? parts[0] : `((${parts.join(', ')}) -join '')`;
}

// variables claude reads its credentials or endpoint from: each one would
// override the claude.ai login that cloud sessions need, so they are cleared
// for the call (and put back afterwards, like CLAUDE_CONFIG_DIR)
export const CLOUD_CLEAR_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

// the wrapper's own lookup (ptyhost CLAUDE_WRAPPER), a native claude.exe first:
// an npm `claude.cmd` would go through cmd.exe, which re-parses the arguments
const CLAUDE_EXE = '(@(Get-Command claude.exe, claude -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1).Source';

// The line typed into a plain tab that runs the real claude with `args`:
// CLAUDE_CONFIG_DIR = configDir (null = leave it, the /login account's own
// config), CLOUD_CLEAR_ENV removed, all of them restored when claude exits
// (finally), so the tab's shell stays a normal VibeSpace shell afterwards.
// The command line is built here (crtQuote) and handed to Process.Start
// as-is: Windows PowerShell 5.1's `& exe 'arg'` does NOT escape embedded
// quotes, so a task with a `"` in it would arrive split or stripped. The
// child inherits the console like `& exe` does. No -EncodedCommand (Defender,
// CLAUDE.md). exe: a fixed path instead of the lookup (smoke only).
// platform 'darwin': realClaudeLineSh.
export function realClaudeLine(args = [], { configDir = null, exe = null, platform = HOST_PLATFORM } = {}) {
  if (platform === 'darwin') return realClaudeLineSh(args, { configDir, exe });
  const clear = CLOUD_CLEAR_ENV.map(psQuote).join(', ');
  return `$vsX = ${exe ? psQuote(exe) : CLAUDE_EXE}; `
    + "if (-not $vsX) { Write-Host 'VibeSpace: claude.exe was not found on PATH' -ForegroundColor Red } else { "
    + `$vsK = @('CLAUDE_CONFIG_DIR', ${clear}); $vsV = @{}; foreach ($k in $vsK) { $vsV[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }; `
    + 'try { '
    + `foreach ($k in @(${clear})) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }; `
    + (configDir ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(configDir)}; ` : '')
    + `$vsI = New-Object System.Diagnostics.ProcessStartInfo $vsX; $vsI.Arguments = ${psString(args.map(crtQuote).join(' '))}; `
    + '$vsI.UseShellExecute = $false; $vsI.WorkingDirectory = (Get-Location).ProviderPath; '
    + '$vsP = [System.Diagnostics.Process]::Start($vsI); $vsP.WaitForExit(); $global:LASTEXITCODE = $vsP.ExitCode '
    + "} finally { foreach ($k in $vsK) { [Environment]::SetEnvironmentVariable($k, $vsV[$k], 'Process') } } }";
}

// the task as claude's `--cloud` value: trimmed, and never starting with `-`
// (claude's option parser would read it as a flag instead of the value)
export function cloudTask(task) {
  const t = String(task ?? '').replace(/\r\n?/g, '\n').trim();
  return t.startsWith('-') ? 'Task: ' + t : t;
}

// claude --cloud "<task>" in the repo (cloud clones its GitHub remote).
// opts = realClaudeLine's { configDir, exe, platform }, here and below.
export function cloudSendLine(task, opts = {}) {
  return realClaudeLine(['--cloud', cloudTask(task)], opts);
}

// claude --teleport <id>: the cloud session continues locally in this tab
export function teleportLine(id, opts = {}) {
  if (!CLOUD_ID.test(String(id || ''))) throw new Error('not a cloud session id');
  return realClaudeLine(['--teleport', id], opts);
}

// plain interactive claude in the account's cloud config dir: a fresh dir
// starts claude's own onboarding + claude.ai sign-in (or type /login)
export function cloudLoginLine(opts = {}) {
  return realClaudeLine([], opts);
}

// A cloud session in a tab's output: `https://claude.ai/code/<id>` or a bare
// `session_…` id (escape sequences removed first). → { id, url } or null.
// exclude: text whose ids don't count (the task itself, echoed by the shell).
export const CLOUD_ID = /^(?:session|cse)_[0-9A-Za-z]{8,64}$/;
const CLOUD_ID_IN = /(?<![0-9A-Za-z_])((?:session|cse)_[0-9A-Za-z]{8,64})(?![0-9A-Za-z_])/g;
export function cloudSession(text, { exclude = '' } = {}) {
  const t = String(text || '').replace(ANSI, '');
  const ex = String(exclude || '');
  const url = (id) => `https://claude.ai/code/${id}`;
  for (const m of t.matchAll(/https:\/\/claude\.ai\/code\/[^\s'"<>`]*/g)) {
    const raw = m[0].replace(/[.,;:!?)\]}]+$/, '');
    for (const h of raw.matchAll(CLOUD_ID_IN)) {
      if (!ex.includes(h[1])) return { id: h[1], url: raw.length <= 300 ? raw : url(h[1]) };
    }
  }
  for (const h of t.matchAll(CLOUD_ID_IN)) {
    if (!ex.includes(h[1])) return { id: h[1], url: url(h[1]) };
  }
  return null;
}

// `☁ fix the flaky login test` → the tab name's text: the first non-empty
// line, spaces collapsed, cut at a word near `max`
export function shortTask(task, max = 28) {
  const line = String(task ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'cloud task';
  const flat = line.replace(/\s+/g, ' ');
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp >= max / 2 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

// ---------- POSIX shells (macOS: zsh, or bash) ----------
// The twins of the PowerShell builders above, for the text typed into a Mac
// tab. It is typed at an interactive prompt, where a line break would submit
// the line, a tab would complete and an escape character would be a key
// binding: none of them is ever typed literally.

// A POSIX single-quoted word. Nothing inside one is special, in zsh and bash
// alike: no $, backticks or backslashes, and no `!` history expansion (both
// shells skip it inside single quotes). The quote itself closes the word, adds
// an escaped quote and reopens it: ' → '\''
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// One shell word for any string that is safe to TYPE (the psString twin):
// line breaks and tabs go in as $'\n' / $'\t' (ANSI-C quoting, zsh and bash)
// right next to the quoted parts, so the shell joins them into one word;
// other control characters are dropped; CRLF becomes LF.
export function shString(s) {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const parts = t.split(/([\n\t])/).filter(p => p !== '')
    .map(p => (p === '\n' ? "$'\\n'" : p === '\t' ? "$'\\t'" : shQuote(p)));
  return parts.length ? parts.join('') : "''";
}

// setupPrefix on a Mac: the setup runs through `eval` in a subshell, so a `#`
// comments out only the rest of ITS line, quotes or a syntax error in it can't
// break our line, and a `cd` or `exit` in it can't move or end the tab's shell
// (claude starts in the worktree either way). claude starts even when the
// setup fails, after the same one-line warning in yellow. Failed = eval's exit
// status, i.e. the setup's last command (or its syntax) failed.
export function setupPrefixSh(setup) {
  const lines = setupLines(setup);
  if (!lines.length) return '';
  return `( eval ${shString(lines.join('\n'))} ) || printf '\\033[33m%s\\033[0m\\n' `
    + `${shQuote('VibeSpace: the worktree setup command failed; starting claude anyway')}; `;
}

// realClaudeLine on a Mac. `env` runs claude straight from PATH (execvp), so
// the tab's `claude` shell function (our --settings / --remote-control /
// account wrapper) is never involved, and `command` keeps a user's own `env`
// alias or function out of it as well. CLOUD_CLEAR_ENV is unset and
// CLAUDE_CONFIG_DIR set (configDir null = left as it is) for claude ONLY: the
// tab's shell keeps its environment, so there is nothing to restore. Each
// argument is one shell word (shString): quotes, $, !, backticks, spaces and
// line breaks arrive unchanged. exe: a fixed path instead of `claude` (smoke).
export function realClaudeLineSh(args = [], { configDir = null, exe = null } = {}) {
  return 'command env ' + CLOUD_CLEAR_ENV.map(k => `-u ${k}`).join(' ')
    + (configDir ? ` CLAUDE_CONFIG_DIR=${shString(configDir)}` : '')
    + ' ' + (exe ? shString(exe) : 'claude')
    + args.map(a => ' ' + shString(a)).join('');
}
