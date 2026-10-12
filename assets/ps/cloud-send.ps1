param([Parameter(Mandatory)][string]$TaskFile, [Parameter(Mandatory)][string]$Repo, [string]$Account = 'main-3oam', [int]$TimeoutSec = 120)
# Starts a Claude Code cloud session on a VibeSpace account's cloud login.
# `claude --cloud` refuses to run without an interactive terminal, so agents start
# this in its OWN console window (it may be hidden: a hidden console is still a TTY):
#   powershell -NoProfile -Command "Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile','-File','<this file>','-TaskFile','<task file>','-Repo','<repo>'"
# Each run appends one line to ~/.vibespace/cloud/sent.log: time, exit code, repo, first task line.
# exit=0 = the session was created (the link is listed at https://claude.ai/code);
# exit=timeout = claude didn't finish within $TimeoutSec and was stopped.
# A run that didn't exit 0 also keeps claude's stderr in ~/.vibespace/cloud/logs/
# (stdout stays on the console: claude --cloud needs it to be a terminal).
#
# The repo is marked trusted in the cloud config's .claude.json first: in a hidden
# window nobody can answer claude's folder-trust prompt, and a launch in an untrusted
# repo hung forever (found by the FlexIQ agent, 2026-10-12). pwsh 7 only (ArgumentList).
foreach ($k in 'CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL') { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
$cloudRoot = Join-Path $env:USERPROFILE '.vibespace\cloud'
$configDir = Join-Path $cloudRoot $Account
$env:CLAUDE_CONFIG_DIR = $configDir
$code = 'error'
$task = ''
function Write-SentLog([string]$c, [string]$t) {
  $first = (($t -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
  Add-Content -LiteralPath (Join-Path $cloudRoot 'sent.log') -Value ("{0}`texit={1}`t{2}`t{3}" -f (Get-Date -Format s), $c, $Repo, $first)
}
try {
  $repoFull = (Resolve-Path -LiteralPath $Repo).ProviderPath
  $task = Get-Content -Raw -LiteralPath $TaskFile

  # pre-trust the repo (claude keys projects by the path with forward slashes)
  $cfg = Join-Path $configDir '.claude.json'
  if (Test-Path -LiteralPath $cfg) {
    $j = Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json -AsHashtable
    if (-not $j.ContainsKey('projects') -or $null -eq $j['projects']) { $j['projects'] = @{} }
    $key = $repoFull -replace '\\', '/'
    if (-not $j['projects'].ContainsKey($key)) { $j['projects'][$key] = @{} }
    if ($j['projects'][$key]['hasTrustDialogAccepted'] -ne $true) {
      $j['projects'][$key]['hasTrustDialogAccepted'] = $true
      $tmp = "$cfg.$PID.tmp"
      $j | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
      Move-Item -LiteralPath $tmp -Destination $cfg -Force
    }
  }

  $exe = (Get-Command claude.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $psi = [System.Diagnostics.ProcessStartInfo]::new($exe)
  $psi.ArgumentList.Add('--cloud')
  $psi.ArgumentList.Add($task)        # one argument, quoted correctly by .NET
  $psi.UseShellExecute = $false       # inherits this (hidden) console = a TTY
  $psi.WorkingDirectory = $repoFull
  $psi.RedirectStandardError = $true  # the error text of a failed run (a hidden console shows nothing)
  $p = [System.Diagnostics.Process]::Start($psi)
  $errTask = $p.StandardError.ReadToEndAsync()
  if ($p.WaitForExit($TimeoutSec * 1000)) { $p.WaitForExit(); $code = "$($p.ExitCode)" }
  else { try { $p.Kill($true) } catch {}; $code = 'timeout' }
  if ($code -ne '0') {
    $logDir = Join-Path $cloudRoot 'logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $errFile = Join-Path $logDir ("{0}-{1}.err.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), (Split-Path $repoFull -Leaf))
    $errText = if ($errTask.Wait(3000)) { $errTask.Result } else { '(no stderr captured)' }
    Set-Content -LiteralPath $errFile -Value $errText -Encoding utf8NoBOM
    $code = "$code (see $errFile)"
  }
} catch {
  $code = 'error'
  $task = "$($_.Exception.Message) | $task"
}
Write-SentLog $code $task
