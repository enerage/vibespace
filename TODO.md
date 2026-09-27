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
- [ ] Per-agent git diff review in the preview pane (Monaco DiffEditor) —
      RESEARCH-USER-PAIN.md shortlist #4.
- [x] **Session picker on restore** (done 0.5.0) — dead saved session → claude's
      interactive `--resume` picker opens in the tab.
- [x] **Tree polish** (done 0.5.0) — expanded folders remembered; git status colors
      (porcelain, cached main-side); ignore list extended.
- [x] **File finder Ctrl+P** (done 0.5.0) — fuzzy palette over the repo index.
- [ ] **Editor tabs** (M) — multiple open files with tabs instead of one preview at a time.
- [ ] Full-text grep panel (S/M).

## Session tracking robustness
- [ ] Detect `/resume` switches inside a running tab (known limitation: tab keeps its
      original session id). Options: parse OSC title, watch newest jsonl mtime per tab,
      or ask the user to start a fresh `+ Claude` tab.
- [ ] Disambiguate two claude launches within ~2 s of each other (window heuristic
      currently loses the earlier tab).
- [ ] Track claude started *manually* inside a plain `+ Terminal` tab.

## Multi-agent / multi-repo
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
- [ ] Link handler: open `D:\file.cs:123` from claude output in the preview pane.

## Windows integration
- [ ] Investigate Windows 11 **modern** context menu entry (IExplorerCommand/
      sparse package) so "Open with VibeSpace" isn't behind "Show more options".
- [ ] Jump list on pinned taskbar icons: recent workspaces, "new agent in…".
- [ ] Per-workspace notification badge when an agent finishes (taskbar overlay icon).

## Internal
- [ ] Unit tests for sessions.cjs assignment heuristic (pure logic, easy to test).
- [ ] Rate-limit `fs.watch` + polling in sessions.cjs (currently 4 s poll per workspace).
- [ ] i18n pass if anyone else ever uses this. 😄
