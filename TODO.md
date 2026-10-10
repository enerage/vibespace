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
- [x] **Space stops typing in every agent tab** (2026-09-29, closed 2026-10-02):
      after a native `confirm()` the window never got real focus back, so keypress
      stopped firing and xterm's Space (keypress-only) died while letters (keydown)
      worked. Found with temporary keydiag logging, fixed in 669b11a (in-page
      `confirmBox()`). No episode in any log from the fix until 2026-10-02, so the
      logging was removed. If it ever recurs: look for another native dialog first.
- [x] **Orphaned MCP servers pile up** (2026-09-29, fixed 0.6.52) — proven: a
      pty close leaves claude's hidden `cmd /c` MCP children alive. `kill()` now
      runs `taskkill /T /F` on the shell tree BEFORE closing the pty; `killAll()`
      does one synchronous taskkill. Still open: orphans left when the shell or
      claude exits by itself (parents already dead, no safe way to trace them).
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
- [x] Git: background `fetch` so ↓behind is fresh (0.6.52, `main/gitfetch.cjs`).
- [x] Tree file operations (done 0.6.0) — context menu: new file/folder,
      rename (F2), delete to Recycle Bin; fs IPC jailed to the workspace.
- [x] **Session picker on restore** (done 0.5.0) — dead saved session → claude's
      interactive `--resume` picker opens in the tab.
- [x] **Tree polish** (done 0.5.0) — expanded folders remembered; git status colors
      (porcelain, cached main-side); ignore list extended.
- [x] **File finder Ctrl+P** (done 0.5.0) — fuzzy palette over the repo index.
- [x] **Editor tabs** (done 0.6.0) — dirty dots, per-tab edit state, persisted
      across reloads, agent-edited files refresh in place.
- [x] Full-text grep panel (0.6.52: Search tab, `git grep`, Ctrl+Shift+F).
- [ ] Prompt keyboard selection (inputsel.js): cross wrapped/multi-line prompts
      (Shift+↑/↓, Left past the line start), and handle lines with emoji / wide
      characters (S/M). Drop the whole module once anthropics/claude-code#80734
      ships natively.
- [ ] tablog: include the layout (`termPosition`, sizes) in the `open:` line, so a
      state rebuilt from the log keeps the terminal on the right (S). The
      2026-10-01 reboot rebuilds lost it.
- [x] (0.6.52) Launcher still uses 2 native `confirm()` boxes (remove workspace, remove
      Explorer menu). Port them to an in-page confirm like `confirmBox` (S).
- [ ] Logo change on a PINNED workspace: the new icon path + taskbar-button
      rebuild (0.6.41) is verified only for running, unpinned windows. Check a
      pinned one; pinning can't be scripted on Windows 11 (S).
- [ ] Typing lag: if `lag:` lines keep showing high `cpu`, add the "priority
      guard" (lower the priority of agents' vitest/tsc/build processes, keep
      claude + UI normal). Valentin chose "measure first" on 2026-10-02 (M).
- [ ] Garbled terminal characters after the Unicode 11 fix (0.6.34): next A/B is
      `useConptyDll: true` + `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1`
      (RESEARCH-TERMINAL-GARBLE.md). Only if it still happens; ask for a screenshot (M).
- [ ] Background state: tell a finished background shell (test run) from a
      long-lived one (dev server) so shell-only tabs can move to Working (S/M).
- [ ] Regenerate the README screenshot: it predates the status bar, + Claude ▾,
      the account chips and the background ring (S).

## Session tracking robustness
- [x] Resume-an-existing-conversation flow (0.6.2): right-click `+ Claude` opens
      claude's picker; the picked old conversation is auto-pinned by mtime revival.
      0.6.20: a visible ↺ Resume button does the same (since 0.6.38: + ▾ → All
      conversations…), and feed agents get the pick pinned about 1 s after
      picking, before any message (verified live), so "pick, then restart before
      typing" no longer loses it.
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
- [ ] Optional: our own "All conversations…" picker (lists this repo's transcripts whatever
      the drive-letter case, resumes by id). Claude's picker hides lowercase-`d:\`
      conversations (anthropics/claude-code#90588); drop this if they fix it.
      2026-10-01: the existing 41 were repaired (CLAUDE.md, picker bullet). Only
      build this if new VS Code-started sessions keep hitting it.

## Multi-agent / multi-repo
- [x] Parked agents + one "+ ▾" menu (0.6.38): Park stops an agent and keeps
      its conversation on a shelf (🅿 chip, menu Resume section, board strip);
      Unpark resumes it by id. ↺ Resume and + Terminal folded into the menu.
- [ ] Named groups for parked agents (later): one shelf for now.
- [ ] Worktree-gone fallback (restore/unpark) points to "All conversations…", but
      Claude's picker at the repo root lists only the current tree's sessions
      (Ctrl+W shows all worktrees). Say "press Ctrl+W in the picker", or open the
      picker with that view (found 0.6.38 review). S
- [ ] With VibeSpace phone control OFF, a resumed agent still printed
      "/remote-control is active". Check whether the user's global Claude setting
      enables Remote Control on its own, and whether the wrapper should pass an
      explicit opt-out. S
- [ ] **Multi-subscription agents** (2026-10-01, RESEARCH-MULTISUB.md) — run tabs on
      several Max accounts + z.ai, switch a tab to another account when it hits its
      usage limit (`StopFailure rate_limit` → `--resume <id>` on the next profile).
      Decided: token profiles, Claude accounts only, auto-switch (DECISIONS.md).
      Built in 0.6.29. **Detection is verified live** (3 real hits, 2026-10-02 to
      10-06): StopFailure fires with `error: "rate_limit"`, and the transcript
      gave the exact reset each time. **Still open: a live SWITCH.** Every hit so
      far logged "all accounts exhausted", because the second account (MAIN,
      token) was only added on 2026-10-06. The next limit hit is the test: expect
      a toast and the tab resuming on the other account; grep `account switch`.
      z.ai verified live against the real API (2026-10-07, isolated test: add,
      request, transcript family, resume). Still to click through in a window: add it via
      + Add account → z.ai (key only, 0.6.50), + ▾ → New agent on z.ai, check `/status` shows the z.ai base
      URL and the GLM model, one prompt, then restart the window and confirm
      it resumes on z.ai (not Claude). Also try "All conversations…" on a GLM
      conversation from a Claude tab: it must move itself to z.ai.
      **"Move all here" (0.6.47) has not run live**: first try it in ONE
      restarted window with 2-3 agents (one idle, one working, one with a
      half-typed prompt) and check the log for `account switch:` / `account move:`.
      Also open: a model-specific weekly limit (Fable has its own) marks the
      WHOLE account out. Check `quotaLimits.rateLimitType` on such a hit first.
- [x] **Phone / away mode via Remote Control** (0.6.21, RESEARCH-REMOTE.md) —
      per-tab `--remote-control` names, presence marker + 📱 toggle + lock/idle auto-away.
- [x] **Live-verify phone control** (2026-10-01): question → push → answered on
      the phone → PC continued. Still open: permission prompt from the phone; ~20
      sessions at once; whether close-together pushes get dropped (seen once).
- [x] **Worktree tabs** (0.6.36) — ▾ → New agent in a worktree:
      `repo/.claude/worktrees/<name>` on `vs/<name>`, removed on close when clean.
- [ ] **Git pane for the active worktree** (M) — Changes/History of the worktree
      tab you're looking at, not only the main tree.
- [x] (0.6.52) **Per-workspace worktree setup command** (S) — run after a worktree is made,
      e.g. copy `.env` or `npm ci`, so the agent doesn't start without deps.
- [x] File tree and Ctrl+P index walk into `.claude/worktrees/` (every worktree's
      files showed up twice). Hidden in the tree/index/watcher (0.6.37).
- [ ] **Cross-workspace overview** (M) — small always-on-top window or launcher view:
      all agents across all repos, live status (idle/thinking/waiting-on-permission),
      click to focus. Needs a status signal from claude (OSC title or output heuristics).
- [ ] **New agent presets** (S) — per-workspace prompt templates (e.g. "backend",
      "frontend") applied to `+ Claude` with a name + optional first message.
- [x] Model picker per tab (0.6.52: + ▾ → New agent with model).

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
- [ ] Subagent outage nudge (0.6.57): not seen live yet; check `net: nudged` /
      `subagent failed:` on the next drop. The board text still says
      "continues automatically" for a nudged tab (S).
- [ ] Internet outages (0.6.54), watch the next real drop: grep `net:` and
      `toast: failed`. Not run live yet: the 3-continue cap and "fails again →
      back to waiting". The dashed amber light is close to the blue background
      ring; tell them apart better if it confuses (S).
- [x] (0.6.55) Session-timing heuristic briefly gave one fresh tab another tab's
      session in the outage test (pre-feed fallback path) — check (S).
- [x] (0.6.55) Restore of a tab whose saved session is a running BACKGROUND job (claude
      refuses: "running in the background"): detect `kind: "bg"` in
      `~/.claude/sessions/*.json` before typing the resume and say so / offer
      `claude attach` instead of a dead prompt. Since 0.6.53's feed filter a pin
      can't flip to a bg id any more, so this only hits older saved states (S).
- [ ] Automatic account order (0.6.53), watch live: a toast per moved tab (batched
      in 0.6.55); a token account's % only refreshes
      while one of its agents runs, so its room can be stale until its reset;
      a restored tab moves only after its first turn + a cold cache (~1 h).
      Check `account auto:` lines after the next weekly reset (S).
- [x] (0.6.55) Worktree setup command: a `#` in it comments out the rest of the typed
      line, so claude doesn't start. Run the setup from a script block or
      encoded command instead of pasting it inline (S).
- [x] (0.6.55) Model tag after `/model` + restart with no message sent: the resumed
      conversation comes back on its OLD model (resume never gets `--model`)
      while the tag shows the new one (S).
- [ ] Background fetch: an ssh agent that asks for approval on every use
      (1Password) could pop up every 5 min. Watch for it (S).
- [ ] Unit tests for sessions.cjs assignment heuristic (pure logic, easy to test).
- [ ] Rate-limit `fs.watch` + polling in sessions.cjs (currently 4 s poll per workspace).
- [ ] i18n pass if anyone else ever uses this. 😄
