// Text that terms.js types into a tab's PowerShell, or reads back from it.
// Pure, no imports, so node can test it (smoke imports this file directly).

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
export function setupPrefix(setup) {
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
