# Changelog

Format: Keep a Changelog-ish. Dates are local (2026-09-26 = initial build day).

## [0.5.5] — 2026-09-27 (afternoon, part 2)

### Added
- **Drag & drop into the tree**: drop files from Explorer onto any folder row
  (green highlight) or the tree background (repo root) — files are COPIED in,
  never overwriting (`name (2).ext` collision rename). The live tree watcher
  picks them up immediately.
- **Drop an image on the workspace logo** (top-left) to set it as the workspace
  logo — same flow as the 🏷 button / clicking the logo.

## [0.5.4] — 2026-09-27 (afternoon)

### Added
- **Live file tree**: a recursive repo watcher (main/treewatch.cjs, ignores
  node_modules et al., 700 ms debounce) pushes `tree:changed` → the tree rebuilds
  from disk, preserving expanded folders, the selected file, and scroll position.
  The window also rebuilds on focus. Files created by agents or external tools now
  appear immediately. Ignore rules unified in util (`IGNORED_NAMES/SUFFIXES`,
  `isIgnoredPath`) and shared by tree, Ctrl+P index, and watcher. Smoke: 22.

## [0.5.3] — 2026-09-27 (midday)

### Added
- **`--screenshot=<path>` docs mode**: opens a workspace, stages demo terminal
  content + status lights, captures the window to PNG, exits. Produced
  assets/screenshot.png for the README. (capturePage needs a VISIBLE painted
  window — hidden windows fail with UnknownVizError; the mode shows the window.)
- Terminal restore keeps saved termIds (stable pty/session ids across restarts).

### Fixed
- **Agent tab rename was a lottery while agents ran**: the tab bar redrew on every
  status change / session capture, destroying the rename input mid-typing. The bar
  now skips redraws while a rename is live; tabs rename on **right-click** as well
  as double-click (tooltip says so).
- **"Electron" name/icon hijacking a workspace's taskbar identity**: pinning a
  *running* window in dev mode makes Windows drop a junk `Electron.lnk` (bare
  electron.exe target, no icon) into the Start Menu root, which shadows the
  workspace's real AUMID registration. Diagnosis + removal documented in WORKLOG.
  shortcuts.cjs now spawns Windows PowerShell by absolute path (bare
  `powershell.exe` fails in stripped-PATH chains, which would silently break
  shortcut creation/refresh).

### Added
- **🏷 Logo… button in the workspace window's top bar** — swap the workspace logo
  from inside the window (was launcher-only, which nobody found). The window
  reloads onto the new icon; agents survive and re-attach (0.4.0 attach), and the
  taskbar pin refreshes on the next re-pin. The topbar **logo image itself is
  clickable** for the same action (hover outline marks it). Logo swaps also re-write
  existing .lnk files and nudge the Windows icon cache (`ie4uinit -show`), so pinned
  taskbar icons refresh without a manual re-pin.

## [0.5.2] — 2026-09-27 (morning, part 2)

### Added
- **↻ Restart VibeSpace button** — appears automatically when the source tree
  changes under a running window (fingerprint of main/preload/renderer: file
  count + size + newest mtime, probed at window open and every 30 s; dev runs
  only). Click → busy-aware confirm → the app relaunches itself onto the new code
  and every agent conversation auto-resumes. This replaces default-on hot reload
  with "automatic detection, manual restart". Verified live: a touched renderer
  file triggered detection and the notification within one probe cycle.

## [0.5.1] — 2026-09-27 (morning)

### Changed
- **⟳ Update & Restart All only appears when there's something to restart onto.**
  Claude Code auto-updates itself in the background, so the button's job is the clean
  restart of all agents onto the new version — it is hidden by default and shows
  only when the on-disk version no longer matches what this window's agents were
  started on (baseline at window open; disk re-probed every 5 min; re-baselined
  after a restart-all). Smoke: 18 self-tests (version parse/compare added).

## [0.5.0] — 2026-09-27 (overnight session, part 2)

### Added — agent supervision (RESEARCH-USER-PAIN.md shortlist)
- **Per-tab agent status lights** — claude tabs are launched with injected hooks
  (`claude --settings <per-instance file>`, merged with the user's own settings)
  that append working/waiting/done to a per-terminal status file. Live dot on the
  tab: amber pulse = working, red pulse = waiting for you, green = finished.
- **Attention toasts + taskbar badge** — when the workspace window is unfocused,
  waiting/done raises a Windows notification; clicking it focuses the window AND
  the exact tab. Taskbar overlay dot clears when the window is focused.
- **Ctrl+Shift+U** — jump to the next tab that needs you (waiting first, then done).
- Unread tabs render bold until visited.

### Added — daily-driver QoL
- **Ctrl+P fuzzy file finder** — palette over the whole repo (same ignore rules as
  the tree, index cached 5 s); Enter opens in the preview. Works even while a
  terminal has focus.
- **Ctrl+F terminal search** — find bar for the active terminal
  (@xterm/addon-search; Enter/Shift+Enter cycle, Esc closes; Monaco keeps its own).
- **Session picker on dead resume** — a saved session whose .jsonl is gone opens
  claude's interactive `--resume` picker instead of silently erroring.
- **Tree git colors** — `git status --porcelain` (3 s cache main-side) colors
  modified/added/untracked/deleted files and their parent folders; refreshed every
  30 s while the window is focused. Graceful: no git / not a repo → no colors.
- **Expanded folders remembered** per workspace; ignore list extended
  (playwright-report, test-results, .tsbuildinfo, .eslintcache, …).

### Packaging
- **electron-builder**: `npm run dist` (NSIS installer) / `npm run dist:dir`
  (unpacked). Installer built and validated: **16/16 smoke from the packaged
  binary** plus a clean packaged workspace boot. `npmRebuild: false` — node-pty's
  installed prebuilds are copied (source rebuild fails in winpty's gyp without a
  full VS toolchain). Not installed anywhere; shortcut migration remains manual.

### Fixed
- Packaged builds: ptys cannot spawn with an asar cwd (error 267) — `U.BIN_ROOT`
  is a real directory next to the exe when packaged; smoke uses it for pty cwds.

Smoke: 16 self-tests.

## [0.4.0] — 2026-09-26/27 (overnight session)

### Added — agent survival layer (RESEARCH-HOTRELOAD.md Layers 2+3)
- **Ptys survive renderer reloads** — the flagship fix. Live ptys (and the claude
  processes inside them) are no longer killed when a window reloads: ptyhost keeps a
  256 KB output ring per terminal, and the reloaded renderer re-attaches via the new
  `pty:list` IPC — same termIds, scrollback restored from the buffer, no respawn, no
  `claude --resume` round-trip. Applies to dev hot reload, logo swaps, and
  renderer-crash recovery (`render-process-gone` no longer kills anything).
  Verified E2E: the claude.exe PID was identical across a real `--watch` reload.
- **Busy-guard** (`devwatch` + `ptyhost.busyNow`): the opt-in watcher defers its
  reload/relaunch while any terminal had output or input in the last 5 s — a `main/`
  save waits for agents to go idle instead of interrupting mid-run.
- Smoke: 13 self-tests (ring buffer lifecycle + busyNow signal).

### Fixed
- ptyhost: `write()` now records activity (the reload guard needs input too);
  removed a stray `\+` PATH-entry strip from repairPath.

## [0.3.0] — 2026-09-26 (late)

### Changed
- **Dev hot reload is now opt-in** (`--watch` CLI flag or `VIBESPACE_WATCH=1` env;
  `npm run dev`). Previously every unpackaged process — launcher and all workspace
  windows — watched the source tree, so one save reloaded/relaunched *every* open
  instance and interrupted every agent running inside VibeSpace. Normal windows now
  never watch; `VIBESPACE_NO_WATCH=1` still force-disables. A watched launcher
  propagates the flag to workspaces it spawns. Full analysis + follow-up fix layers
  (ptys surviving reloads) in RESEARCH-HOTRELOAD.md.

### Added
- Smoke tests for the devwatch gate (10 self-tests now). Note: the pty echo test must
  run from a normal shell — inside a Claude pty, stripped PATH + nested ConPTY break it
  (see CLAUDE.md).

## [0.3.2] — 2026-09-26 (late night, hook-error investigation)

### Changed
- **Terminal PATH repair**: every pty now guarantees System32 / WindowsPowerShell /
  Windows on its PATH even when the window was spawned from an environment with a
  stripped PATH (e.g. an agent shell). Root cause of "hook errors only in VibeSpace"
  reports: Claude Code runs hooks via Git Bash, and a bare `node`/`powershell` only
  resolves if the inherited PATH is complete. Plugin/hook commands were also switched
  to absolute paths earlier (vercel plugin hooks, notify.ps1 hooks) — after both fixes
  the errors did not recur.

## [0.3.1] — 2026-09-26 (late night, review pass)

### Fixed
- **Session tracking was dead for fresh repos**: the tracker resolved the Claude projects
  dir once at window open and bailed (without even its poll timer) when it didn't exist —
  but Claude Code only creates that dir on the conversation's first message. Brand-new
  repos (e.g. right-clicked into existence) never got session capture until the window
  was reopened. The dir is now re-resolved on every scan until it appears.
- **Logo swap orphaned every running agent**: `ws:updateLogo` reloaded the window without
  killing its ptys. Mitigated by kill-before-reload (tabs auto-resume); the full no-kill
  fix remains Layer 2 in RESEARCH-HOTRELOAD.md.
- Smoke suite: 11 self-tests now (fresh-repo capture included). Note for agents writing
  tests: build Windows paths with `String.fromCharCode(92)` in generated code —
  heredoc/escape chains silently turn `` into a vertical tab and make paths
  drive-relative, which `path.resolve()` then mutates asymmetrically.

## [0.2.1] — 2026-09-26 (night)

### Added
- **Terminal copy/paste** (Windows-Terminal-style): Ctrl+C copies when text is selected
  and interrupts when it isn't; Ctrl+V / Ctrl+Shift+V paste; right-click copies the
  selection or pastes; Ctrl+Insert / Shift+Insert supported. Clipboard goes through
  main-process IPC (Electron `clipboard`) — no web permission prompts.

## [0.2.0] — 2026-09-26 (evening)

### Added
- **Explorer right-click → "Open with VibeSpace"** on folders and folder backgrounds
  (HKCU registry, per-user). `--open-repo=<path>` CLI mode auto-creates the workspace and
  opens it. Managed from the launcher (🧩 Right-click menu button).
- **"VibeSpace Launcher" shortcut** (Desktop + Start Menu) as the always-available entry point.
- **⇄ Layout toggle** — terminal dock bottom ↔ right (three vertical panes:
  tree | preview | agent conversation). Position and pane sizes persisted per workspace.
- **Logging & diagnostics**: per-instance log files in `~/.vibespace/logs/` (rotated at
  1 MB) capturing boot, pty spawn/exit, session capture, `claude update` output, renderer
  warnings/errors, crashes; console tee; 🐞 Logs button; **Ctrl+Shift+D** copies a full
  diagnostics bundle (versions + state + log tails) to the clipboard.
- **Dev hot reload**: saving `renderer/`/`preload/` reloads open windows (agent terminals
  killed + auto-resumed from state); saving `main/` relaunches the app with the same args.
  Dev-only, `VIBESPACE_NO_WATCH=1` to disable.
- **Logo… button** on launcher cards — swap a workspace's logo anytime
  (window icon updates live; re-pin the shortcut to refresh its icon).

### Fixed
- **Stale-code bug (the "cannot resize at all" report):** the `app://` protocol used
  `net.fetch(file://…)`, which serves cached responses — hot reloads shipped mixed
  old/new bundles and the drag handler died on a missing function. The protocol now reads
  from disk and serves with `Cache-Control: no-store`.
- **Splitter resize**: original version derived each drag step from the pane's *rendered*
  size, which flexbox shrink fed back into itself (spiraling sizes = the "glitchy" feel).
  Now: size captured once at drag start + cumulative `clientX/clientY` deltas applied to
  the frozen value; drag listeners on the window (no `setPointerCapture` — misbehaves with
  remote-control injected input); terminal pane owns its size (`flex: 0 1 auto`) so the
  divider tracks the pointer 1:1; xterm refit throttled to 120 ms during drags.
- **File tree collapse**: `.hidden` class had no CSS rule in the workspace stylesheet —
  folders could be expanded but never collapsed.
- **Monaco icon font** blocked by CSP (`font-src` now allows `data:`).
- `claude` spawn deprecation noise: updater now spawns `claude.exe` directly.
- GPU/renderer hardening: hardware acceleration disabled (blank-window instability on
  remote-display setups), renderer auto-restart on `render-process-gone`.

## [0.1.0] — 2026-09-26 (initial build)

### Added
- Per-repo **workspace windows**, each its own process with a unique
  **AppUserModelID** (`vibespace.workspace.<id>`) — the Chrome-profile mechanism —
  so every repo pins to the taskbar as its own app.
- **Launcher** — create workspaces (name / repo folder / logo png/ico/svg/jpg/webp),
  open, pin, remove. Logos become multi-size Windows `.ico` (16/32/48 BMP + 256 PNG).
- **.lnk generator** (`assets/ps/set-shortcut.ps1`) — shortcut + AUMID written via
  shell property store (`IPropertyStore`, `PKEY_AppUserModel_ID`); verified with
  `Get-StartApps`.
- **Workspace window**: file tree (lazy, ignore-list), Monaco preview with
  read-only-by-default + Edit/Ctrl+S light editing, resizable panes.
- **Agent terminals**: xterm.js over node-pty (PowerShell, ConPTY), named tabs,
  `+ Claude` / `+ Terminal`, per-tab session capture.
- **Session tracking**: watches `~/.claude/projects/<munged-path>/` for the `.jsonl`
  created on a conversation's first message; terminal→session association bounded by
  neighbouring claude launches; survives restarts.
- **⟳ Update & Restart All**: one `claude update`, then every terminal relaunched with
  `claude --resume <session-id>`.
- **State persistence**: tabs (name/cwd/session id), layout sizes, auto-resume flag —
  per workspace, enriched main-side with discovered session ids.
- **Smoke tests** (`npm run smoke`): munge, live session discovery, ico build, registry
  CRUD, pty echo — 8/8.
