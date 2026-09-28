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
  The 📨 Sync Docs button merely broadcasts that command to every workspace —
  optional sugar, the rule is the point.
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
- **Per-workspace identity is load-bearing**: each workspace process sets its own
  `userData` dir AND `app.setAppUserModelId('vibespace.workspace.<id>')` *before* app
  ready; shortcuts carry the same AUMID (`assets/ps/set-shortcut.ps1` writes it through
  the shell property store — `Get-StartApps` verifies). Change the scheme and every
  existing pin breaks.
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
- Known holes (see TODO.md): manual `/resume` switches inside a tab, near-simultaneous
  launches.

## Developing VibeSpace

- `npm run smoke` — 23 self-tests incl. pty echo and live session discovery. Run it after
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
  captures, renderer errors, term-status transitions). `VIBESPACE_DEBUG=1` for
  session-scan traces. Ctrl+Shift+D in a window copies a diagnostics bundle.
- **Agent status hooks** (0.5.0): claude tabs launch with
  `--settings <instance>/claude-hook-settings.json` injecting
  Notification/Stop/UserPromptSubmit/PreToolUse hooks that append
  working/waiting/done to `$VIBESPACE_TERM_STATUS` (set per pty by ptyhost).
  `main/status.cjs` watches and pushes `term:status` → tab lights, toasts, taskbar
  badge. Change the word set and all three of those together.
- Keys: Ctrl+P file finder · Ctrl+F terminal search (active tab) · Ctrl+Shift+U
  jump-to-attention · Ctrl+Shift+D diagnostics.
- **📨 Sync Docs** (0.6.0): topbar button broadcasts `/sync-docs` to every claude
  tab in EVERY open workspace (transport: `main/broadcast.cjs` watches
  `<dataRoot>/broadcast/cmd.txt`; each workspace process types the command into
  its own claude tabs). The `.claude/skills/sync-docs` skill (this repo) is the
  ritual: CHANGELOG/DECISIONS/CLAUDE/TODO/README + agent memory, docs only.
  Copy the skill folder into any repo that should join the ritual.
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
