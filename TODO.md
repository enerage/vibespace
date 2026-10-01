# TODO / Backlog

Roughly priority-ordered. Effort guesses: S (<1h), M (an evening), L (a few sessions).
Everything here is fair game for an agent working from inside a VibeSpace workspace —
read CLAUDE.md first, and set `VIBESPACE_NO_WATCH=1` if you'll be editing VibeSpace
itself while an agent runs in the same window.

## Packaging & distribution
- [x] **electron-builder packaging** (0.5.0) — NSIS installer + unpacked build
      validated end-to-end (16/16 packaged smoke, clean workspace boot). npmRebuild
      stays false (winpty gyp breaks; installed prebuilds are copied).
- [ ] **Install + migrate** — install `dist\VibeSpace Setup 0.5.0.exe`, re-point
      shortcuts + context menu at the installed binary, migrate existing workspace
      shortcuts. Deliberately left for Valentin (touches his real machine state).

## Bugs
- [ ] **Space stops typing in every agent tab** (2026-09-29) — cause found with
      keydiag: after a native `confirm()` the window never gets a real focus back,
      so keypress stops firing and xterm's Space (keypress-only) dies while letters
      (keydown) work. Fixed in 669b11a (in-page `confirmBox()`). Proof so far is 2
      logged episodes. **Keep** `renderer/workspace/ui/keydiag.js` + its 2 hooks
      (app.js, terms.js; uncommitted) until one full day on the fixed build with no
      Space loss. Then delete them and tick this. If it recurs, grep the instance log
      for `[keydiag]` around the last `window blur`.
- [ ] **Orphaned MCP servers pile up** (2026-09-29) — found 124 `mcp-postgres`
      node processes (~6.4 GB) whose claude + cmd.exe parents were gone; the PC
      was barely usable. Not yet proven that VibeSpace is the cause: check whether
      closing a tab / restarting a window / killing a pty leaves claude's MCP
      children alive, and if so kill the whole tree (`taskkill /T /F`) on pty exit.
- [x] **Drop a file/photo onto a terminal did nothing** (0.6.13) — now pastes the
      quoted path(s) like Windows Terminal; Claude attaches dropped images.
      Needs Valentin's manual check (a real Explorer drag can't be scripted).

## Claude-data UI (RESEARCH-CLAUDE-DATA.md; decided 2026-09-29)
Build in this order. Verify the statusLine and HTTP hooks live in a pty before relying on them.
- [x] **Data feed:** statusLine and HTTP hooks in claude-hook-settings.json, a local
      server in main, and events pushed to the renderer per term. Hand off to the
      user's own statusLine. M (0.6.16, `main/claudefeed.cjs`)
- [x] **Context meter per tab + plan-limit bar** (5h/7d %, reset countdown). M (0.6.16)
- [x] **Richer tab status:** a "now doing" line; permission / question / done / failed
      states (lights, toasts and badge change together); last-reply peek on hover. M
      (0.6.17: activity strip + peek card + lock/?/✕ lights)
- [x] **Task checklist per agent** ("3/7" on the tab). M (0.6.17). Built from the
      feed's TaskCreate/TaskUpdate/TodoWrite events, not from `~/.claude/tasks/`.
      Task tools are off by default in claude 2.1.284, so most agents only show
      TodoWrite todos.
- [x] Instant red light on PermissionRequest (0.6.20). Main flips the base state
      to waiting through an in-memory override (`main/attention.cjs`), so the
      light, toast and badge move together. The late Notification doesn't toast
      again.
- [x] **Agent board:** cards grouped as needs you / working / review / done. M-L
      (0.6.19: ▦ / Ctrl+Shift+B; Needs you · Working · Done · Other, quick reply,
      other workspaces via `<dataRoot>/board/*.json`)
- [x] Compaction and prompt-cache-cold warnings. S (0.6.20: `cache warm · m:ss` /
      `cache cold` chip, "compacting context…", "auto-compact soon" at 85 %+)
- [ ] Per-turn diff with review comments typed back to the agent. M
- [x] Exact session matching (0.6.20). The feed's `session_id` gives the exact
      termId → session mapping, so the undocumented `~/.claude/sessions/<pid>.json`
      registry wasn't needed. The timing heuristic is only the fallback for
      pre-feed agents.
- [x] Background agents (`claude agents --json`, `claude attach`). S-M (0.6.20: a
      board section for this repo, polled every 15 s while the board is open, and
      Attach opens a plain tab, because attach ignores `--settings`)
- [ ] VibeSpace as Claude's IDE (`~/.claude/ide/` lock + WebSocket). Undocumented,
      so behind a setting. L

## Quality of life
- [x] **Ptys survive renderer reload** (done 0.4.0; Layer 2 in RESEARCH-HOTRELOAD.md) —
      ring buffer + `pty:list` attach; logo swap and `render-process-gone` fixed with it.
- [x] **Hot-reload guard** (done 0.4.0; Layer 3) — `busyNow()` (output + input) defers
      the opt-in reload/relaunch while agents are busy. Keystrokes-during-rebuild is
      still open below.
- [x] Session-status supervision (done 0.5.0; RESEARCH-USER-PAIN.md shortlist) —
      status lights via injected claude hooks, toasts + click-to-focus,
      Ctrl+Shift+U jump, unread markers, taskbar overlay badge.
- [ ] Last-message preview per session (tooltip from the tracked .jsonl) —
      RESEARCH-USER-PAIN.md shortlist #5.
- [x] Per-agent git diff review in the preview pane (done 0.6.0) — pinned ⟳
      Changes tab, Monaco DiffEditor, HEAD-vs-worktree incl. untracked.
- [x] **Git history** (done 0.6.14): History mode, branch chip, file history.
- [ ] Git: **compare range** ("everything since commit X" as one diff) (S/M).
- [ ] Git: flag commits that swept in another agent's half-done files (`git add -A`
      by a second agent in the same working copy) (M, needs a heuristic).
- [ ] Git: commit graph lanes (port VS Code SCM graph, see DECISIONS) (M).
- [ ] Git: background `fetch` so ↓behind is fresh (needs `GIT_TERMINAL_PROMPT=0`) (S).
- [x] Tree file operations (done 0.6.0) — context menu: new file/folder,
      rename (F2), delete to Recycle Bin; fs IPC jailed to the workspace.
- [x] **Session picker on restore** (done 0.5.0) — dead saved session → claude's
      interactive `--resume` picker opens in the tab.
- [x] **Tree polish** (done 0.5.0) — expanded folders remembered; git status colors
      (porcelain, cached main-side); ignore list extended.
- [x] **File finder Ctrl+P** (done 0.5.0) — fuzzy palette over the repo index.
- [x] **Editor tabs** (done 0.6.0) — dirty dots, per-tab edit state, persisted
      across reloads, agent-edited files refresh in place.
- [ ] Full-text grep panel (S/M).

## Session tracking robustness
- [x] Resume-an-existing-conversation flow (0.6.2): right-click `+ Claude` opens
      claude's picker; the picked old conversation is auto-pinned by mtime revival.
      0.6.20: a visible ↺ Resume button does the same, and feed agents get the
      pick pinned about 1 s after picking, before any message (verified live), so
      "pick, then restart before typing" no longer loses it.
- [x] Detect `/resume` (and `/clear`) typed mid-session inside a running tab —
      solved for feed agents (0.6.20): every feed payload carries `session_id`,
      tagged with the tab, and main re-pins it (`sessions.pinFromFeed`). Verified
      live: `/clear` re-pinned in ~1.7 s, `/resume <id>` in ~1.4 s, both with no
      message sent.
- [ ] Same for pre-feed agents (started before 0.6.16): still heuristic only.
- [x] Disambiguate two claude launches within ~2 s of each other — solved for
      feed agents (the id arrives tagged with the tab, no timing involved).
- [x] Track claude started *manually* inside any tab (0.6.23): the shell's
      `claude` wrapper (ptyhost `CLAUDE_WRAPPER`) adds `--settings` + `--remote-control`,
      so the feed tracks it. Verified live with a hand-typed `claude --resume <id>`.
- [ ] Optional: our own ↺ Resume picker (lists this repo's transcripts whatever
      the drive-letter case, resumes by id). Claude's picker hides lowercase-`d:\`
      conversations (anthropics/claude-code#90588); drop this if they fix it.
      2026-10-01: the existing 41 were repaired (CLAUDE.md, picker bullet). Only
      build this if new VS Code-started sessions keep hitting it.

## Multi-agent / multi-repo
- [x] **Phone / away mode via Remote Control** (0.6.21, RESEARCH-REMOTE.md) —
      per-tab `--remote-control` names, presence marker + 📱 toggle + lock/idle auto-away.
- [ ] **Live-verify phone control** (S) — after a workspace restart, check that
      `--remote-control` + `--settings` launches cleanly, that ~20 sessions all
      register, that phone answers unblock the PC (known issues #52084/#59855/#64797),
      that our lights/feed stay right when answered from the phone, and that lock →
      a push arrives. If it fails badly: DIY Telegram hub (RESEARCH-REMOTE.md plan step 3).
- [ ] **Worktree tabs** (L) — spawn an agent into `repo/.claude/worktrees/<name>`
      (Claude Desktop-style isolation) with a branch picker.
- [ ] **Cross-workspace overview** (M) — small always-on-top window or launcher view:
      all agents across all repos, live status (idle/thinking/waiting-on-permission),
      click to focus. Needs a status signal from claude (OSC title or output heuristics).
- [ ] **New agent presets** (S) — per-workspace prompt templates (e.g. "backend",
      "frontend") applied to `+ Claude` with a name + optional first message.
- [ ] Model picker per tab (opus/sonnet/haiku) like Claude Layout Session does.

## Terminal
- [x] Search inside terminal (done 0.5.0, @xterm/addon-search + Ctrl+F bar).
- [ ] Split panes inside a tab.
- [x] Link handler: open `D:\file.cs:123` from claude output in the preview
      pane (done 0.6.0 — xterm link provider; relative paths resolve against
      the terminal cwd).

## Windows integration
- [ ] Investigate Windows 11 **modern** context menu entry (IExplorerCommand/
      sparse package) so "Open with VibeSpace" isn't behind "Show more options".
- [ ] Jump list on pinned taskbar icons: recent workspaces, "new agent in…".
- [ ] Per-workspace notification badge when an agent finishes (taskbar overlay icon).

## Internal
- [ ] Unit tests for sessions.cjs assignment heuristic (pure logic, easy to test).
- [ ] Rate-limit `fs.watch` + polling in sessions.cjs (currently 4 s poll per workspace).
- [ ] i18n pass if anyone else ever uses this. 😄
