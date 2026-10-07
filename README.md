<p align="center"><img src="assets/logo-256.png" width="140" alt="VibeSpace logo"></p>

# VibeSpace

**One taskbar app per repository. File tree, code editor, git review and named
Claude Code agent terminals, in a single window that belongs to your repo.**

VibeSpace gives every git repository its own Windows app identity (its own
taskbar icon, its own pin, its own logo), and inside that window you run, watch,
and supervise any number of Claude Code agents. Close the window, reopen it next
week: every conversation comes back exactly where it left off.

![VibeSpace workspace](assets/screenshot.png)

*Three agents on one repo: amber = working, green = finished, red pulse = waiting
for your answer. Left: git-colored file tree. Top: Monaco editor.*

## Why

Running multiple Claude Code agents across repos from a pile of terminal windows
sucks: you lose track of which agent is waiting on you, windows die with your
shell, and there's no sense of "the place where I work on *this* project."
VibeSpace is that place, built for people who live in agents all day.

- **Per-repo identity**: each workspace pins to the taskbar as its own app with
  its own logo (Windows AppUserModelID, the Chrome-profile trick).
- **Agents never die**: a window reload or crash *re-attaches* to the running
  claude processes (same PIDs, scrollback restored) instead of killing them.
  Restarting VibeSpace, a Claude Code update or a PC reboot resumes every
  conversation automatically.
- **Supervision, not staring**: every agent tab tells you its state at a glance
  (working, needs you, finished, or finished with background work still
  running), with toasts, a taskbar badge, an agent board and your phone.
- **Agents do the work, you review**: the git views are read-only on purpose,
  and nothing in the UI competes with what you'd ask an agent to do.
- **Deliberately plain**: no bundler, no framework, no VibeSpace account, no
  cloud. Electron + xterm.js + node-pty + Monaco, about 12k lines of readable
  JavaScript.

## Features

### Agents

| | |
|---|---|
| 🔵 **Status lights** | amber = working · red pulse = needs you (🔒 permission, **?** question) · red ✕ = the turn failed · green = finished. Hover the light for the reason, e.g. "needs permission: Bash — npm test". Permission prompts turn the light red at once |
| ◌ **Background state** | a tab whose turn finished while its subagents or shell commands still run shows a spinning blue ring and lists them. It is waiting on its own work, not on you; Claude continues by itself when they end |
| ➕ **+ Claude ▾** | the tab bar's one "new" button: click = new agent; ▾ or right-click = *New agent*, *New agent in a worktree*, *New terminal*, then **Resume**: parked agents, *All conversations…* (Claude's picker), kept worktrees |
| ⎇ **Worktree tabs** | an agent in its own git worktree (`.claude/worktrees/<name>` on branch `vs/<name>`), so parallel agents never touch each other's files. Tab menu: *Ask agent to merge back*. Closing the tab removes the worktree only when nothing would be lost, and says why when it keeps it |
| 🅿 **Parked agents** | tab right-click → Park stops an agent but keeps its conversation, worktree and last reply on a shelf (🅿 n chip, hover for the last reply); click to resume it later. Never auto-resumed on restart |
| 🏷 **Tabs name themselves** | a new agent tab takes Claude's own title for the conversation after your first message; a name you type always wins. Renaming a tab renames the Claude session too (phone and resume list) |
| 📋 **Tab menu** | right-click a tab: Rename, Agent info (model, context, cost, session ID, transcript path), Copy name / session ID / resume command, Park, Close. Tabs drag to reorder and wrap onto extra rows when there are many |
| 📊 **On every tab** | a context meter along the bottom edge (green / amber / red), a `3/7` task pill, an account chip (with 2+ accounts), an unread marker. Hover a tab for a peek card: state, model, context, cost, tasks and the start of the last reply |
| ▬ **Status bar** | under the active terminal, one line: what the agent is doing and for how long, or the first line of its last reply (click to read it), plus prompt-cache countdown, context, model, tasks and subagents |
| ▦ **Agent board** (Ctrl+Shift+B) | every agent as a card in Needs you / Working / Done, with context, cost and tasks; quick-reply box on finished agents; background `claude --bg` agents with Attach; other open workspaces listed below |
| 💬 **Session tracking** | each tab's conversation id comes straight from Claude, so `/clear`, `/resume` and the picker are followed exactly. A `claude` you type by hand in a tab is tracked too. Dead sessions reopen Claude's resume picker |

### Staying in the loop

| | |
|---|---|
| 🔔 **Notifications** | Windows toast when an agent needs your answer or a turn failed, with the reason; click focuses the window *and* the exact tab. You pick which kinds in Preferences ("finished" is off by default). Taskbar badge on the workspace icon |
| 📱 **Phone control + Away** | every agent shows up in the Claude phone app (Claude Code Remote Control, named "workspace · tab"): read, answer questions, approve, send follow-ups. The 📱 At PC / Away button decides when your phone buzzes: away = screen locked, 10 min idle or set by hand. Opt out per workspace |
| ⌨️ **Ctrl+Shift+U** | jump to the next tab that needs you |
| 📈 **Plan usage chip** | top bar: your Claude plan's 5-hour and 7-day usage with the reset countdown; turns red at 90 % |
| 👥 **Several Claude accounts** | ⚙ Preferences → Accounts: add extra Max/Pro subscriptions (tokens encrypted with Windows DPAPI). When an agent hits a usage limit, the same conversation continues on the next account in the same tab. *Move all here* moves every open agent to one account without interrupting anyone · **z.ai GLM / any Anthropic-compatible API**: pick z.ai and paste your API key, for new conversations (a conversation never moves between Claude and GLM) |

### Files, editor and git

| | |
|---|---|
| 🌲 **File tree** | git-colored (modified / added / untracked / deleted), refreshed live as agents write files, keeps its scroll position and open folders. Right-click: New file / folder, Rename (F2), Delete to the Recycle Bin, Git history, Open / Reveal in File Explorer. Drop files from Explorer onto a folder to copy them in |
| 📝 **Tabbed editor** | Monaco with per-file tabs, Edit / Save, each tab remembering its cursor and scroll. Files changed on disk by agents refresh in place (your unsaved edits always win) |
| 🔗 **Clickable file:line** | `src/app.js:42` in an agent's output opens that file at that line |
| 🌿 **Git sidebar** | Files \| Git tabs on the left, like VS Code. **Changes**: side-by-side diff of uncommitted work. **History**: searchable commit list with unpushed ↑, `agent` badges and "new since you looked" dots; click a commit for its files. Top-bar branch chip shows ahead/behind. Read-only on purpose |
| 🔍 **Ctrl+P** | fuzzy file finder over the whole repo |

### Terminal

| | |
|---|---|
| ⇧ **Keyboard selection in Claude's prompt** | Shift+←/→, Ctrl+Shift+←/→ (word), Shift+Home/End; then Backspace, Ctrl+C or just type. Claude Code can't do this itself yet |
| 📎 **Copy, paste, drop** | Ctrl+C copies a selection (and interrupts only when nothing is selected), Ctrl+V and right-click paste, dropping files onto a terminal pastes their paths |
| 🔍 **Ctrl+F** | search inside the active terminal |
| 😀 **Correct character widths** | emoji and wide characters take the same space Claude expects, so its redraws don't leave scrambled text behind |

### The workspace

| | |
|---|---|
| 🪟 **One app per repo** | its own taskbar button and pin, Explorer right-click → "Open with VibeSpace", a launcher that lists every workspace |
| 🖼 **Logos** | click the logo to pick from the images found in the repo (or browse for a file, or drop an image on it). The window and taskbar icon update right away |
| 🎨 **20 color themes** | 15 dark + 5 light, per workspace; UI, terminal colors and editor all follow |
| ⇄ **Layout** | terminals docked right or at the bottom, resizable panes, window size and position remembered per workspace |
| ↻ **Smart restart** | the ↻ button appears only when VibeSpace's own code changed or Claude Code auto-updated (the label says which). It restarts at once when no agent is busy and names the busy ones otherwise. "Restart this workspace" is always in ⚙ Preferences |
| 🛟 **Crash-safe state** | saved state is flushed to disk before it replaces the old file and a backup copy is kept, so a reboot or power cut can't wipe a workspace. A Windows shutdown never saves "all tabs closed" |

### Keyboard shortcuts

| Keys | |
|---|---|
| Ctrl+P | find a file |
| Ctrl+F | search the active terminal |
| Ctrl+Shift+U | next tab that needs you |
| Ctrl+Shift+B | agent board |
| Ctrl+Shift+D | copy a diagnostics bundle |
| F2 | rename the selected tree file |
| Shift / Ctrl+Shift + arrows | select text in Claude's prompt |

## Install

**Windows 10/11.** New here? Follow **[GETTING-STARTED.md](GETTING-STARTED.md)**:
Git for Windows, Claude Code, the installer, and a Claude login or a z.ai key, in
about 10 minutes.

Short version: grab `VibeSpace Setup <version>.exe` from
[Releases](../../releases), install, pin the launcher. Claude Code must be on
PATH (`~/.local/bin/claude` is picked up automatically).

### From source

```powershell
git clone https://github.com/enerage/vibespace.git
cd vibespace
npm install
npm run rebuild   # builds node-pty for Electron
npm start         # launcher; or: npm run dev (adds opt-in hot reload)
```

## How it works (short version)

- Each workspace is **its own Electron process** with a unique AppUserModelID
  set before app-ready. That's what makes Windows treat it as a separate app.
- Agent terminals are **xterm.js over node-pty (ConPTY)**. The claude processes
  live in the main process, so a reloaded window *re-attaches* to them
  (256 KB output ring per terminal restores scrollback).
- Every claude is started with an injected `--settings` file. It points
  Claude's own hooks and status line at a small **local server inside
  VibeSpace** (127.0.0.1 only). That feed is where the lights, the reasons, the
  context meter, tasks, background work and the exact conversation id come
  from. Your own Claude settings and status line keep working alongside it.
- Conversations live in `~/.claude/projects/` as usual. VibeSpace only remembers
  which tab had which conversation and resumes it with `claude --resume <id>`.
- Phone control is Claude Code's own Remote Control; extra accounts are
  `claude setup-token` tokens. VibeSpace has no server of its own.

## Developing

```powershell
npm run smoke    # 113 self-tests; run after touching main-process code
npm run dist     # NSIS installer (electron-builder)
```

Regenerate the README screenshot (staged demo repo → captured window):

```powershell
electron . --open-repo=<demo-repo>          # once, to create the workspace
electron . --workspace=<its-id> --screenshot=assets/screenshot.png
```

Logs are in `~/.vibespace/logs/<workspace>.log`. Useful lines to search for:
`tabs:` (which tab had which conversation, and when that changed) and `lag:`
(where a slow keystroke's time went).

Read `CLAUDE.md` first: it encodes the decisions learned the hard way.
`DECISIONS.md` is the one-line-per-decision log, `CHANGELOG.md` the full
history, `TODO.md` the honest roadmap. The `RESEARCH-*.md` files document the
bigger investigations:

| File | About |
|---|---|
| `RESEARCH-HOTRELOAD.md` | why reloads used to kill agents |
| `RESEARCH-USER-PAIN.md` | what agent users actually complain about |
| `RESEARCH-CLAUDE-DATA.md` | everything Claude Code exposes (hooks, status line, transcripts) |
| `RESEARCH-GIT.md` | the read-only git UI |
| `RESEARCH-REMOTE.md` | phone control and away mode |
| `RESEARCH-MULTISUB.md` | several Claude subscriptions |
| `RESEARCH-TERMINAL-GARBLE.md` | scrambled characters in the terminal |
| `RESEARCH-INPUT-SELECTION.md` | keyboard selection in Claude's prompt |

## License

[MIT](LICENSE)
