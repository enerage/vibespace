param([Parameter(Mandatory)][string]$TaskFile, [Parameter(Mandatory)][string]$Repo, [string]$Account = 'main-3oam')
# Starts a Claude Code cloud session on a VibeSpace account's cloud login.
# `claude --cloud` refuses to run without an interactive terminal, so agents start
# this in its OWN console window (it may be hidden: a hidden console is still a TTY):
#   powershell -NoProfile -Command "Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile','-File','<this file>','-TaskFile','<task file>','-Repo','<repo>'"
# Each run appends one line to ~/.vibespace/cloud/sent.log: time, exit code, repo, first task line.
# exit 0 = the session was created; the link is listed at https://claude.ai/code
foreach ($k in 'CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL') { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
$cloudRoot = Join-Path $env:USERPROFILE '.vibespace\cloud'
$env:CLAUDE_CONFIG_DIR = Join-Path $cloudRoot $Account
$code = -1
try {
  Set-Location -LiteralPath $Repo
  $task = Get-Content -Raw -LiteralPath $TaskFile
  & claude.exe --cloud $task
  $code = $LASTEXITCODE
} catch { $code = -2; $task = "$($_.Exception.Message)" }
$first = (($task -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
Add-Content -LiteralPath (Join-Path $cloudRoot 'sent.log') -Value ("{0}`texit={1}`t{2}`t{3}" -f (Get-Date -Format s), $code, $Repo, $first)
