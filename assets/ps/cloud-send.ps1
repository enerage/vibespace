param([Parameter(Mandatory)][string]$TaskFile, [Parameter(Mandatory)][string]$Repo, [string]$Account = 'main-3oam')
# Starts a Claude Code cloud session on a VibeSpace account's cloud login, in a real console
# (claude --cloud refuses to run without an interactive terminal).
foreach ($k in 'CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL') { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
$env:CLAUDE_CONFIG_DIR = Join-Path $env:USERPROFILE ".vibespace\cloud\$Account"
Set-Location -LiteralPath $Repo
$task = Get-Content -Raw -LiteralPath $TaskFile
Write-Host "Sending to the cloud on $Account from $Repo ..." -ForegroundColor Cyan
& claude.exe --cloud $task
Write-Host "`nDone. The session is listed at https://claude.ai/code . You can close this window." -ForegroundColor Green
