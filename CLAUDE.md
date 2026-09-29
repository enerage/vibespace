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
- GPU acceleration is deliberately off (`app.disableHardwareAcceleration()`) — windows
  went blank over remote-display software. Renderers self-heal via
  `render-process-gone` → reload WITHOUT killing ptys — the renderer re-attaches.

## Session tracking (the resume magic)

Claude Code stores conversations in
`~/.claude/projects/<munged-repo>/<uuid>.jsonl` where munging replaces every
non-alphanumeric char with `-` (`D:\Repositories\Foo` → `D--Repositories-Foo`).
Key facts encoded in `main/sessions.cjs`:

- The `.jsonl` is created **when the first message is sent**, not at `claude` launch —
  discovery windows must not have short upper bounds.
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
  The ↺ Resume button (0.6.20) = right-click + Claude = `pickSession`.
- The heuristic above is now only the fallback for agents without a feed
  (started before 0.6.16). Its known holes (manual `/resume`, near-simultaneous
  launches) remain for those only; see TODO.md.

## Developing VibeSpace

- `npm run smoke` — 70 self-tests (as of 0.6.21) incl. pty echo and live session discovery. Run it after
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
  (`renderer/workspace/ui/feedui.js`). A tab with no feed must look exactly as it
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
- **Never use `window.confirm/alert/prompt` in a workspace window.** On Windows
  Electron the window gets no real focus back after the native box closes.
  Keydown still fires, but keypress/beforeinput don't until the window is
  re-focused, so Space dies in xterm while letters keep working. Use
  `confirmBox()` from `common.js` (found via keydiag, 2026-09-29).
- **Tab/session audit trail:** grep the instance log for `tabs:`. It logs the
  open snapshot, per-change lines and "untracked … would NOT resume" warnings
  (`main/tablog.cjs`, fed from `persistState`). Check it first when a restart
  "lost" a conversation.
- **`/sync-docs` skill** (`.claude/skills/sync-docs`): the "update all docs" ritual —
  CHANGELOG/DECISIONS/CLAUDE/TODO/README + agent memory, docs only. Copy the skill
  folder into any repo that should join the ritual. (A 📨 broadcast button existed
  briefly in 0.6.0 and was removed in 0.6.6 — Valentin wanted a rule, not a button.)
- **⟳ update button is conditional** (0.5.1): claude auto-updates in the background;
  the button restarts agents onto the new version and only renders when
  disk version ≠ the window's baseline (`main/index.cjs` claudeBaselines).
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
