# Changelog

Format: Keep a Changelog-ish. Dates are local (2026-09-26 = initial build day).

## [0.6.40] — 2026-10-04

### Changed
- **Changing the logo starts in the repo.** Clicking the logo (top left) now
  opens a picker that shows the images found in this repo, most logo-like
  first (`logo.*`, favicons, app icons; screenshots and banners last). Click
  one to use it. **Browse…** is still there for any other file, and it now
  opens in the repo folder instead of wherever Windows last was. Dropping an
  image on the logo works as before.
- The search never looks in `node_modules`, build output (`dist`, `.next`,
  `build`…), dot-folders or agent worktrees, skips files over 2 MB, and is
  capped in depth, folder count and time. On real repos it took under a second
  (PlacementFlow: 312 images, 0.9 s) and put the real logo first.
- Verified live: the picker listed the repo's images and not the copy planted
  in `node_modules`, Browse… opened in the repo folder, and picking an image
  replaced the icon and reloaded the window with agents re-attached.
  Smoke 96/96.

## [0.6.39] — 2026-10-04

### Added
- **Select text in Claude's prompt with the keyboard.** Shift+←/→ selects by
  character, Ctrl+Shift+←/→ by word, Shift+Home/End to the start/end of the
  line. Then Backspace or Delete removes the selection, Ctrl+C copies it, and
  typing replaces it. Claude Code itself can't start a selection from the
  keyboard (anthropics/claude-code#80734; it's the same in Windows Terminal),
  but in fullscreen mode it has a mouse selection that it extends with
  Shift+arrows. So VibeSpace starts one for it with a synthetic mouse drag at
  the caret (`renderer/workspace/ui/inputsel.js`).
- Limits: one prompt line at a time (it doesn't cross into a wrapped or second
  line), and a line containing emoji or other wide characters falls back to
  Claude's normal behaviour. Plain shell tabs are untouched, so PowerShell's
  own Shift+arrow selection still works there.
- Verified live against Claude Code 2.1.289 with real key presses: single
  character left and right, word left and right, shrink, Home/End, collapse,
  Backspace, Delete, type-to-replace and Ctrl+C.

## [0.6.38] — 2026-10-03

### Added
- **Park an agent and bring it back later.** Tab right-click → **Park** stops
  the agent and puts it on a shelf with its name, worktree, model and last
  reply. Its memory, MCP servers and tab are freed; the conversation is kept.
  **Unpark** opens it in a new tab with `claude --resume <id>` (about 5 s, and
  Claude redraws the conversation). Park is greyed out until the agent has
  saved a conversation ("Nothing saved yet: send a message first"). Parking a
  working or waiting agent asks first; an idle one parks at once.
- **🅿 n chip** after the tabs: hover or click it for the parked list. Hover an
  entry for a card with the name, ⎇ branch, model, "parked 5 days ago" and the
  last reply (scrollable). Click = unpark; ✕ = forget, with no confirm (the
  conversation stays in Claude's own history and *All conversations…*).
- Parked agents survive window close, ↻ Restart, a crash and a damaged
  state.json (`.bak` restore), and are **never auto-resumed**: a restart keeps
  them parked. A parked worktree agent keeps its worktree, and *Kept
  worktrees* shows it as "🅿 parked as <name>" (click = unpark), not as an
  orphan.
- The agent board has a **Parked (n)** strip: click a chip to unpark, hover for
  the same card.
- The instance log's `tabs:` trail logs `parked` / `unparked` / `forgot` lines
  and lists parked agents when a window opens.

### Changed
- **One "+ ▾" menu instead of three buttons.** The tab bar is now
  `[+ Claude][▾]` and `▦ Board`. The menu: *New agent*, *New agent in a
  worktree*, *New terminal*, then **Resume**: parked agents (newest first, 10,
  then *More parked…*), *All conversations…* (Claude's picker, formerly
  ↺ Resume) and *Kept worktrees (n)*. Right-click on + Claude opens the same
  menu (it used to start the picker directly). The separate ↺ Resume and
  + Terminal buttons are gone. Smoke 95/95. Takes effect after one ↻ Restart.

## [0.6.37] — 2026-10-02

### Fixed
- **Closing a worktree tab can no longer delete unmerged work when git can't
  answer.** If VibeSpace couldn't read the worktree's status or compare its
  branch with the base (git error, base branch deleted, main tree on a detached
  HEAD), that used to count as "nothing unmerged", and the tab close would remove
  the worktree and its branch. Now "couldn't check" is reported as a reason to
  keep it, and the discard confirm says so too. Found in review of 0.6.36.
- **Worktree files no longer show up twice** in the file tree and Ctrl+P:
  `.claude/worktrees/` (each worktree is a full checkout) is hidden there and in
  the tree watcher. Smoke 91/91. Takes effect after one ↻ Restart.

## [0.6.36] — 2026-10-02

### Added
- **Worktree tabs: an agent in its own git worktree**, so parallel agents never
  touch each other's files. The **+ Claude** button has a **▾** caret: *New
  agent*, *New agent in a worktree*, *Resume a conversation…*. A worktree agent
  gets `<repo>\.claude\worktrees\<name>` on branch `vs/<name>`, made from the
  repo's current HEAD (a dirty main tree is fine: its uncommitted changes stay
  there). The tab's shell runs in the worktree too. A toast says what isn't
  shared (node_modules, .env, build output).
- Worktree tabs show a **⎇** badge. The tab tooltip, the activity strip, the
  peek card and the board card show `⎇ vs/agent-5 · from main`. The worktree is
  saved with the tab and restored into it. If its folder is gone, the tab
  opens as a plain terminal at the repo root with a toast, and never resumes
  into the wrong folder.
- Tab menu on a worktree tab: **Ask agent to merge back** (only while the agent
  is idle; it sends the agent a commit-and-merge prompt, so git writes stay with
  agents) and **Open worktree folder in Explorer**.
- **Closing a worktree tab** removes the worktree and its branch when nothing
  would be lost ("worktree agent-5 removed (nothing unmerged)"). Otherwise it
  keeps them and says why ("kept: 2 commits not merged · 3 uncommitted files").
  Kept worktrees are listed under **▾ → Worktrees (n)**: *Open agent here*
  (Claude's resume picker in that folder), *Remove* (only when clean), and
  *Remove and discard…* (a confirm box lists exactly what is lost).
- `.claude/worktrees/` is ignored locally through `.git/info/exclude` (never
  `.gitignore`), so the main tree's git status stays clean.
- Session tracking follows worktree tabs: the feed's `transcript_path` pins the
  conversation even though it lives in the worktree's own `~/.claude/projects`
  dir, and the restore check looks there too.
- Verified live in a throwaway home and repo, with a real Haiku claude: the
  caret menu opened a ⎇ tab in the worktree with real mouse clicks; the feed
  pinned the session from the worktree's project dir; a restart restored the
  tab into the worktree and resumed the conversation; closing it removed the
  worktree and branch; a second worktree with a commit was kept with its
  reason, then *Remove and discard…* removed it after the confirm. Smoke 90/90.

## [0.6.35] — 2026-10-02

### Added
- **Typing-lag log.** When a typed key takes over 0.5 s to show up, the
  instance log gets a `lag:` line saying where the time went: key→screen total,
  how long claude/the shell took to echo it, whole-machine CPU %, and whether
  VibeSpace's main process was blocked. A blocked window (renderer) and a
  blocked main process get their own lines. At most one line per tab per 15 s.
  Prompted by "I type and nothing shows": at that moment all 16 cores were at
  100 % from agents' vitest and tsc runs in other repos, and VibeSpace itself
  used about 0.2 of a core. Verified live: a key typed into a busy shell logged
  `key→screen 2274ms · claude/pty echo 2269ms · cpu 100% · main loop ok`.
  Smoke 84/84.

## [0.6.34] — 2026-10-02

### Fixed
- **Mixed-up characters in Claude Code after an emoji.** xterm counted emoji
  such as 😀 ✅ as 1 cell wide, while Claude Code and Windows' ConPTY count
  them as 2. Every emoji shifted the rest of its row by one column, so Claude's
  partial redraws landed in the wrong cells and left scrambled leftovers. Every
  terminal now loads xterm's Unicode 11 width table (`@xterm/addon-unicode11`,
  the same as VS Code's default). Verified live: rows with emoji now line up
  with plain-text rows. Research and the other, less likely causes are in
  RESEARCH-TERMINAL-GARBLE.md.

## [0.6.33] — 2026-10-02

### Added
- **File Explorer from the tree's right-click menu.** On a file: **Reveal in
  File Explorer** (opens its folder with the file selected). On a folder:
  **Open in File Explorer** (opens the folder itself) and **Reveal in File
  Explorer**. On empty space in the tree: **Open in File Explorer** for the repo
  root. Opening is limited to folders inside the workspace, since Windows
  would *run* a file handed to it this way.
- Verified live with real right-clicks: each Explorer window opened at the right
  place with the right item selected. Smoke 83/83.

## [0.6.32] — 2026-10-01

### Changed
- **One ↻ Restart button instead of two.** Claude Code updates itself in the
  background, so by the time the old ⟳ "Update & Restart All" button appeared,
  the new version was already on disk. Its extra `claude update` run did
  nothing, and restarting is all that's left. ↻ now shows up for new VibeSpace
  code **or** a new Claude Code, and its label says why: "↻ Restart VibeSpace",
  "↻ Restart · Claude 2.1.x", or "↻ Restart · updates ready". The ⟳ button, its
  "Updating Claude Code…" modal and the `claude update` step are gone.
- **Restart only asks when it would interrupt someone.** If no agent is
  working, ↻ (and Preferences → Restart this workspace) restarts immediately.
  If one is busy, the confirm box names it ("Restart anyway").
- Verified live: the label for each reason, the busy agent named in the
  confirm, and an idle restart with no dialog. Smoke 83/83.

### Fixed (repair, no code)
- The 2026-10-01 reboot also zeroed the state files of **flexfunnels** and
  **justlinked** (all-NUL, the same damage as recruitica and flexiq). Both were
  rebuilt from the `tabs:` audit log while their windows were closed, so they
  resume `bee1d73d…` / `7e1eb1dd…` on open (layout back to default). Broken
  files kept as `state.json.corrupt-*`.

## [0.6.31] — 2026-10-01

### Fixed
- **A Windows shutdown/restart no longer touches the saved workspace.** When
  Windows announces the session is ending, VibeSpace saves every window's state
  and geometry one last time and then **freezes** the state files. Windows can
  kill the terminal processes before VibeSpace itself, and those exits used to
  look like "tabs closed", which could save an empty tab list over the good
  state. The same freeze applies to a normal quit.
- Verified live via the main-process inspector: after the session-end event, a
  terminal was killed and its tab vanished from the UI, but the saved state
  still listed all three tabs.

## [0.6.30] — 2026-10-01

### Fixed
- **A PC restart could wipe a workspace's saved state.** After a reboot,
  recruitica-nextjs came back with one fresh agent (its conversation
  `0d10d298…` not resumed) and the terminal at the bottom instead of the right.
  - Cause: `state.json` is rewritten every ~5 s. The new file was renamed into
    place before its bytes reached the disk, so the reboot left it unreadable.
    The read failed silently, the window fell back to defaults, and those
    defaults were saved over the file.
  - Fix, for every JSON file VibeSpace writes (workspace state, the workspace
    list, window geometry, notification and account settings…):
    - The new file is flushed to disk before it replaces the old one.
    - The previous good copy is kept as `<file>.bak`. An unreadable file is
      restored from it automatically, and the damaged file is kept as
      `<file>.corrupt-<time>`.
    - The log gets a `json:` warning when this happens.
  - `state.json` is now only written when something actually changed.
  - Smoke 83/83 (simulated reboot damage restores from `.bak`).

## [0.6.29] — 2026-10-01

### Added
- **Several Claude subscriptions, automatic switch on usage limit.**
  - ⚙ Preferences → **Accounts**: your logged-in account plus any extra Max/Pro
    accounts. To add one, log into it in your browser, run `claude setup-token`
    (the "Open a setup-token tab" button does it), and paste the token.
    - Tokens are encrypted with Windows DPAPI in `~/.vibespace/accounts/`. They are
      never written in plain text, to a terminal or to logs.
    - Order = preference. New agents start on the first account that still has room.
  - **Auto-switch.** When an agent's turn dies on "You've hit your weekly/5-hour
    limit", that account is marked out until its exact reset time. The reset
    comes from claude's own `quotaLimits` record in the transcript. The same
    conversation then continues on the next account with `claude --resume <id>
    "continue"`, in the same tab, with an in-app notice.
    - What doesn't switch: short 429s, overloaded, and "out of usage credits".
    - At most 3 switches per tab in 10 min.
  - Each agent tab shows a small account chip (only when you have 2+ accounts).
    Right-click → "Continue on <account>" moves an agent by hand.
  - Token accounts get no phone control: Claude's Remote Control only works on
    the `/login` account.
  - Smoke 82/82. The live limit → switch run is still pending.

## [0.6.28] — 2026-10-01

### Added
- **Restart this workspace, any time** (⚙ Preferences → "Restart this workspace").
  The ↻ button in the top bar still only appears when there's new VibeSpace
  code. The Preferences row is always there, for a stuck UI, after a settings
  change, or whenever you want. It's the same flow as ↻: any busy agents are
  named in the confirm box, then the window relaunches maximized and focused,
  and every conversation resumes. Verified live in a throwaway workspace.

## [0.6.27] — 2026-10-01

### Changed
- **Many agents: tabs wrap onto extra rows** instead of hiding off-screen behind a
  sideways scroll. While tabs and buttons fit they share one line. Once they
  don't, the tabs get their own full-width rows under the + Claude / ↺ Resume /
  + Terminal / ▦ Board buttons (docked right, the buttons used to squeeze the tabs
  into one column). Capped at 3 rows; past that the tab area scrolls so the
  terminal keeps its room. The terminal refits once when the row count changes.
  Drag-to-reorder works across rows. Verified with 3/14/20 tabs, both docks, and
  a real mouse drag from row 1 to row 2. Takes effect after one ↻ Restart.

## [0.6.3] — 2026-09-28

### Added
- **⚙ Preferences modal** — the header keeps only 📨 Sync Docs, ↻/⟳ (when
  relevant) and ⚙; terminal dock (bottom/right), auto-resume, logs folder and
  the new theme picker moved inside. New settings = one row + one state key.
- **20 per-workspace color themes** (15 dark + 5 light): full palette swap —
  UI, xterm ANSI set, and the Monaco base all follow, `color-scheme` flips so
  native scrollbars/inputs match. Applied instantly, saved in workspace state,
  replayed pre-paint on window open (no default-theme flash). The default
  `VibeSpace Dark` is the pre-theme palette, byte-exact. Style.css literals
  were tokenized into theme vars; accent/ok/danger glows derive via
  `color-mix()`.

## [0.6.0] — 2026-09-27 (evening)

### Added
- **Editor tabs**: the preview pane is now a tabbed editor — every opened file
  gets a pill (dirty dot, × and middle-click close with an unsaved-changes
  confirm), each tab remembers its own cursor/scroll and Edit/Read-only state,
  and open tabs + the active one survive window reloads via workspace state.
  Files edited on disk by agents refresh in place (unsaved edits always win);
  files deleted on disk close silently. Binary/too-large files open as
  placeholder tabs.
- **Tree file operations**: right-click the tree — New file / New folder
  (rows, folders, and the pane background for repo root), Rename (F2 too), and
  Delete to the **Recycle Bin** with a confirm. Name entry uses a small modal
  (Electron has no native prompt). Renames rekey open editor tabs (unsaved
  edits follow the file); deletes force-close tabs under the path. Git colors
  refresh immediately after each operation.
- **Clickable file:line links in terminals**: claude's output mentioning
  `D:\repo\src\app.js:42` or `src/app.js:42` lights up — click to open the
  file in the preview at that line (relative paths resolve against the
  terminal's cwd, then the repo root; quoted paths with spaces work). Uses
  xterm's link-provider API, no new dependency. Known limit: unquoted paths
  containing spaces don't linkify.
- **⟳ Changes tab (git diff review)**: a pinned tab at the end of the strip
  (or the Diff toolbar button) opens a side-by-side Monaco diff of all
  uncommitted changes — worktree + index vs HEAD, untracked included, binary
  and huge files skipped, CRLF normalized so Windows checkouts diff cleanly.
  Per-file "open in tab" and refresh; 3 s cache, busted by tree operations.

### Changed
- **fs IPC is now jailed to the workspace**: `fs:write` and `fs:copyInto`
  destinations must live inside the sending window's own repo root (path
  resolve + case-insensitive prefix check) — previously any absolute path was
  writable. New `fs:create/mkdir/rename/delete` channels carry the same jail
  (`main/util.cjs` `jailed()`). Smoke grows to 42 checks: jail accept/reject,
  fsops round-trip incl. a real Recycle-Bin move, and a temp-git-repo diff
  fixture.

## [0.6.2] — 2026-09-28 (evening)

### Fixed — 0.6.1's PATH rebuild silently did nothing in the case it was for
- **`reg` was called by name**, so from a mangled PATH (the exact case the rebuild
  exists for) it wasn't found, the registry read returned '' and only the inherited
  junk survived. Now `execFileSync` on `%SystemRoot%\System32\reg.exe`, no shell.
- **`repairPath` itself injected the mangled entries**: its literals
  `'C:\Windows\System32\WindowsPowerShell\v1.0'` are JS escapes ("C:Windows…" plus
  a vertical-tab char from `\v`). Now built with `path.join` from `SystemRoot`.
- **Drive-relative entries dropped**: `C:Windows` passed the exists-check (statSync
  resolves it to C:\Windows); rebuild now requires `path.win32.isAbsolute`.
- Smoke: new check rebuilds FROM a mangled PATH — the old check ran from a healthy
  shell where `reg` resolved, which is why 0.6.1 passed while broken. 45/45.
- Symptom it fixes: agent terminals with a 5-entry PATH (`C:WindowsSystem32…`),
  node/npm/pnpm/python/git not found by name. Needs one VibeSpace restart.

## [0.6.26] — 2026-10-01

### Fixed
- **Renaming an agent tab now renames it on your phone too.** Before, the
  phone name was fixed when claude started, so a renamed tab still showed up as
  "VibeSpace · agent-1". The rename is sent to claude as `/rename <workspace> ·
  <name>`, which updates the Remote Control name and the `/resume` list title.
  It waits until the agent has finished its turn and you haven't typed since,
  so it never lands inside a half-typed prompt or a dialog. Verified live:
  `/rename` from the tab renamed the phone session, and a pasted `/rename` runs
  as a command.

## [0.6.25] — 2026-09-30

### Added
- **Choose which notifications you get** (⚙ Preferences → Notifications).
  Three switches for the Windows pop-ups:
  - **An agent needs your answer** (permission prompt or question): on.
  - **Something went wrong** (a failed turn): on.
  - **An agent finished its turn**: **off by default**. With many agents it
    fired constantly.

  The choice is machine-wide: one setting for every workspace, applied at once
  in all open windows (`<dataRoot>/notify.json`). Tab lights and the taskbar
  badge are unchanged and still show every state. A skipped pop-up is logged as
  `toast skipped`. Takes effect after one ↻ Restart per window. Smoke 74/74.

## [0.6.24] — 2026-09-29

### Fixed
- **Space stopped typing in every agent tab until you alt-tabbed twice.**
  - Cause, from the keydiag logs: every episode started right after a native
    `confirm()` box (Close tab, ↻ Restart). On Windows, Electron's window gets
    no real focus event after that box closes. Key presses still arrive, but
    typed characters are never generated until the window is re-focused.
  - xterm sends letters straight from the key press, but a plain Space only
    from the typed character. That's why letters kept working and Space didn't.
  - Every native dialog in workspace windows is now an in-app `confirmBox()`:
    close tab, ↻ Restart, ⟳ Update, tree delete, and close unsaved file.
    Enter = OK, Esc = cancel, and focus goes straight back to the terminal.

### Added
- **Tab ↔ conversation audit trail in the instance log** (`main/tablog.cjs`):
  - On window open: every tab, with its kind (claude/plain) and session ID.
  - After that, one line per change: new tab, closed tab, rename, session
    `— → <id>`, and kind changes.
  - Plus `claude launch` / `claude resume` lines.
  - **Warning:** a tab that looks like an agent (claude tab, or it has a live
    feed) but still has no conversation ID after 3 minutes is logged once as
    "a restart would NOT resume it". That's the state the IMPROVE UI tab sat
    in, unnoticed, for 12 hours.
  - Grep the log for `tabs:`.

## [0.6.23] — 2026-09-29

### Fixed
- **A claude you type yourself in a VibeSpace tab is now tracked like one
  VibeSpace launched.** Before, typing plain `claude` or `claude --resume <id>`
  started it without our hook settings. That meant no status lights, no session
  tracking and no phone control, so a restart reopened a fresh claude instead of
  that conversation. Every VibeSpace terminal now has a `claude` wrapper that
  adds `--settings` and the `--remote-control` name when they're missing.
  Subcommands (`claude update`, `attach`, …) and `-p` runs pass through
  untouched. Verified live: a hand-typed `claude --resume <id>` resumed the
  conversation, connected Remote Control and ran our hooks. Smoke 72/72.
- Background: a conversation first started from VS Code or cmd with a lowercase
  `d:\` is hidden from claude's `/resume` picker and refuses to open there
  ("This conversation is from a different directory"). That is Claude Code bug
  anthropics/claude-code#90588. `claude --resume <id>` is not affected.

Takes effect for new tabs after one ↻ Restart.

## [0.6.22] — 2026-09-29

### Fixed
- **"UserPromptSubmit hook … timed out after 10s" is gone. Your prompt is no
  longer held up to 10 s.**
  - The status hooks used to start a Git Bash process on every prompt and
    every tool call just to write `working`/`done` to a file. Claude waits for
    those hooks, and when the machine was busy a cold bash start took more
    than 10 s.
  - VibeSpace now writes the same words itself when the claude data feed's
    HTTP hooks arrive: nothing is spawned, and it answers in under 1 ms.
  - Lights, toasts, the taskbar badge and the busy check read the same status
    files, so they behave exactly as before.
  - The Git Bash hooks are only used if the feed server couldn't start.
- Verified live: submitting a prompt → working, end of turn → done, and a
  question from Claude → red "waiting" within 2 s, staying red while it waits.
  That last one is the "orange dot while stuck on a question" report; the fix
  came with 0.6.19's attention arbitration.
  Takes effect after one ↻ Restart. Smoke 71/71.

## [0.6.21] — 2026-09-29

### Added
- **Phone control:** agent tabs launch with `claude --remote-control "<workspace> · <tab>"`,
  so every agent shows up in the Claude phone app (Code tab). From the phone you
  can read the transcript, answer questions, approve prompts and send follow-ups
  to the same local session. Per-workspace opt-out in ⚙ ("Phone control"). While
  connected, transcripts sync to Anthropic. Applies to agents started after the
  change, so restart a workspace to pick it up.
- **📱 At PC / Away** header button. Claude only pushes to the phone while you're
  away. Away switches on when the screen locks or after 10 min idle, and back on
  unlock or when you return. The manual toggle waits until you've really been
  gone ≥ 2 min before your return flips it back. The state is machine-wide
  (`main/presence.cjs` drives claude's `CLAUDE_CLIENT_PRESENCE_FILE` marker).
  Going away warns about agents already waiting, because those won't re-notify
  the phone. Windows toasts are unchanged. Smoke 70/70.

## [0.6.20] — 2026-09-29

### Added
- **Prompt-cache chip** on finished agents, in the activity strip, peek card and
  board. `cache warm · 3:12` counts down live and turns amber in the last minute.
  After that it shows `cache cold`: the next message re-reads the whole context,
  which is slower and costs more. It hides while the agent works.
- **Compaction states**: the strip and board say "compacting context…" while
  claude compacts. An idle agent at 85 %+ context shows "auto-compact soon".
- **Background agents on the board** (agents started with `claude --bg` in this
  repo): name, state and age, plus **Attach**, which opens `claude attach <id>` in
  a new tab. The list refreshes every 15 s while the board is open. Closing the
  tab leaves the agent running.
- **↺ Resume button** next to + Claude. It opens Claude's picker in a new tab so
  you can continue an earlier conversation, and the pick is saved to that tab. It
  does the same as right-clicking + Claude, which still works.

### Changed
- **Permission prompts turn the light red at once.** Before, it took about 6 s,
  because only claude's "user is away" notification set it. The toast and
  taskbar badge move with the light, and the late notification no longer toasts
  a second time. When you approve, the light goes back to amber.
- **Session tracking is exact.** Each tab's conversation id now comes straight
  from claude's own data, tagged with the tab. `/clear` or `/resume` inside a tab,
  and two agents started at the same moment, are tracked correctly, so ↻ Restart
  and restore resume the right conversation. Agents started before 0.6.16 keep
  the old timing-based guess.
- **A conversation picked in the resume picker is saved right away**, as is one
  switched to with `/resume <id>`. You don't have to send a message first, so
  "pick, then restart before typing" no longer loses the pick. Verified live:
  claude reports the picked id about 1 s after the pick.

Takes effect after one ↻ Restart. Smoke 67/67.

## [0.6.19] — 2026-09-29

### Added
- **Agent board** (▦ Board next to + Terminal, or **Ctrl+Shift+B**). It covers
  the terminal area only, so the preview stays usable and the agents keep
  running underneath.
  - Every agent in this window appears as a card in one of four columns: **Needs
    you** · **Working** · **Done** (newest first) · **Other**. Empty columns
    shrink to a header with a count. In a narrow pane the columns stack.
  - A card shows the light, name and model, then one line: what the agent is
    doing, why it needs you, or the start of its last reply. Below that come
    context, cost, lines +/−, tasks with the current one, time working or since
    done, and subagents.
  - Click a card to jump to its tab. Esc or ✕ closes the board.
  - **Quick reply** on finished and failed agents: type, press Enter, and the
    text goes to that agent as if you typed it. Permission and question waits
    have no reply box, because typed text plus Enter could pick "Yes". You
    approve those in the terminal.
  - **Other workspaces**: other open VibeSpace windows are listed at the bottom
    with their agents as small chips. Click a row to switch to that window.
- The tab menu's **Agent info** panel now shows model, context (tokens), cost,
  lines, tasks and session name when the tab has feed data.

### Fixed
- **Opening a workspace that was already open briefly started a second copy.**
  The copy opened a window and spawned the saved agents' terminals for about 2 s
  before quitting. The launcher's Open button hit this whenever the workspace
  was already open. Now the copy just hands off focus and exits.
- The tab bar no longer slides tabs under the + Claude / + Terminal buttons
  when space runs out; the tabs scroll instead.

Takes effect after one ↻ Restart. Smoke 63/63.

## [0.6.18] — 2026-09-29

### Changed
- **Right-clicking an agent tab opens an options menu.** It used to start a
  rename. The menu has:
  - **Rename…**; double-clicking the name still renames directly.
  - **Agent info…**: a panel with name, kind, status, session ID,
    `claude --resume <id>`, the transcript path
    (`%USERPROFILE%\.claude\projects\…\<id>.jsonl`), folder and terminal
    ID. Each has its own Copy button, plus **Copy all** for a paste-ready block.
  - **Copy name**, **Copy session ID** and **Copy resume command**. The last
    two are greyed out until the conversation exists (after the first message).
  - **Close**, which asks the same confirm as ✕.
- The tree's right-click menu now uses the same shared helper
  (`common.js showMenu`, with separators and disabled items).

## [0.6.17] — 2026-09-29

### Added
- **Richer agent lights.** A red light with a lock means the agent needs
  permission, and a red light with a "?" means it's asking you a question. A
  red ✕ means the turn failed, for example on a rate limit or API error. It
  shows even when the light would otherwise say done. Hover the light for the
  reason, e.g. "needs permission: Bash — npm test".
- **Toasts say why**: "agent-2 needs permission: Bash — npm test". A failed
  turn now toasts and turns the taskbar badge red. Before, it left the light
  amber.
- **Activity strip** above the active terminal, one line:
  - while working: `● agent-2 · Edit src/app.js · 1m12s`
  - when finished: `done 3m ago · "first line of the reply"`; click the reply to
    read it
  - when it needs you: the reason, in red
  - on the right: context bar, model, `3/7 tasks` (click for the checklist) and
    the number of running subagents
- **Peek card**: hover an agent tab for about ⅓ s to see its state, model,
  context and cost, what it's doing now, its task list and the start of its
  last reply. It never takes focus from the terminal, and Esc closes it.
- **Task pill on tabs** (`3/7`) whenever the agent tracks tasks or todos. It
  hides a minute after an all-done turn ends.

### Changed
- The plan-limit chip now shows in every window, including windows with no
  running agent. Processes share the latest limits through
  `~/.vibespace/limits.json`, and data older than 6 h is ignored. A window whose
  reset time has passed shows — instead of a stale %.
- The "Claude is waiting for your input" idle nudge no longer counts as the
  agent needing you.

Tabs without feed data (plain terminals, agents started before 0.6.16) look
exactly as before. Takes effect after one ↻ Restart. Smoke 62/62.

## [0.6.16] — 2026-09-29

### Added
- **Context meter on every agent tab.** A thin bar along the tab's bottom edge
  shows how full the context window is: green under 60 %, amber under 85 %, red
  above that. It appears after the agent's first reply. Hover the tab name for
  the model, context % (used/total tokens), session cost and lines +/−.
- **Plan-limit chip in the top bar**: `5h ▰▰▱ 42% · 1h12m   7d ▰▱▱ 18%`.
  - It shows your Claude plan usage for the 5-hour and 7-day windows, with a
    countdown to the 5-hour reset.
  - Hover it for the exact reset times.
  - It turns red when a window reaches 90 %.
  - It stays hidden until claude reports limits (API-key accounts never do).
- **Claude data feed** behind both (`main/claudefeed.cjs`):
  - A local server receives claude's status line and HTTP hooks.
  - Both are injected through the `--settings` file every agent already gets.
  - It also collects "now doing", attention, last reply and tasks for the
    next UI steps.
  - The existing status lights don't depend on it.
  - If you have your own statusLine, it keeps working: VibeSpace passes the same
    data to it and shows its output.

Takes effect after one ↻ Restart; running agents pick it up when relaunched.
Smoke 60/60.

## [0.6.15] — 2026-09-29

### Changed
- **Git moved to the left sidebar, like VS Code's Source Control.** The left
  pane now has **Files | Git** tabs. The Git tab shows a yellow count of
  uncommitted files.
  - The **Changes / History** lists live in that Git tab.
  - Clicking a file opens its diff in the preview's pinned **Diff** tab.
    Switching the sidebar to Git never covers the file you're reading.
  - The Changes list refreshes by itself while visible, as agents edit files.
  - The sidebar view is remembered per workspace.
  - The branch chip always opens full-repo History (clearing a file filter).
    The Diff button and tree → Git history open the sidebar too, and pressing
    the same entry point again goes back to Files.

## [0.6.14] — 2026-09-29

### Added
- **Git history.** The pinned preview tab is now **Git**, with two modes:
  - **Changes** is the old uncommitted diff.
  - **History** is new:
    - A searchable commit list with branch/tag pills.
    - A yellow ↑ on commits not pushed yet.
    - An `agent` badge on commits with a `Co-Authored-By: Claude` trailer.
    - A blue dot on commits that are new since you last looked.
    - Click a commit to see its message and changed files (+/− counts,
      renames shown as `old → new`). Click a file for its before/after in the
      diff editor.
    - Merge commits diff against their first parent.
- **Branch chip in the top bar**: `main ↑2 ↓1`.
  - Shows unpushed/behind counts and a red warning when the repo is stuck
    mid-merge or mid-rebase.
  - Click it for History.
  - It updates every 10 s, on focus and on file changes. When an agent
    commits, the History list refreshes on its own.
- **Tree → right-click → Git history** on any file or folder. File history
  follows renames.

### Fixed
- **The Changes tab always said "Not a git repository".** Its security check
  (`U.jailed`) only accepts paths strictly *inside* the repo, so it rejected
  the repo root itself.
- **Our background git calls could make an agent's commit fail** with
  `index.lock exists`, because `git status` briefly locks the index. All
  read-only git calls now run with `GIT_OPTIONAL_LOCKS=0` (and never prompt
  for credentials).
- The "no changes" placeholder no longer covers the file list and swallows its
  clicks.

Read-only by design: nothing in the Git pane writes to the repo. Takes effect
after one ↻ Restart. Smoke 57/57.

## [0.6.13] — 2026-09-29

### Fixed
- **Dropping files onto a terminal pastes their paths** (Windows Terminal style:
  full path, quoted if it has spaces, several files space-separated). Drop an
  image from Explorer onto a Claude tab and Claude attaches it. Dropped text
  pastes as-is. Before this the terminal had no drop handler and nothing happened.
  Takes effect after one ↻ Restart.

## [0.6.12] — 2026-09-29

### Changed
- **↻ Restart brings the window back maximized and focused.** The relaunch passes
  `--restarted`; the new window maximizes and is brought to the front (with an
  always-on-top nudge if Windows' focus-stealing rules would leave it behind).
- **Windows remember their geometry** per workspace (`instances/<id>/window.json`:
  normal bounds + maximized), restored on every open; bounds that are no longer on
  any display are ignored. Windows are created hidden and shown on
  `ready-to-show` (no white flash). Verified: restarted → maximized+focused;
  normal reopen → maximized restored.

## [0.6.11] — 2026-09-29

### Fixed
- **"Some agents seem busy" false alarm on ↻ Restart** with one idle (green) agent.
  The check counted any terminal input/output in the last 5 s — and with Claude's
  mouse tracking on, merely moving the mouse toward the button sends input. Now a
  tab with a status light is busy only while its light is **working** *and* it's
  still producing output (a stuck light after an interrupt doesn't count); tabs
  without a light count recent OUTPUT only. Input never counts. The confirm names
  the busy agents. Verified via CDP: green + activity → not busy; amber + output →
  names the agent; amber but silent 16 s → not busy.
- **Status hooks capped at 10 s** (`timeout: 10`). A cold Git Bash start under load
  once took ~30 s (Claude's default cap) and, because UserPromptSubmit hooks block
  the prompt, delayed the user's message by 30 s. Root cause not reproducible
  (warm runs ~100 ms, broken-env runs too); the cap bounds the worst case.

## [0.6.10] — 2026-09-29

### Fixed
- **Preview header overflowed when the pane was squeezed**: at 240px its content
  needed 458px and all four buttons (Edit/Save/⌕/Diff) were pushed out of view.
  Now the buttons never shrink, the path gives way first, the file name ellipsizes,
  and below 420px (container query on `#viewer`) the path hides and buttons go
  compact. Measured via CDP at 220/240/300/420/700px: no overflow, no clipped
  buttons.

## [0.6.9] — 2026-09-29

### Fixed — the actual cause of "node / python / MCP servers not found" in terminals
- ptyhost copied the environment (`{ ...process.env }`) and then read/wrote
  `env.PATH`. On Windows the variable is `Path`; in a plain object copy `Path` and
  `PATH` are **two keys**, so every terminal got the full `Path` *plus* a stripped
  `PATH` (`.local\bin` + 3 System dirs) — and the stripped one won. Result: node,
  python, pnpm and stdio MCP servers launched by bare name (`mcp-postgres`, `node
  …/index.js` → pg-*, raze, reddit-rss "CONNECTION_CLOSED") all failed inside
  VibeSpace terminals. The 0.6.1 registry rebuild was correct but never reached
  ptys because of this. Now the pty env always has exactly one `Path` key.
- Smoke: 50 — incl. a real pty that must resolve `node` by name with the user npm
  dir on PATH, launched from a deliberately stripped shell.
- Existing terminals keep their broken env until their window is restarted.

## [0.6.8] — 2026-09-29

### Changed — attention toasts name the workspace AND the agent
- Toast title is now **`<workspace> · <agent tab name>`** (was the literal
  "VibeSpace — <tab>"), body "<agent> finished its turn" / "<agent> needs your
  input", with the workspace's logo as the toast icon. Click still focuses the
  window and the exact tab.
- Toasts now also fire when the window is focused but you're on a *different* tab
  (only suppressed when you're looking at that exact agent). The renderer reports
  the active tab to main (`activeTerm` in state).
- Note for users with a global Claude notify hook: it can skip its own toast when
  `$env:VIBESPACE_TERM_STATUS` is set (every VibeSpace terminal has it) to avoid
  duplicate toasts — done for Valentin's `~/.claude/notifications/notify.ps1`.

## [0.6.7] — 2026-09-29

### Fixed
- **Right-click paste pasted twice in Claude tabs.** Once past its trust screen,
  Claude Code enables full mouse tracking (`?1000/1002/1003/1006h`), so xterm
  forwards the right-click to Claude — which pastes from the clipboard itself —
  and our own contextmenu handler pasted again. Right-click now leaves pasting to
  the program whenever it tracks the mouse (`term.modes.mouseTrackingMode`);
  plain shells keep VibeSpace's paste. Reproduced and verified via CDP-driven real
  right-clicks: Claude tab 2 → 1, PowerShell tab 1 → 1.
- **Ctrl+Shift+C never interrupts** — it copies a selection or does nothing
  (Windows Terminal convention); plain Ctrl+C without a selection still interrupts.

## [0.6.6] — 2026-09-28

### Removed
- **📨 Sync Docs button and its broadcast transport** (`main/broadcast.cjs`, IPC,
  preload bridge, smoke test). "Update all docs" is a standing rule for agents
  (CLAUDE.md "How we work" + the `/sync-docs` skill), not a UI feature.

## [0.6.5] — 2026-09-28

### Fixed — new/re-logo'd workspaces showing the VibeSpace logo when pinned
- **Default workspace icon is now a per-name letter mark** (colored rounded square
  + initial) instead of the VibeSpace app logo. A brand-new workspace wearing the
  app's own logo looked like VibeSpace itself — and a pin made in that first
  second froze that image (reverts the 0.5.x "new workspaces default to app.ico").
- **Logo swaps rewrite taskbar pins too** (`User Pinned\TaskBar\*.lnk` matched by
  `--workspace=<id>`), not only Start Menu/Desktop shortcuts, and re-announce the
  window's AppDetails. Pins cache their icon at pin time; nothing refreshed them.

## [0.6.4] — 2026-09-28

### Fixed — pinned workspaces showing the Electron logo (root cause)
- Pinning a **running** workspace window whose AppID had no Start Menu shortcut
  (anyone who never used the launcher's Pin button) made Windows invent a junk
  `Electron.lnk` — the pin showed the Electron logo and relaunched nothing. Found
  4 of 7 workspaces in this state (FlexIQ, FlexFunnels, Recruitica, JustLinked).
- Every workspace window now **claims its taskbar identity** at open:
  `setAppDetails` (AppID, icon, relaunch command, display name — pinning the
  running window now yields a correct pin), **auto-creates its Start Menu
  shortcut** if missing, and **deletes junk `Electron*.lnk` strays** that target
  our exe with no arguments (never other apps' shortcuts). Smoke: 48.

## [0.6.3] — 2026-09-28

### Added — the knowledge system is a standing rule, not a button
- **DECISIONS.md** — flat append-only decision log, seeded with every major
  decision to date (hot-reload opt-in, pty attach, status hooks, PATH rebuild,
  live tree, picker pinning, …).
- **CLAUDE.md "How we work"** — every agent in this repo records decisions /
  changelog entries / lessons / TODOs / memory **as they happen**; "update all
  docs" runs `/sync-docs`; the 📨 button is optional sugar. A task isn't done
  until the docs are current.

## [0.6.2] — 2026-09-28

### Added — resume an existing conversation on purpose
- **Right-click `+ Claude` → "resume conversation…"**: the new tab opens claude's
  interactive `--resume` picker instead of a blank session.
- **Picked conversations get pinned**: the tracker now recognizes picker-launched
  tabs and pins the OLD session file that comes alive (appends after launch on a
  file born before it) — so restarts resume the conversation you actually chose,
  never a stray blank one. Excludes files owned by other tabs; most-recent-write
  wins. In-tab `/resume` (typed mid-session) is still untracked — see TODO.

## [0.6.1] — 2026-09-28

### Fixed — the stripped/mangled PATH class of bugs, for real
- **PATH is rebuilt from the registry (machine + user) at app boot.** Windows
  launched through agent-spawned chains inherit a broken PATH — stripped (only 2
  entries) or mangled (backslashes eaten: "C:Windows") — which broke `node`,
  `python`, `git` by name in every terminal AND every process VibeSpace spawns.
  `util.rebuildPath()` unions the authoritative registry PATH with whatever was
  inherited, expands %vars%, dedupes, and drops entries that don't exist on disk
  (mangled and %unset% leftovers die there). Applied to the process env at the
  very top of index.cjs, so ptys, git status, claude --version, builds —
  everything downstream — gets the full PATH. Existing windows need one restart
  (agents auto-resume) to heal; this replaces the 0.3.2 System32-only band-aid.

## [0.6.0] — 2026-09-28

### Added — "update all docs" system
- **📨 Sync Docs button** (workspace topbar): broadcasts `/sync-docs` to every
  Claude agent tab in every open workspace — one click, all agents sync. Transport
  is a watched trigger file (`~/.vibespace/broadcast/cmd.txt`), so workspaces
  running as separate processes all receive it, including the sender's own agents.
- **`/sync-docs` skill** (`.claude/skills/sync-docs`): the docs ritual — CHANGELOG,
  DECISIONS.md (new, flat decision log), CLAUDE.md lessons, TODO re-triage, README
  drift check, and agent memory updates. Docs and memory only, never code.
  Copy the skill folder into other repos to enroll them.

## [0.5.5] — 2026-09-27 (afternoon, part 2)

### Added
- **Drag to reorder tabs**: grab a tab and drop it anywhere in the bar — order
  persists in the workspace state. Follows the splitter drag rules (window
  capture listeners, no `setPointerCapture`); a 4 px threshold keeps clicks
  and the double-click rename from ever starting a drag.
- **Drag & drop into the tree**: drop files from Explorer onto any folder row
  (green highlight) or the tree background (repo root) — files are COPIED in,
  never overwriting (`name (2).ext` collision rename). The live tree watcher
  picks them up immediately.
- **Drop an image on the workspace logo** (top-left) to set it as the workspace
  logo — same flow as the 🏷 button / clicking the logo.

### Changed
- **Removed the duplicate 🏷 Logo… header button** — the top-left workspace
  logo already changes it on click (and accepts dropped images); the button's
  re-pin hint moved into the logo's tooltip.
- **Red light no longer cries wolf**: the idle "waiting for your input" nudge
  (fires ~60 s after an agent finishes) used to flip finished tabs from green
  to red, making both colors mean the same thing. The Notification hook now
  reads the notification JSON on stdin and drops the idle nudge — **red =
  agent demands input** (permission, question, choice), **green = task
  completed** (stays green while idle), orange = working. Applies to
  terminals launched after the update; running agents pick it up on restart.

### Fixed
- **Tab rename fought you for focus**: clicks inside the rename input bubbled
  to the tab's click handler → `activateTab` → `term.focus()`, ripping focus
  to the claude terminal mid-typing; and committing never rebuilt the bar
  (the mid-rename redraw guard saw the still-mounted input), leaving a stuck,
  un-focusable input as the tab face. The input now stops mouse-event
  propagation and removes itself before the rebuild.

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
