<p align="center"><img src="assets/logo-256.png" width="140" alt="VibeSpace logo"></p>

# VibeSpace

**One window per git repository, with as many Claude Code agents in it as you
like, and they all come back after a restart.**

VibeSpace is a desktop app (Windows first, macOS too) for people who run many
[Claude Code](https://github.com/anthropics/claude-code) agents at once.
Each repository gets its own window and its own taskbar app: a file tree, a
code viewer, a read-only git view, and a row of named agent tabs. Every tab
tells you at a glance whether its agent is working, waiting for you or done.
Close the window, reboot the PC, update Claude Code: every conversation
resumes where it was.

It runs the unmodified Claude Code CLI with your own subscriptions. There is no
VibeSpace account, no server and no telemetry.

> **Status:** built by one person for their own daily use (10-20 agents
> across several repos on Windows) and offered as-is, for free. It leans on
> Claude Code details that are not a stable API (hooks, the status line,
> transcript files), so a Claude Code update can break something until it is
> fixed here. Issues are welcome; there is no support promise.

## Who it is for

- You run several Claude Code agents in parallel and keep losing track of
  which one is waiting on you.
- You work on Windows, where most agent tools are Mac-first.
- You want agents to survive a closed window, a crash or a reboot without
  hunting for session ids.

If you run one agent at a time in one terminal, you don't need this.

## Screenshots

<!-- TODO: workspace window with several agent tabs (lights: working / needs you / done) -->
<!-- TODO: agent board (Ctrl+Shift+B) -->
<!-- TODO: Inbox of final replies -->
<!-- TODO: git sidebar with a side-by-side diff -->

*Screenshots coming soon.*

## Features

- **One window per repo.** Its own taskbar button, pin and logo (Windows
  AppUserModelID; on macOS its own Dock tile), and a launcher that lists every
  workspace.
- **Agents that survive restarts.** A reloaded or crashed window re-attaches to
  the running agents (same processes, scrollback restored). Restarting the app
  or the PC resumes each tab's conversation with `claude --resume <id>`, and
  the id comes straight from Claude Code, so `/clear` and `/resume` are
  followed exactly.
- **Status lights on every tab.** Amber = working, red = needs you (a
  permission or a question, with the reason on hover), red ✕ = the turn
  failed, green = done, blue ring = done but its background work still runs.
  Toasts and a taskbar badge when an agent needs you; Ctrl+Shift+U jumps to
  the next one.
- **Inbox** (📥, Ctrl+Shift+M). The final reply of every turn, failed turns and
  open questions of the window's agents, with unread marks, so a report
  doesn't drown under tool output.
- **Agent board** (▦, Ctrl+Shift+B). Every agent as a card in Needs you /
  Working / Done, with context, cost and tasks, and a quick reply box.
- **On each tab:** context meter, task progress, model and effort, prompt
  cache countdown, and a peek card with the start of the last reply.
- **Worktree tabs.** An agent in its own git worktree, so parallel agents never
  edit the same files; closing the tab removes the worktree only when nothing
  would be lost.
- **Parked agents.** Stop an agent but keep its conversation on a shelf, and
  resume it days later.
- **Git view, review only.** Changes with a side-by-side diff, searchable
  history, ahead/behind, and a one-click fast-forward when the remote has new
  commits. Everything else in git is left to your agents.
- **Files.** Live git-coloured file tree, Monaco editor tabs, Ctrl+P file
  finder, full-text search, `file:line` links in agent output, image/video
  preview.
- **Multiple accounts.** Use the subscriptions you pay for: add more Claude
  accounts (each tab shows which one it runs on; the top bar shows each
  account's 5-hour and weekly usage), and API endpoints such as z.ai GLM for
  new conversations. When one of your accounts reaches its limit, its agents
  can continue on another of your accounts.
- **Phone control** through Claude Code's own Remote Control: your agents show
  up in the Claude phone app, and "Away" mode decides when your phone buzzes.
- **Internet drops** make agents wait quietly and continue by themselves when
  the connection is back.
- **Terminal details:** keyboard selection in Claude's prompt
  (Shift/Ctrl+Shift + arrows), correct emoji widths, Ctrl+F search, paste and
  file drop.
- 20 colour themes, terminals docked right or bottom, crash-safe saved state.

## Requirements

- **Claude Code CLI** on the PATH, and either a Claude subscription (Pro or
  Max) or an API key for an Anthropic-compatible endpoint such as z.ai.
- **Windows 10/11:** Git for Windows (Claude Code needs its Bash) and
  Windows PowerShell (built in). PowerShell 7 is only needed for agents that
  hand work to cloud sessions themselves.
- **macOS 13 (Ventura) or newer**, Apple silicon or Intel.

## Install

- **Windows:** follow [GETTING-STARTED.md](GETTING-STARTED.md) (about 10
  minutes).
- **macOS:** follow [GETTING-STARTED-MAC.md](GETTING-STARTED-MAC.md).
- Downloads are on the [Releases](https://github.com/enerage/vibespace/releases)
  page.

The builds are **not code-signed**. Windows SmartScreen says "Windows protected
your PC" (click **More info → Run anyway**); macOS says it can't check the app
(use **System Settings → Privacy & Security → Open Anyway** once). The guides
walk you through both. Installed copies offer new versions on the ↻ button.

### From source

```powershell
git clone https://github.com/enerage/vibespace.git
cd vibespace
npm install
npm run rebuild   # builds node-pty for Electron
npm start         # launcher; npm run dev adds opt-in hot reload
```

## What VibeSpace changes on your system

Short version: it starts each agent with an extra `--settings` file (hooks and
a status line that post to a local 127.0.0.1 server inside VibeSpace), defines
a `claude` function in its own terminals, turns on Claude's Remote Control for
your logged-in account unless you switch it off per workspace, stores extra
account keys encrypted (DPAPI on Windows, Keychain on macOS), and reads Claude
Code's own files to track conversations. It contacts only GitHub Releases (for
updates) and your git remote; Claude Code talks to Anthropic and to endpoints
you add. No telemetry.

The full list is in **[PRIVACY.md](PRIVACY.md)**.

## How it works

- Each workspace is its own Electron process with its own app identity, which
  is what makes Windows treat it as a separate app.
- Terminals are xterm.js over node-pty (ConPTY on Windows). The agent
  processes live in the main process, so a reloaded window re-attaches to them.
- The injected `--settings` file points Claude Code's hooks and status line at
  a local server inside VibeSpace. That feed drives the lights, reasons,
  context meter, tasks, Inbox and the exact conversation id.
- Conversations stay in `~/.claude/projects/` as usual. VibeSpace remembers
  which tab had which conversation and resumes it by id.
- Extra Claude accounts are `claude setup-token` tokens handed to that tab's
  `claude` only; phone control is Claude Code's own Remote Control.
- Plain stack: Electron, xterm.js, node-pty, Monaco; no bundler, no framework.

## Developing

```powershell
npm run smoke    # self-tests (Windows and macOS); run after touching main-process code
npm run dist     # Windows NSIS installer (electron-builder)
```

Logs are in `~/.vibespace/logs/<workspace>.log`. Useful lines to search for:
`tabs:` (which tab had which conversation, and when that changed) and `lag:`
(where a slow keystroke's time went). Ctrl+Shift+D in a window copies a
diagnostics bundle.

Read `CLAUDE.md` first: it encodes the decisions learned the hard way.
`DECISIONS.md` is the one-line-per-decision log, `CHANGELOG.md` the full
history, `TODO.md` the roadmap. The `RESEARCH-*.md` files document the bigger
investigations:

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
| `RESEARCH-MAC.md` | the macOS port |

## Support

VibeSpace is free. If it saves you time, you can support it through
[GitHub Sponsors](https://github.com/sponsors/enerage).

## License

[MIT](LICENSE)

---

Not affiliated with Anthropic. VibeSpace runs the unmodified Claude Code CLI
with your own subscriptions; Claude and Claude Code are trademarks of
Anthropic.
