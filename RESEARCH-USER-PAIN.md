# RESEARCH-USER-PAIN — what agent power users complain about, mapped to VibeSpace

Web research conducted 2026-09-26. Sources: Reddit (r/ClaudeCode, r/ClaudeAI, r/cursor,
r/warpdotdev), GitHub issues (anthropics/claude-code, microsoft/terminal), Hacker News,
personal blogs of heavy Claude Code users. Focus: pains that matter to a Windows-only,
Electron, no-bundler app shaped as tree + Monaco preview + named agent terminals + launcher.

## What VibeSpace already got right (validated by the research)

- **One window per repo with its own identity.** The single most-reported multi-agent
  failure is "wrong-window paste" — e.g. the r/ClaudeCode thread "what are people using
  to keep multiple claude code sessions organized?" (2026-08-30, 184 comments): OP
  "pasted review feedback into the wrong session and watched it start applying changes
  to the wrong repo" twice in one week. Per-repo windows with per-repo taskbar pins are
  exactly the isolation those users are reinventing (one commenter built a Windows 11
  virtual-desktop hack to get the same effect).
- **Windows-native matters.** Every praised session manager is macOS/Linux: cmux
  (Ghostty/macOS), Agent Deck (tmux → WSL required). In Agent Deck's launch thread
  (2025-12-28) the repeated questions are "Is it Windows friendly?" / "Is there something
  similar for windows?" / "WSL is such a worse experience for me". VibeSpace occupies
  an empty niche.
- **Session capture + `--resume` relaunch** matches what cmux lists as a headline
  feature ("sessions detect their session ID automatically and resume where you left off").

The gap is not *management* (tabs, splits) — it is **attention and review**: knowing which
agent needs you, being told when one finishes, and seeing what it did.

---

## Candidate features

### 1. Per-tab agent status light (working / waiting-on-me / idle)
- **What:** colored dot or border on each terminal tab (and optional pane ring) showing
  live agent state, driven by Claude Code hooks (`Notification` for permission/idle,
  `Stop` for completion, `SessionStart`), with a pty-side or file-based signal into the
  renderer.
- **Evidence:** the loudest recurring wish across every thread. r/ClaudeCode 1w2ezng
  (2026-08-30): "now im the one staring at four panes trying to remember which agent is
  waiting on me". Agent Deck's pitch line one (2025-12-28): "Running (green), Waiting for
  input (yellow), Idle (gray). No more checking each tab." cmux Show HN (2026): "When an
  agent is waiting, its pane gets a blue ring and the tab lights up in the sidebar."
  Codeman, Session Kit, Galactic all sell the same thing. Windows Terminal issue #30011
  (2026) is literally "No visual indicator when waiting for user confirmation/permission."
- **Effort:** M (hook plumbing: VibeSpace injects a `--settings` hook that writes a
  marker file / named pipe per pty; renderer polls. No OSC parsing needed).
- **In TODO?** Partially — "Cross-workspace overview" mentions live status and "needs a
  status signal from claude", but the per-tab indicator and the hook plumbing itself are
  not spelled out. This is the foundation half the TODO items depend on.

### 2. Native Windows toast on finish / permission-needed, click-to-focus
- **What:** app-registered `Stop` + `Notification` hooks → native toast (with the tab
  name and ideally the notification text) → click focuses that workspace window and tab.
- **Evidence:** an entire cottage industry exists because this is missing on Windows:
  alexop.dev "Notifications when tasks finish" (2025-11), kane.mx desktop-notifications
  tutorial (2025-12), aident.ai guide (2026-07), BurntToast WSL2 gists,
  soulee-dev/claude-code-notify-powershell, and an mcpmarket "Windows Notification Skill"
  whose selling point is "one-click terminal focus". Fragility is documented:
  blog.netnerds.net (2026-02-07) — Claude Code runs hooks via Git Bash on Windows, so
  naive `powershell` hook calls break (VibeSpace hit this itself in 0.3.2). cmux author:
  "Claude Code's notification body is always just 'Claude is waiting for your input'
  with no context" — an app that knows the tab name can do better than the DIY hooks.
- **Effort:** S-M (VibeSpace already spawns `claude`; register hooks via a generated
  settings file per workspace, receive events via marker file or local socket).
- **In TODO?** No — TODO has "taskbar overlay badge" only (no toast, no click-to-focus,
  no hook wiring).

### 3. "Jump to agent needing attention" hotkey + unread markers
- **What:** Ctrl+Shift+U-style binding cycles to the next tab with unseen output /
  waiting state; tabs keep an unread dot until visited.
- **Evidence:** cmux: "Cmd+Shift+U jumps to the most recent unread" + "persistent unread
  state". Agent Deck thread (2025-12-30): "having a keyboard shortcut to switch between
  sessions without going via the menu would be awesome". Same thread: "I forget to check
  in on other sessions", "Do you know how many times I forget about 1-2 of my claude
  sessions?!"
- **Effort:** S (trivial once #1's signal exists).
- **In TODO?** No.

### 4. Per-agent "what changed" review (git status/diff in the preview pane)
- **What:** one click per terminal tab → preview pane shows `git status --porcelain`
  (colored, clickable files) and a Monaco diff view of dirty/branch-diff files for that
  agent's working tree.
- **Evidence:** r/ClaudeCode 1w2ezng (2026-08-31 comment): "the wrong-window paste thing
  is a symptom. the real killer: you lose visibility on what each agent decided and stop
  challenging those decisions." penkin.me "Herding Claudes" (2026) built `hunk` for live
  diff review of parallel worktree agents; Claude Squad's flow is "post-agent review,
  commit, push"; Claude Code itself shipped a `/diff` panel (v2.1.260+) because users
  kept asking how to see what changed. TODO's "git status colors in tree" is the static
  version; per-agent review is the agent-shaped version.
- **Effort:** M (`git status`/`git diff` exec + Monaco DiffEditor, no new deps).
- **In TODO?** Only the tree-coloring fragment; the diff review surface is not.

### 5. Last-message / context preview per session
- **What:** tab tooltip or sidebar line showing each agent's last assistant message
  (or first line of it), read from the tracked `~/.claude/projects/.../<id>.jsonl`.
- **Evidence:** Agent Deck thread (2026-01-28): "when I step away, I often forget
  exactly what each session was doing… I have to scroll up and re-read just to find the
  action items — it'd be amazing to [see] only the sessions currently waiting for input."
  cmux sidebar shows "the latest notification text for each workspace". Agent Deck ships
  "quick preview of what each session is doing".
- **Effort:** S-M (VibeSpace already discovers and watches these jsonl files for session
  capture — it uniquely has the data; tail the file, parse last assistant message).
- **In TODO?** No.

### 6. Cross-workspace agent overview (all repos, one glance)
- **What:** always-available view (launcher page or small window) listing every agent
  across every open workspace with state + click-to-focus.
- **Evidence:** Galactic ("surfaces all active Cursor/Claude/Codex sessions in one
  panel… at least you're not hunting through windows wondering what's running",
  r/ClaudeCode 2026-05-02); Agent Deck groups; "What I really want is a tiny dashboard:
  project, status, last message, send a reply, stop/resume" (1w2ezng, 2026-09-01) — with
  users asking for it to work "from a phone" (see HN "Detach – Mobile UI for managing AI
  coding agents", 2026-03).
- **Effort:** M (much easier after #1/#2 exist — the launcher already knows all
  workspaces).
- **In TODO?** Yes — "Cross-workspace overview (M)". Evidence says: prioritize it right
  after the status plumbing.

### 7. Worktree tabs (agent in `repo/.claude/worktrees/<name>`)
- **What:** spawn an agent into its own worktree + branch from the `+ Claude` UI.
- **Evidence:** official Claude Code docs now have a dedicated worktrees page
  (code.claude.com/docs/en/worktrees); "How do you actually manage multiple parallel
  Claude" (r/ClaudeCode): "each task as its own branch + worktree + agent session";
  understandingdata.com "3x throughput"; GitButler built a hooks-based alternative
  (auto-branch per session) because raw worktrees are clunky. Windows users are
  underserved here (tooling is tmux-centric). Complements #4 (review per worktree).
- **Effort:** L.
- **In TODO?** Yes — "Worktree tabs (L)".

### 8. Session picker / graceful dead-session resume
- **What:** when a pinned session id no longer resumes, offer a picker instead of an
  erroring terminal.
- **Evidence:** GitHub issues: "`/resume` is broken — shows only ~5-10 recent sessions
  despite hundreds" (2026-02); "`--resume` fails silently when cwd differs" (2026-06,
  3 duplicate issues); "[BUG] 2.1.27 session resume logic is losing context" #22107
  (2026-01); docs note "`--resume` doesn't restore permission mode". Resume is flaky
  enough that a wrapper app adding a reliable picker is real value.
- **Effort:** M.
- **In TODO?** Yes — "Session picker on restore (M)". Evidence confirms it's worth the
  M, not a nice-to-have.

### 9. Terminal scrollback search (and buffer that survives reloads)
- **What:** Ctrl+F search in terminal output (xterm search addon); longer-term the
  ptyhost ring buffer so reload keeps output.
- **Evidence:** WT/HN consensus that in-terminal search is a top ask; Agent Deck thread:
  "I have to scroll up and re-read just to find the action items"; tmux's persistence is
  the single most-praised property of every tmux-based manager ("sessions persist through
  disconnects… if your terminal crashes, your sessions are still there") — and its
  rendering is the most-hated ("can't stand the jagged line-by-line scrolling of tmux").
  A native Electron equivalent gets praise without the jank.
- **Effort:** S (search addon) / M (ring buffer, already spec'd in RESEARCH-HOTRELOAD
  Layer 2).
- **In TODO?** Yes — both listed.

### 10. File:line links from agent output → preview pane
- **What:** auto-link absolute paths and `file.cs:123` in terminal output; click opens
  Monaco at that line.
- **Evidence:** universal IDE-terminal expectation (VS Code / iTerm cmd+click); agents
  constantly print paths. No dedicated complaint thread found, but it's table stakes in
  every "terminal for agents" product (Wave, cmux, VS Code).
- **Effort:** S.
- **In TODO?** Yes.

### 11. Editor tabs (multiple open files)
- **What:** tabs in the preview pane instead of single-file preview.
- **Evidence:** implied by every comparison to real IDEs in the threads ("just use VS
  Code" is the stock reply to every terminal manager); no loud dedicated complaint —
  lower urgency than attention features.
- **Effort:** M.
- **In TODO?** Yes.

### 12. Quick-reply / control a background agent without switching tabs
- **What:** from the overview or tab context menu: send a line of stdin to that pty
  (e.g. answer a permission prompt or "continue"), or stop it.
- **Evidence:** "a tiny dashboard: … last message, send a reply, stop/resume" (1w2ezng,
  2026-09-01); captain-miao author: "[my dashboard] allows for reading and sending
  messages to each pane, which is better than Claude's SendMessage functionality"
  (2026-08-30). Cursor's whole background-agent pitch is remote review/reply.
- **Effort:** M (pty.write exists; the UI and guardrails are the work).
- **In TODO?** No — but borderline scope creep; only build after #1/#2/#6.

### 13. Agent presets / model per tab
- **What:** per-workspace prompt templates for `+ Claude`, per-tab model flag.
- **Evidence:** Agent Deck ships per-project env/config toggling as a headline feature;
  "Model picker per tab … like Claude Layout Session" already in TODO; moderate demand.
- **Effort:** S.
- **In TODO?** Yes — both.

### 14. Usage/cost aggregation across agents (not recommended now)
- **What:** sum per-session token spend from statusline/usage data.
- **Evidence:** weak/indirect (multi-account limit complaints, e.g. r/ClaudeCode user on
  two €200/mo accounts); Claude Code's own statusline covers per-session cost.
- **Effort:** M. **In TODO?** No. **Verdict: skip** — poor fit, ToS-adjacent, low demand.

---

## Ranked shortlist — 5 highest value-to-effort NOT already built

1. **Per-tab agent status light (hook-driven)** — #1 wish in every thread surveyed
   ("which agent is waiting on me?"); VibeSpace controls the `claude` spawn so it can
   inject the hooks no DIY user gets right. M, and it unlocks items 3 and 6.
2. **Native finish/permission toast with click-to-focus** — replaces an entire fragile
   ecosystem of BurntToast/PowerShell hook scripts (with documented Git-Bash breakage
   VibeSpace itself hit in 0.3.2); S-M, pure Windows strength.
3. **"Jump to next attention-needed" hotkey + unread tab markers** — the cheapest
   feature on the list (S once #1 lands) and explicitly praised wherever it exists
   (cmux Cmd+Shift+U).
4. **Per-agent git diff/status review in the preview pane** — answers "you lose
   visibility on what each agent decided", the deepest complaint found; fits Monaco
   with zero new deps. M.
5. **Last-message preview per session from the tracked .jsonl** — VibeSpace already
   watches those files, making it the only tool that can do this nearly for free;
   directly requested in Agent Deck thread ("forget what each session was doing").
   S-M.

Sequence note: 1 → 2 → 3 is one coherent "attention" milestone; 4 and 5 are
independent. Items already in TODO (overview, worktrees, session picker, terminal
search, links) are all *validated* by this research — none should be deprioritized,
but none of them deliver attention state, which is the loudest unmet need.
