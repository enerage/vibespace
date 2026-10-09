# CLAUDE.md

Guidance for Claude Code (and any agent) working on **VibeSpace** — a per-repo workspace
app: file tree + Monaco preview + named Claude Code agent terminals, one Windows app
identity per repository. Read this before changing things; it encodes decisions that were
learned the hard way on build day (full history in CHANGELOG.md).

## How we work (standing rules for every agent in this repo)

Knowledge is tracked **as we go**, never batched for later:

- Decision made → append one line to `DECISIONS.md` immediately.
- User-visible change → `CHANGELOG.md` section before reporting the work done.
- Hard-won lesson/gotcha → the matching bullet in this file, same day.
- New task/idea → `TODO.md`. Done task → checked off.
- User preference or project fact → your agent memory (with Why + How-to-apply).
- Valentin says **"update all docs"** → run the `/sync-docs` skill (the full sweep).
  It's a rule, not a UI feature — there is deliberately no button for it.
- A task is not done until the docs above are current. "I'll document it later"
  is how knowledge dies.
- **Commit + push a fix as soon as it's verified working** (live check or smoke),
  with its docs, in one commit. Never leave verified work sitting uncommitted.
  Several agents share this working tree, and a restart, crash or lost
  conversation strands it: the `claude` wrapper sat uncommitted for hours while
  it was the only thing tracking resumed conversations (Valentin, 2026-09-30).
  Stage only your own hunks, never `git add -A`. If you find verified work that
  is orphaned, commit it and say so in the message.

## Ground rules

- **Never reintroduce caching in the `app://` protocol** (`main/index.cjs`). It must read
  from disk and serve `Cache-Control: no-store`. `net.fetch(file://…)` caches and once
  shipped stale mixed bundles through the hot-reload path — that bug presented as
  "the UI randomly doesn't have the new code" and cost hours.
- **The splitter drag pattern** (`renderer/workspace/app.js`): capture the pane size once
  on `pointerdown`, apply cumulative `clientX/clientY` deltas to that frozen value,
  listen on `window` (capture) during the drag. Do NOT use `movementX/movementY`
  (spikes under capture), do NOT use `setPointerCapture` (breaks with remote-control
  software like UltraViewer), and do NOT derive steps from the rendered size (flexbox
  shrink feeds back and spirals — this was the original "glitchy resize").
- **The terminal pane owns its size** (`flex: 0 1 auto`, the viewer absorbs the rest).
  If you give both panes grow/shrink, the divider stops tracking the pointer 1:1.
- **xterm refit is throttled** (`terms.js`: 120 ms during drags, once on release).
  Per-pixel `fit()` → pty resize → ConPTY reflow is a visible storm.
- **Env copies on Windows: `Path`, not `PATH`.** `process.env` is case-insensitive,
  but `{ ...process.env }` is a plain object — writing `env.PATH` on the copy adds
  a SECOND key and the child may see the wrong one. Always go through ptyhost's
  `withSinglePath`/`readPath`. This one bug caused a day of "node/python/MCP not
  found in VibeSpace terminals" (2026-09-29). Also: never write Windows paths as JS
  string literals (`'C:\Windows'` → `C:Windows`); build them with `path.join`.
- **Right-click belongs to the app when it tracks the mouse.** Claude Code turns on
  mouse tracking after its trust screen and pastes on right-click itself; our
  contextmenu paste must skip when `term.modes.mouseTrackingMode !== 'none'` or
  every paste doubles. Test mouse behavior AFTER the trust prompt — before it,
  Claude hasn't enabled tracking yet (an early probe gave a false all-clear).
- **Per-workspace identity is load-bearing**: each workspace process sets its own
  `userData` dir AND `app.setAppUserModelId('vibespace.workspace.<id>')` *before* app
  ready; shortcuts carry the same AUMID (`assets/ps/set-shortcut.ps1` writes it through
  the shell property store — `Get-StartApps` verifies). Change the scheme and every
  existing pin breaks. **Pinning a running window whose AppID has no Start Menu
  .lnk makes Windows create a junk `Electron.lnk`** (Electron logo, no args) —
  that's why every window calls `claimTaskbarIdentity` (setAppDetails + ensure
  shortcut + purge junk). `Get-StartApps` showing a workspace named "Electron"
  = this bug. A pin still showing a stale icon after the .lnk + .ico are verified
  correct = Windows icon cache: stop explorer, delete
  `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`, start explorer
  (`ie4uinit -show` alone is not always enough — confirmed 2026-09-28).
- **A logo change needs a new icon PATH and a new taskbar button** (0.6.41).
  Windows caches a taskbar button's icon by file path and reads it only when
  it creates the button, so rebuilding `<id>.ico` in place left the old icon
  on the taskbar even after reopening the window. `workspaces.updateLogo`
  writes `<id>.v<stamp>.ico` (ids never contain a dot) and prunes older
  versions; `rebuildTaskbarButton` moves the window to `<aumid>.refresh` and
  back after 300 ms. What did NOT refresh it (all tested with taskbar
  screenshots): `setAppDetails` with the new path alone, `setSkipTaskbar`
  off/on, `SHCNE_UPDATEITEM` on the .lnk, `SHCNE_ASSOCCHANGED`. `hide()`/
  `show()` also works but blinks. Explorer's FOLDER view refreshes on its own,
  so a correct icon there proves nothing about the taskbar. To see a button
  that sits in the taskbar overflow, toggle `OverflowButton` through UI
  Automation and screenshot above it. Never read `ws.iconPath` once and keep
  it: it changes with every logo.
- **Closing a pty must kill its process TREE first** (`ptyhost.kill`, 0.6.52).
  ClosePseudoConsole only ends processes attached to the console; claude's MCP
  servers run in their own hidden console and survived as orphans (124
  mcp-postgres, 2026-09-29). `taskkill /T` walks from the shell pid, so it must
  FINISH before `s.kill()`: once the pty is closed the shell is gone and the
  tree can't be found (fire-and-forget lost that race 3/3). Hence the delayed
  close, and the `onData`/`onExit` owner checks for the dying pty.
- GPU acceleration is deliberately off (`app.disableHardwareAcceleration()`) — windows
  went blank over remote-display software. Renderers self-heal via
  `render-process-gone` → reload WITHOUT killing ptys — the renderer re-attaches.

## Session tracking (the resume magic)

Claude Code stores conversations in
`~/.claude/projects/<munged-repo>/<uuid>.jsonl` where munging replaces every
non-alphanumeric char with `-` (`D:\Repositories\Foo` → `D--Repositories-Foo`).
Key facts encoded in `main/sessions.cjs`:

- The `.jsonl` is created **when the first message is sent**, not at `claude` launch —
  discovery windows must not have short upper bounds. Exception (seen live,
  2.1.287): a claude started with `--remote-control` writes its `.jsonl`
  (~3.8 KB) BEFORE the first message.
- **The transcript lives under munged(<the claude's cwd>)**, not the repo's dir,
  when the tab's cwd isn't the repo root (worktree tabs). `pinFromFeed` accepts
  the feed's `transcript_path` (basename must equal the session id, file must
  exist), `sessions:check` gets the tab's cwd, and `offRepo` terms are skipped
  by the timing heuristic (it only scans the repo's dir).
- An unresolved terminal owns the earliest session file born after its claude launched
  and before the *next* terminal's claude launch; tabs resumed with a known id are
  pinned and never rediscovered.
- **Primary source since 0.6.20: the claude data feed.** Every statusLine/hook body
  carries `session_id` and arrives tagged with our term id, so main calls
  `sessions.pinFromFeed()` on each feed emit. That follows `/clear` (verified: the
  new transcript exists at once and it re-pinned in ~1.7 s), `/resume` and the
  picker. It pins only once the `.jsonl` exists, so a restore never resumes a
  conversation that was never saved. Feed-pinned terms are flagged `feed` and the
  timing heuristic never touches them.
- Verified live (2.1.284, no message sent): picking a conversation in the
  `claude --resume` picker, or typing `/resume <id>` in a running session, sends
  a statusLine tick with the new `session_id` within ~1–1.5 s. `pinFromFeed` pins
  it at once, so "pick, then restart before typing" keeps the pick for feed
  agents. `pickResumed` (mtime revival, which only fires after the old .jsonl
  gets a new write) is now just the pre-feed fallback. If a future claude
  stopped ticking there, a SessionStart COMMAND hook that curls the id to the
  feed server would close the gap (SessionStart never fires as an HTTP hook).
  + ▾ → "All conversations…" (was the ↺ Resume button, 0.6.20–0.6.37) =
  `pickSession`.
- The heuristic above is now only the fallback for agents without a feed
  (started before 0.6.16). Its known holes (manual `/resume`, near-simultaneous
  launches) remain for those only; see TODO.md.
- **Without `--settings` there is no feed, so no tracking.** A claude started
  without it was lost on restart (2026-09-29: a hand-`/resume`d conversation
  on a pre-feed build). So every pty's PowerShell starts with a `claude`
  function (ptyhost `CLAUDE_WRAPPER`, sent via `-EncodedCommand`). It adds
  `--settings $env:VIBESPACE_CLAUDE_SETTINGS` and `--remote-control
  $env:VIBESPACE_RC_LABEL` unless they're already given, and never touches
  subcommands or `-p`/`--version`/`--help` (a `-p` run would pin its session
  onto the tab). `VIBESPACE_CLAUDE_DRYRUN=1` prints the final args (smoke uses
  this).
- **Claude's `/resume` picker is case-sensitive about the drive letter**
  (anthropics/claude-code#90588, open). A session first recorded as `d:\…`
  (VS Code, cmd) is hidden from the list and refuses to open ("from a
  different directory"). `claude --resume <id>` works, so restore (by id) is
  unaffected (unpark too). Only + ▾ → All conversations… and a dead-session
  restore go through the picker.
  Repair (the issue's own workaround, done for 41 conversations on 2026-10-01):
  rewrite only the `"cwd":"x:\\` drive letter to uppercase in the `.jsonl`.
  Skip sessions listed in `~/.claude/sessions/*.json` (live) and files written
  in the last 2 min, back up first, and re-parse every line afterwards. New
  sessions started from the VS Code extension will keep producing `d:\`.

## Developing VibeSpace

- `npm run smoke` — 125 self-tests (as of 0.6.53) incl. pty echo and live session discovery. Run it after
  touching main-process code, **from a normal shell**: inside a Claude pty the stripped
  PATH and nested ConPTY break the pty test (`powershell.exe` "File not found" /
  AttachConsole) — prepend System32 to PATH and give it its own console, or just use a
  real terminal. A syntax error in smoke.cjs hangs the run SILENTLY (the require throws
  inside whenReady) — `node --check main/*.cjs` before every smoke run. The PACKAGED
  binary must also pass it: `dist\win-unpacked\VibeSpace.exe --smoke` — catches
  asar/path bugs (e.g. pty cwd error 267). `npm run rebuild` only needed after
  reinstalling node-pty.
- **Hot reload is opt-in** (`main/devwatch.cjs`, since 0.3.0): it only runs in a process
  started with `--watch` / `VIBESPACE_WATCH=1` (unpackaged builds only;
  `VIBESPACE_NO_WATCH=1` still force-disables; a watched launcher propagates the env to
  workspaces it spawns; `npm run dev` = launcher with watch). Saving `renderer/`+
  `preload/` reloads windows — **live ptys survive and the renderer re-attaches**
  (same termIds, scrollback restored; 0.4.0). Saving `main/` relaunches the process,
  deferred while any terminal is busy (`busyNow`, 5 s idle window). Default-off is
  deliberate: every unpackaged process
  used to watch, so one save bounced every open instance's agents. If *you* are an agent
  editing this repo from inside a VibeSpace window, work in a normal (non-watch) window.
  If you must land a watched-dir change while old watchers still run: batch ALL writes
  into one <400 ms burst (devwatch debounce), warn the user first, and expect one
  bounce — resume is verified working. Root-level files (CHANGELOG.md, TODO.md,
  RESEARCH-HOTRELOAD.md) are not watched.
- **"Typing is laggy" → grep the log for `lag:`** (`main/lagmon.cjs`, 0.6.35).
  `key→screen` ≈ `claude/pty echo` + high `cpu` = the machine (agents' test
  runs/builds) or claude itself; a big gap between the two, `renderer
  blocked` or `main loop stalled` = VibeSpace. Only single typed keys are
  timed (pastes and escape sequences don't echo 1:1). The renderer stall
  watch skips hidden/unfocused windows (Chromium throttles their timers) and
  main skips its first 30 s (boot blocks by design).
- Logs: `~/.vibespace/logs/<instance>.log` (dev-watch lines, pty spawns, session
  captures, renderer errors, term-status transitions). Renderer `console.warn/error`
  reach the log via `console-message`. Electron 35+ passes that event's `level` as a
  string ('warning'/'error'), so a numeric `>= 2` check alone silently drops every line.
  That happened from about 2026-09-26 until 2026-09-29. `VIBESPACE_DEBUG=1` for
  session-scan traces. Ctrl+Shift+D in a window copies a diagnostics bundle.
- **Agent status hooks** (0.5.0): claude tabs launch with
  `--settings <instance>/claude-hook-settings.json` injecting
  Notification/Stop/UserPromptSubmit/PreToolUse hooks that append
  working/waiting/done to `$VIBESPACE_TERM_STATUS` (set per pty by ptyhost).
  Since 0.6.22 those Git Bash hooks are only the fallback: when the claude data
  feed is listening, main appends the words itself from the feed's HTTP hooks
  (`status.wordForHook`). Command hooks BLOCK claude, and a cold bash start
  under load took >10 s ("UserPromptSubmit hook timed out"). Never put a
  spawn on the prompt path again.
  `main/status.cjs` watches and pushes `term:status` → tab lights, toasts, taskbar
  badge. Change the word set and all three of those together.
- **Claude data feed** (0.6.16): `main/claudefeed.cjs` runs a `127.0.0.1:<random port>`
  server; the same settings file adds a statusLine (`curl` POST to `/sl`) and
  `type: 'http'` hooks (`/hook/<Event>`), tab id in the `x-vs-term` header
  (`$VIBESPACE_TERM_ID`, set per pty by ptyhost). It must listen BEFORE any pty
  spawns: a dead port makes claude print red "hook error / ECONNREFUSED" lines in
  the TUI every turn. So `index.cjs` awaits `claudefeed.start()` first, and no port
  means no feed entries. SessionStart never fires as an HTTP hook, so don't rely on
  it. Hand-off rule: if `~/.claude/settings.json` has a statusLine command, ours
  pipes the same stdin into it and prints ITS output. Otherwise we print nothing,
  which leaves one blank row above claude's mode line. The command hooks stay
  as they are, so lights/toasts/badge survive a feed failure.
  **Layers (0.6.17):** the status files are the BASE state (working/waiting/done).
  The feed is the DETAIL layer on top of it: the lock/?/✕ light, the reason
  tooltip, the `3/7` pill, the activity strip and the peek card
  (`renderer/workspace/ui/feedui.js`). Since 0.6.42 the strip is a status bar
  BELOW the terminal (`#term-strip` comes after `#term-hosts`), so anything
  anchored to it (the task checklist) must flip upward when there's no room
  below. A tab with no feed must look exactly as it
  did before 0.6.16. The lights/toasts/badge rule now covers feed reasons too:
  `claudefeed.attentionText()` builds the text for the light tooltip, the strip
  and the toast body. A failed turn (StopFailure) fires no Stop hook, so main
  toasts and badges it from the feed. Account limits are shared across processes
  via `<dataRoot>/limits.json` (adopted when newer and < 6 h old). Screenshot
  testing: delete the throwaway home's log first, or a script grepping it for the
  feed port picks up a stale port from an earlier run.
  **0.6.20:**
  - **Instant attention.** PermissionRequest or the AskUserQuestion PreToolUse
    flips the base status to `waiting` through `main/attention.cjs`: an in-memory
    override applied via the same `applyStatus` path as the file listener. It
    never writes the hook-owned files.
  - While that dialog is open, a late PreToolUse `working` line is ignored. The
    tool running hands back `working` unless the turn ended (Stop's `done` wins).
  - Toasts fire once per waiting episode: they only fire when the status actually
    changes.
  - `prompt_cache.expires_at` is an ABSOLUTE epoch-seconds deadline (the last API
    request + ttl, 1 h here), so the cache countdown is client-side math.
  - PreCompact/PostCompact payloads are still unverified live and are read
    defensively.
  - Background agents: `claude agents --json --cwd <repo>` (about 0.8 s),
    filtered to `kind: 'background'`. `claude attach` ignores `--settings`, so an
    attach tab is a plain tab.
  - Screenshot mode's hard 10 s exit is too short on a loaded machine. The
    phase-5 script (`scratchpad/shot5.cjs`) drives a NORMAL window instead, with
    auto-resume off and `APPDATA` pointed at the throwaway home so the real Start
    Menu is never touched.
- **Agent board** (0.6.19, `renderer/workspace/ui/board.js`, ▦ or Ctrl+Shift+B):
  - It is an overlay inside `#term-hosts`, so xterms are never disposed or refit
    when it opens or closes.
  - Columns: Needs you / Working / Done / Other. Cards are updated in place so a
    half-typed quick reply survives feed ticks.
  - It is READ-ONLY: it reads `terms.agents()` / `feedFor()`, and the status files
    and the feed stay the truth.
  - Quick reply exists only on Done and failed cards. In a permission or question
    dialog, "text + Enter" would pick the highlighted option.
  - Other workspaces: `main/board.cjs` writes `<dataRoot>/board/<wsId>.json` on
    change (at most one write per 2 s, a 60 s heartbeat, deleted on close).
    Readers hide files older than 2 min.
  - "Focus that workspace" spawns `--workspace=<id>`, which loses the
    single-instance lock. `whenReady` must `return` when `!gotLock`: without that
    guard the duplicate opened a window, spawned ptys and deleted the running
    window's board file (fixed 0.6.19; the launcher's Open button had the same
    bug). `--smoke` skips the lock entirely: it shares the launcher's default
    userData, and a running launcher would otherwise make smoke bail out
    silently.
- **Phone control + away mode** (0.6.21, RESEARCH-REMOTE.md):
  - It is Claude Code's own Remote Control. `terms.js` `claudeCommand()` is the ONE
    builder for a new interactive claude and adds `--remote-control "<ws> · <tab>"`
    unless the workspace opted out.
  - Use the long flag. `--rc` is documented but missing from `claude --help`.
  - Never use server mode (`claude remote-control`): it refuses `--settings`, which
    would drop our hooks.
  - `main/presence.cjs` owns `<dataRoot>/presence/at-pc`, passed to every pty as
    `CLAUDE_CLIENT_PRESENCE_FILE`. File exists = at the PC = phone pushes muted.
  - Presence state is machine-wide in `presence.json`, and every workspace process
    runs the same idempotent ticker.
  - After Win+L the idle time reads only a few seconds. A locked screen must count
    as infinite idle, or the "back at PC" rule flips straight back.
  - The `--remote-control` name is fixed at launch. A tab rename is forwarded as
    a pasted `/rename <ws · name>` (`terms.js` `syncClaudeName`), only when
    status is `done` and no keystroke has arrived since. Mouse and focus reports
    don't count as keystrokes.
  - Verified live 2026-10-01: question → phone push → answered on the phone →
    PC agent continued. Claude ALSO skips the push while that agent's VibeSpace
    window is the active window (xterm focus reports; another VibeSpace window
    counts as away). Presence and focus are checked once, at the moment the
    agent starts waiting. A second push ~30 s after another agent's push was
    dropped (once, not yet reproduced). A test must make the agent ask AFTER you
    leave (a delay), not before.
- **Accounts / multi-subscription** (0.6.29, RESEARCH-MULTISUB.md, `main/accounts.cjs`):
  - Extra Claude accounts are `claude setup-token` tokens handed to claude as
    `CLAUDE_CODE_OAUTH_TOKEN`, ONLY for that call. The pty wrapper reads the
    tab's `$VIBESPACE_ACCOUNT_FILE` and decrypts `<dataRoot>/accounts/<id>.dpapi`
    itself. Everything shares one `~/.claude`, so session tracking is untouched.
    Don't switch to `CLAUDE_CONFIG_DIR` per account: it splits transcripts,
    skills, memory and settings.
  - DPAPI goes through .NET `ProtectedData`, never `ConvertTo-SecureString`. Under
    a PSModulePath inherited from PowerShell 7, Windows PowerShell 5.1 can't
    load that cmdlet's module. The wrapper and smoke run the same
    `accounts.DECRYPT_PS` snippet.
  - Token accounts get no `--remote-control` in either the wrapper or
    `claudeCommand`. Remote Control refuses setup-tokens.
  - Seen live 2026-10-07: a conversation that ran with Remote Control on the
    login account, resumed on a token account WITHOUT `--remote-control`, still
    shows "Remote Control disconnected — Claude.ai login expired — run /login".
    Claude seems to restore the session's RC and fail on the token. The message
    is harmless (the agent works, there's just no phone control) and is not a
    VibeSpace bug: don't chase it. RC and usage always come from the SAME
    credential in one claude process, so phone control lives on whichever
    account is the `/login`. To move phone control to another account, make
    THAT account the `/login` and re-add the other one as a token.
  - **Token accounts also lose the claude.ai connectors** (Google Sheets, Claude
    Docs, Claude in Chrome): a setup-token can only make model requests. Seen
    live 2026-10-07: every agent moved to a token account had them drop
    mid-session. So put the account whose connectors and phone you need on
    `/login`. Claude also hides `CLAUDE_CODE_OAUTH_TOKEN` from its tool shells,
    so an agent asked "which account am I on" reads `~/.claude.json`
    `oauthAccount` and wrongly reports the `/login` email. The truth is the
    tab's `$VIBESPACE_ACCOUNT_FILE`; per-account statusLine limits prove it.
  - Usage-limit evidence: the transcript's last `isApiErrorMessage` line carries
    `error: "rate_limit"`, the "You've hit your weekly limit · resets …" text and
    `quotaLimits { status: "rejected", resetsAt }`. That is the exact reset;
    verified on real transcripts.
  - After a switch both accounts share ONE transcript and one feed state. So
    evidence older than the tab's current account (`accountSince`) is ignored,
    and `clearRateLimits` drops the old windows. Otherwise the old account's
    limit blames the new one (found in review).
  - `setTermAccount` happens only AFTER the old claude exited.
  - The relaunch types into the shell only when `waitClaudeExit` says `prompt`,
    `gone` or `killed`. Custom prompts (oh-my-posh) never match the prompt
    regex, so it also polls the process tree.
  - A bare "Rate limit reached" (short 429) is not a usage limit.
  - Verified live (2026-10-02 to 10-06, 2.1.289): a usage limit DOES fire
    StopFailure. Its body has `error: "rate_limit"` and `last_assistant_message`,
    and no `error_type` / `error_details`; the reset only comes from the
    transcript's `quotaLimits`.
  - **A limit can end before its reset** (the "reset limits" offer on claude.ai,
    2026-10-06). So an exhaustion mark carries `at`, and `clearIfProven` drops it
    when a main-thread turn that STARTED after `at` ends with Stop
    (`noteTurnForAccount`). A turn already streaming when another tab hit the
    limit proves nothing.
  - **"Move all here"** (0.6.47, `accounts.switchAll` + `terms.js` `drainMoves`):
    a machine-wide request `{ to, at }` in its OWN file,
    `<dataRoot>/accounts-switch.json`. A window on older main code rewrites
    accounts.json without keys it doesn't know and would erase it. Each tab has
    `accountAt` (when its account was chosen, saved in state.json); a request
    newer than that moves the tab. It is retired after 12 h, when its account
    runs out, and on a manual reorder.
  - **A tab moves only on evidence seen by this window**: a live `done` event
    AND `tab.draft === false` (nothing typed since the last Enter). Both are
    unknown after a reload, so a re-attached tab waits for its next turn. Do
    not infer "idle" from the feed or from `lastInputAt > doneAt`: a prompt
    drafted WHILE the turn ran is older than `doneAt`, and `/exit` pasted onto
    it gets submitted as "draft/exit".
  - `term.paste` fires `onData`, so our own pastes (`sendToAgent`: /exit,
    /rename, board replies) set the `appWriting` flag and don't count as typing.
  - Before typing `/exit`, `moveOne` asks `pty:claudeRunning`. No claude under
    the shell = the user left it, so the shell may run anything: only the
    account file is written. The bulk path waits with `noKill` and never kills
    a claude that didn't leave; the kill-on-timeout is for the limit switch only.
  - **API endpoint accounts** (0.6.49, z.ai GLM…): kind `endpoint`, stored in
    their OWN `<dataRoot>/accounts-endpoints.json`, blob
    `accounts/<id>.endpoint.dpapi` = the whole env as `KEY=VALUE` lines. Windows
    on older main code then never see them: they rewrite accounts.json turning
    every non-login account into a token, which would have fed the env text in
    as `CLAUDE_CODE_OAUTH_TOKEN`.
  - **Never decrypt or set endpoint env inside the pty wrapper.** Microsoft
    Defender flagged that `-EncodedCommand` as `Exploit:Win32/Tikupom` and
    blocked EVERY terminal from starting (2026-10-07; only the command lines
    were blocked, nothing was quarantined). Instead main decrypts
    (`accounts.endpointEnv`, one PowerShell spawn per account, cached) and
    `accounts:setTerm` writes `<instance>/accounts/<termId>.settings.json` =
    hook settings + `env`. The wrapper only swaps `--settings` for that file
    (string logic). That file holds the key in plain text, like claude's own
    settings.json: it is deleted on account change, `kill()` (capture wsId
    BEFORE `metas` is cleared), pty exit and main start. After any wrapper
    change, check `Get-MpThreatDetection` doesn't grow during smoke.
  - **A conversation never crosses families** (`anthropic` | `endpoint:<host>`).
    `<dataRoot>/session-families.json` keeps each conversation's family; the
    first one wins. A new entry is judged by the transcript's first real
    assistant `model` (`claude…` = anthropic; `<synthetic>` error lines
    skipped) and, only with no replies yet, by the family the tab had when its
    account was SET (`termFamily`, never recomputed: a removed account would
    read as anthropic). Renderer: `tab.family` = the conversation's family.
    Every move/resume compares with it, and restore/unpark with no account of
    that family left opens a plain tab (or keeps it parked), never another
    family. `setTermAccount` throws instead of falling back to login, and then
    nothing is typed.
  - **Verified live 2026-10-07 against z.ai** (claude 2.1.29x, throwaway
    VIBESPACE_HOME, `claude -p … --settings <tab settings file>`): the `env`
    block in a `--settings` file authenticates and routes claude to the
    endpoint. Model `glm-5.3[1m]` answered, the transcript's assistant `model`
    is `glm-5.3[1m]` (so `transcriptModel` sees it), and `--resume` on the same
    endpoint keeps the conversation. `familyForNewSession` matches that model
    against endpoint accounts' models (the `[1m]` suffix is ignored) when the
    tab's family can't tell.
  - **Adding accounts is preset-first** (0.6.50): `accounts.PRESETS` (today:
    `zai`, base URL + timeout + GLM model names + 1M auto-compact window, from
    Valentin's working config) + `addPreset(id, label, key, { models })` share
    the endpoint store path with `addEndpoint`. Users never see env variables
    unless they pick "Other compatible API". When z.ai renames its models,
    update the preset (existing accounts keep theirs; Advanced overrides them).
  - The login counts as available when `.credentials.json` exists (also under
    `CLAUDE_CONFIG_DIR`), or with `ANTHROPIC_API_KEY`, or with an `oauthAccount`
    in `~/.claude.json`. Only with none of them is it skipped (the z.ai-only PC).
  - **The top-bar limit chip is per account** (0.6.52, `limits.js`): it renders
    from `accounts.state()` rows (`limits` + `limitsAt`, refreshed by
    `accounts:changed`), login + token kinds only, plus the live
    `account:limits` push for the login account. One Claude account = the old
    unlabelled chip. The red border means NO Claude account has room left.
  - **Automatic order** (0.6.53, `accounts.rankRows` pure + `ui/automove.js`
    pure): Claude accounts ranked by has-room, then soonest WEEKLY reset
    (a passed reset is projected forward by 7 d and its % reads 0), unknown
    resets after known ones, manual order as tie-break; endpoints keep their
    slot. Room = usable, not exhausted, 5h and 7d < 95 %. The switch is its OWN
    file `<dataRoot>/accounts-auto.json` (default on; older main code would drop
    a key in accounts.json). `state()` returns `auto`, `ranked`, per-row
    `room/weeklyResetAt/blockedBy/roomAt` and `nextChangeAt`; main re-pushes
    `accounts:changed` when a reset passes (no file changes then). An auto move
    = the "Move all" evidence rules PLUS a cold prompt cache (`expiresAt`, or
    1 h after `doneAt` without feed info), then a 30-min hold. While auto is on,
    `switchAll` is refused and `state().switchAll` is null. Log: `account auto:`.
  - **Claude's background agents keep the tab's `$VIBESPACE_TERM_ID`**
    (`claude --bg-pty-host`, owned by claude's daemon, parentless, can run for
    days on the account it started on). They post to the feed as the tab, so
    `claudefeed.fromBackground` drops events whose `session_id` is `kind: "bg"`
    in `~/.claude/sessions/<pid>.json` (looked up only when the id differs from
    the tab's last accepted one). Symptoms before: the tab's session flipping
    between two ids in `tabs:` lines, and a false "out" on the tab's account.
    Claude's daemon (`claude daemon run`) RESTARTS a killed background job
    within minutes: stop one with `claude stop <job id>` (run in its repo),
    never taskkill. A background job is a `--fork-session` copy, so the tab's
    own conversation is the older id; resuming the bg id is refused ("That
    session is running in the background").
  - **`/exit` can take longer than 15 s.** A gentle move waits up to 75 s, and
    `tab.exitSentAt` marks our own `/exit`: an empty shell found later with
    nothing typed since is relaunched (`launchOnAccount`), never treated as
    "the user left claude".
  - Claude repeats its last `rate_limits` reading on every statusLine tick until
    its next API response. Only a reading that just became full marks an account
    (`becameFull`), or an idle tab's stale 100 % re-marks it after a reset.
- **Keyboard selection in claude's prompt** (0.6.39, `renderer/workspace/ui/inputsel.js`,
  RESEARCH-INPUT-SELECTION.md). Claude has no keyboard-started selection, so
  Shift(+Ctrl)+←/→ and Shift+Home/End are turned into: a synthetic two-cell SGR
  mouse drag at the caret, written to the pty in ONE write, trimmed to one cell
  with Shift+←, then Claude's own Shift+←/→ extension, N presses for a word.
  Facts it stands on, all verified live on 2.1.289 and none documented: the
  terminal cursor sits on the caret; the prompt is the rows between two `─`
  border rows with text from col 2; a drag doesn't move the caret; press+release
  on one cell is a click (clears the selection, moves the caret), which is why
  a one-cell selection needs the trim; Esc does NOT clear a selection; Backspace
  and Delete remove it. Typing over a selection sends `\x7f` first, only when
  the selected cells really have a background colour. If selection breaks after
  a Claude update, re-check those facts first. Testing gotchas: xterm's DOM
  renderer only updates on a frame, so in an occluded test window read the DOM
  AFTER a CDP screenshot; and a CDP `char` event has no keydown, so the custom
  key handler never sees it (use `keyDown` with `text`).
- **Background state** (0.6.45): a turn can END while work it started still
  runs. Facts captured from claude 2.1.289:
  - `Stop` (and `SubagentStop`) carry `background_tasks: [{ id, type:
    'subagent' | 'shell', status: 'running', description, agent_type?,
    command? }]`. `SubagentStop`'s list still includes the agent that is
    stopping. `claudefeed` keeps the running ones in `feed.background`.
  - When a background task finishes, claude wakes ITSELF: a `UserPromptSubmit`
    whose prompt starts with `<task-notification>`, then a normal turn and Stop.
  - A subagent's tool events carry `agent_id`; the main thread's don't.
    `status.wordForHook` ignores `PreToolUse` with `agent_id`, or a background
    subagent turns a finished tab amber until the next Stop. After the turn
    ended those events go to `feed.bgNow`, never `nowDoing`. "Turn ended" is the
    `turnOpen` flag, not a timestamp comparison.
  - The state is DERIVED in the renderer: base `done` + `feed.background` non-empty
    (`feedui.bgTasks`) → light class `bg`, strip `st-bg`, board per `columnOf`.
    No new status word, so the status files / toasts / badge rule is untouched.
  - `attention.cjs` hands back the status from BEFORE the ask (`before`), so a
    background subagent's answered permission returns to `done`.
  - Test without spending tokens: capture hook bodies once (replace
    `claudefeed.onHook` through the main inspector), then POST them to the
    running instance's feed port with `x-vs-term: <a live termId>`
    (`scratchpad/replayhttp.mjs`); `reduce` is pure, so a plain node replay works too.
- **Tab auto-name** (0.6.43, `terms.js` `autoName` + `sessions.tabNameFor`):
  a claude tab still matching `/^agent-\d+$/` with `named` unset takes the
  session's name. Claude writes `{"type":"ai-title","aiTitle":…}` to the
  transcript a few lines after the first message (never changed later, and
  re-appended as the file grows) and `{"type":"custom-title"}` on `/rename`;
  ours arrive as `<workspace> · <tab>`. `tabNameFrom` prefers the custom name
  minus that prefix, unless it is itself a default name. Triggers: every
  status change, 4 s after the session id is found, 6 s after a tab opens with
  a session. `named` is saved in state.json and restored by termId
  (`restoredNamed`); a manual rename sets `'user'` and locks the tab. Nothing
  renames while a rename input is open. Testing: a VibeSpace started from
  inside a Claude session inherits `CLAUDE_CODE_CHILD_SESSION`, and claude then
  saves NO transcript ("Transcript saving is off"), so no title ever appears.
  Clear the `CLAUDE*` variables before launching the test instance. The
  throwaway home has `autoResume: false`, which restores agent tabs as plain
  terminals: turn it on to test anything about restored conversations.
- Keys: Ctrl+P file finder · Ctrl+F terminal search (active tab) · Ctrl+Shift+U
  jump-to-attention · Ctrl+Shift+B agent board · Ctrl+Shift+D diagnostics.
- **Git** (0.6.14, sidebar since 0.6.15): `main/githistory.cjs` (log/commit/fileAt/branch,
  read-only) + `renderer/workspace/ui/history.js`. The lists live in the LEFT
  pane (`#side-tabs` Files|Git → `#git-side`); `diff.js` drives both modes and
  owns the one DiffEditor in the preview's pinned Diff tab (`#diff-host`).
  Tree listeners hang on `#tree`, not `#tree-pane` (the pane also holds the Git
  view). Gotchas:
  - Every read-only git spawn needs `GIT_OPTIONAL_LOCKS=0`, or our polling
    makes agents' commits fail on index.lock.
  - `U.jailed(root, p)` is strictly-INSIDE: it rejects `root` itself. An IPC
    that takes the repo root must compare for equality instead. This kept the
    Changes tab dead from 0.6.0 until 0.6.14.
  - Absolute-positioned placeholders must live inside the box they cover
    (`#git-main`). A host-wide overlay silently ate the list's clicks, and
    CDP `el.click()` tests never notice. Verify with real
    `Input.dispatchMouseEvent`.
  - `document.hidden` is true for OCCLUDED windows too, not just minimized
    ones. Pollers that skip when hidden must still run once on start and on
    `visibilitychange`.
- **The file tree rebuilds off-screen** (0.6.44, `tree.js` `buildDom`).
  `addDirNode` is async (one `fsList` per open folder), so "clear `#tree`,
  fill it, restore `scrollTop`" restored the scroll on an EMPTY box and the
  view jumped to the top on every `tree:changed`. Build into a detached
  element, `await` it, then `replaceChildren` and set `scrollTop` (read at the
  swap). One build at a time (`building`); a change or a folder click during
  it sets `stale` and triggers one more. General rule: never restore a scroll
  position before the content that makes it scrollable exists. Rows built
  off-document are invisible to `document.querySelector`, so the git colours
  and the active row are applied after the swap.
- **Terminal widths must match Claude's.** Every xterm loads
  `@xterm/addon-unicode11` and sets `unicode.activeVersion = '11'`. The default
  Unicode 6 table counts emoji as 1 cell; Claude and ConPTY count 2, and the
  mismatch shows up as "mixed-up characters" after any emoji (0.6.34). Test
  emoji output with node, not `Write-Host`: Windows PowerShell 5.1 drops emoji
  from its own output. More suspects (in-box ConPTY strips DEC 2026 sync
  output; `useConptyDll` passes it through) are in RESEARCH-TERMINAL-GARBLE.md.
- **Never `git worktree remove --force` a worktree that has a `node_modules`
  junction** (2026-10-08). Git follows the junction and deletes the MAIN
  repo's `node_modules` file by file until it hits a DLL a running window
  holds (sharp's), then fails with "Invalid argument". Every new VibeSpace
  launch then died with "Could not load the sharp module". Unlink every
  reparse point first (`[IO.Directory]::Delete(path)`, non-recursive),
  then remove the folder. To repair a half-deleted `node_modules` while windows
  run, don't use `npm install`: it tries to replace electron and fails EBUSY.
  Diff `package-lock.json` against the disk, `npm pack` each missing
  name@version and extract it in place (Git Bash `tar` needs `--force-local`
  for `C:` paths).
- **Search tab** (0.6.52, `main/textsearch.cjs` + `ui/search.js`): `git grep`
  in the SENDER window's repo, `GIT_OPTIONAL_LOCKS=0`, `:!.claude/worktrees`,
  results capped and sorted by path (git grep's file order varies).
- **Background fetch** (0.6.52, `main/gitfetch.cjs`): `--no-tags --prune
  --no-write-fetch-head`, no prompts (`GIT_TERMINAL_PROMPT=0`, empty askpass,
  `ssh -o BatchMode=yes` only when the user set no ssh command), skips on
  `index.lock` / merge / rebase. On timeout it kills the whole TREE: killing
  only the `git` wrapper left the real fetch running.
- **Worktree tabs** (0.6.36, `main/worktrees.cjs`): ▾ → New agent in a worktree
  makes `<repo>\.claude\worktrees\<name>` on `vs/<name>` with a plain
  `git worktree add`. **Never use `claude -w`**: it moves the transcript between
  project dirs on `/exit` (a hard kill strands it) and its cleanup half-fails on
  Windows. The base branch is kept in git config `branch.vs/<name>.vibespacebase`
  (deleted with the branch). `.claude/worktrees/` goes into
  `<git-common-dir>/info/exclude`, never `.gitignore`, or the main tree's status
  shows every worktree as untracked. Removal retries because the closed tab's
  shell can still hold the folder for a moment; a half-removed one is pruned and
  its empty folder deleted. `branch -d` judges "merged" against the main tree's
  CURRENT branch, so after our own ahead=0 check we fall back to `-D`. The
  wt:* IPC takes the repo from the sender's window, never from the renderer.
  **The loss check fails CLOSED** (0.6.37): a `git status` or `rev-list` that
  fails, or a base branch that's gone, gives `null`, and `lossText` reports it
  as a loss. So "can't tell" keeps the worktree. Before the fix, a failed count
  read as 0 = "nothing unmerged", and closing the tab would have deleted
  unmerged commits. `.claude/worktrees` is hidden from the tree, Ctrl+P and the
  tree watcher (`U.isAgentWorktrees`); each worktree is a full checkout.
- **Parked agents + the one "+ ▾" menu** (0.6.38, `renderer/workspace/ui/parked.js`):
  - Tab right-click → Park STOPS the agent (pty killed like tab-close) and keeps
    `{ name, cwd, claudeSessionId, worktree, account, parkedAt, lastMessage,
    model }` in state.json `parked`. Disabled until the transcript exists
    (`sessions:check` with the tab's cwd). Confirm only while working/waiting.
  - The entry is persisted FIRST (`persistNow`, awaited), then the pty dies.
    Restore skips any saved tab whose session is also parked, so a crash in
    between can't bring it back twice.
  - Parked entries are NEVER auto-resumed; an all-parked workspace opens with
    no fresh agent-1. Unpark = `createTab({ resumeId })` with the restore's
    dead-session and worktree-gone fallbacks; name clash → `-2`.
  - A parked worktree agent keeps its worktree: no auto-remove on park, and
    `afterWorktreeTabClosed` skips worktrees a parked entry owns. Kept
    worktrees lists it as "🅿 parked as <name>" (click = unpark), not as an
    orphan. Forget (✕, no confirm) drops only the shelf entry.
  - Main keeps `parked` through its merge (`sessions.enrichState`); a snapshot
    without the key keeps the previous list. tablog logs `parked` /
    `unparked` / `forgot` lines and lists parked in the open snapshot.
  - Toolbar: `[+ Claude][▾]` + `▦ Board` only. The caret and right-click on
    + Claude open the same menu. `showMenu` items take `section`, `meta`,
    `card()` (hover card, `common.js showCard`) and `action` (row ✕).
- **Logo picker** (0.6.40, `main/logoscan.cjs` + `renderer/workspace/ui/logopick.js`):
  clicking the top-left logo lists the repo's images, best guess first, with
  Browse… (`dialog:pickLogo`, `defaultPath` = the sender's repo). The scan is
  breadth-first and bounded (depth 7, 4000 folders, 1.5 s, files ≤ 2 MB), so a
  budget that runs out only misses deep folders. It skips `U.IGNORED_NAMES`,
  every dot-folder except `.github`, and agent worktrees. Thumbnails are 96 px
  PNG data URLs made by sharp, 6 at a time (one by one took 3.4 s on
  Recruitica); `.ico` goes through as-is because sharp can't read it. An image
  sharp can't read is dropped: it couldn't become the icon either. To check a
  native file dialog's folder in a test, read the `Address: …` pane of the
  `#32770` child window through UI Automation, then close it with WindowPattern.
- **Never use `window.confirm/alert/prompt` in a workspace window.** On Windows
  Electron the window gets no real focus back after the native box closes.
  Keydown still fires, but keypress/beforeinput don't until the window is
  re-focused, so Space dies in xterm while letters keep working. Use
  `confirmBox()` from `common.js` (found via keydiag, 2026-09-29). The launcher
  imports it from there too (0.6.52), so `common.js` must stay free of
  workspace-only imports. Testing an isolated launcher while the real one runs
  needs `--user-data-dir=<throwaway>`: redirecting `APPDATA` doesn't move
  Electron's userData, and the single-instance lock makes it quit at once.
- **Notification prefs** (0.6.25): `main/notifyprefs.cjs`, machine-wide
  `<dataRoot>/notify.json`, re-read on mtime change because every workspace is
  its own process. `notifyAttention` asks `shouldToast(st)` for the TOAST only.
  The taskbar badge and tab lights never depend on it. A new attention kind
  needs a default there plus a switch row in the prefs modal.
- **Tab/session audit trail:** grep the instance log for `tabs:`. It logs the
  open snapshot, per-change lines and "untracked … would NOT resume" warnings
  (`main/tablog.cjs`, fed from `persistState`). Check it first when a restart
  "lost" a conversation. It is also the REPAIR source. If a state.json is
  damaged and has no `.bak` (all-NUL after the 2026-10-01 reboot: recruitica,
  flexiq, flexfunnels, justlinked), take the last `tabs:` open/+ lines for that
  workspace (read the log with `grep -a`, since the log tail can hold NULs
  too). Then, WHILE ITS WINDOW IS CLOSED (an open window overwrites the file),
  write `{terminals:[{termId,name,cwd,isClaude,claudeSessionId}],autoResume:true}`
  with `U.writeJsonAtomic`, keeping the broken file as `.corrupt-<ts>`. The
  layout isn't logged, so it falls back to the default.
- **`/sync-docs` skill** (`.claude/skills/sync-docs`): the "update all docs" ritual —
  CHANGELOG/DECISIONS/CLAUDE/TODO/README + agent memory, docs only. Copy the skill
  folder into any repo that should join the ritual. (A 📨 broadcast button existed
  briefly in 0.6.0 and was removed in 0.6.6 — Valentin wanted a rule, not a button.)
- **New Claude Code version → the same ↻ Restart** (0.6.32; the separate ⟳
  "Update & Restart All" button, its modal and the `claude update` run were
  removed). Claude auto-updates on disk by itself. When the disk version ≠ the
  window's baseline (`main/index.cjs` claudeBaselines), `updater:state` lights
  ↻ with "Restart · Claude <v>", and the app restart starts every agent on the
  new binary. Restart (both entry points, `restartWorkspace` in app.js) skips
  the confirm when `pty:busy` names nobody.
- **↻ Restart VibeSpace button is conditional too** (0.5.2): main/srcstate.cjs
  fingerprints main/preload/renderer at window OPEN (the code that window runs)
  and re-probes every 30 s; a mismatch shows the button. Baseline must be captured
  at window open — capturing at first interval instead would swallow changes made
  during boot (found the hard way in testing). Dev runs only.
- Packaging (0.5.0): `npm run dist` (NSIS) / `dist:dir` (unpacked). Keep
  `npmRebuild: false` — winpty's gyp fails without a full VS toolchain; the
  installed node-pty prebuilds are copied instead. Always packaged-smoke before
  shipping. Note: packaged reads come from app.asar (fine), but child processes
  need real dirs — use `U.BIN_ROOT`, never `U.ROOT`, as a cwd.
- **JSON files are crash-safe** (0.6.30, `util.cjs` `writeJsonAtomic`/`readJson`):
  fsync the tmp file before the rename, keep the last GOOD copy as `.bak`, and
  restore an unreadable file from it (the damaged one is kept as
  `.corrupt-<ts>`, reported via `U.onCorruptJson` → `json:` log line). Never
  write JSON with plain `writeFileSync`, and never let a parse failure fall
  back to defaults silently. A reboot did exactly that to state.json.
  On Windows `session-end` and on `before-quit`, main saves one last time and
  then sets `stateFrozen`, so pty exits during shutdown can't save as "tabs
  closed". Test it via the main inspector (`--inspect=9230`,
  `app.emit('session-end')`).
- State: `~/.vibespace/instances/<id>/state.json` — renderer pushes debounced snapshots;
  main enriches terminal entries with tracked session ids every flush and on close.
  Renderer state and main-side enrichment are deliberately merged main-side — keep that.

## Conventions

- Main/preload: CommonJS (`.cjs`). Renderer: dependency-free ES modules, no bundler,
  served via `app://local/…` (`vendor/` maps to `node_modules/`, `icons/` to
  `~/.vibespace/icons/`). Monaco loads through its AMD loader; TS/JSON validation is
  disabled so it needs no workers.
- UI text and comments in English; UI is dark-theme by default (`style.css` vars).
- Update CHANGELOG.md (new version section) and TODO.md for anything user-visible.
- Keep the launcher renderer dumb — workspace-window features belong in
  `renderer/workspace/`.
- Windows-only by design (ConPTY, AUMID, registry). Don't add cross-platform shims
  without asking.
