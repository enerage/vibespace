# What VibeSpace changes on your system, and what it sends where

VibeSpace has no account, no server of its own and **no telemetry**. It is a
local app that starts the normal Claude Code CLI in terminals and reads what
Claude Code already writes to disk. This page lists everything it touches, so
you can decide before you install it.

## How it starts Claude Code

- **An injected `--settings` file.** Every agent tab starts `claude` with
  `--settings <file>` (written to `~/.vibespace/instances/<workspace>/`). That
  file adds Claude Code hooks and a status line that post to a small HTTP
  server inside VibeSpace, listening on **127.0.0.1 only** (a random port).
  That is where the tab lights, the reasons, the context meter, the Inbox and
  the exact conversation id come from. Your own Claude settings stay in
  effect; if you have a status line of your own, VibeSpace's runs it and shows
  its output.
- **A `claude` shell function in its own terminals.** Each VibeSpace terminal
  (PowerShell on Windows, your zsh or bash on macOS) defines a `claude`
  function, so a `claude` you type by hand also gets the `--settings` file and
  is tracked. It does not touch subcommands, `-p`, `--version` or `--help`.
  Your normal terminals and shell profile are not changed (on macOS the
  terminal sources your own rc files first, from a separate `ZDOTDIR`).
- **Claude's Remote Control is on by default** for the account you are logged
  in with (`claude --remote-control "<workspace> · <tab>"`): your agents show
  up in the Claude phone app. While connected, Claude Code syncs the
  conversation with Anthropic for that. Turn it off per workspace in
  ⚙ Preferences → *Phone control*; it applies to agents started afterwards.
- **"At PC / Away".** VibeSpace sets Claude Code's
  `CLAUDE_CLIENT_PRESENCE_FILE` and creates or deletes that marker file
  (screen locked, idle, or your toggle), which decides when Claude pushes to
  your phone.

## Accounts and secrets

- Extra Claude accounts are `claude setup-token` tokens, and API endpoint
  accounts (e.g. z.ai) are your API key plus its settings. Both are stored
  **encrypted**: Windows DPAPI (current user) in `~/.vibespace/accounts/`, or
  the macOS Keychain.
- A token is handed only to the `claude` call of the tab that uses it. For an
  endpoint account, the tab's settings file holds the key in plain text while
  that tab runs (like Claude's own `settings.json` would); it is deleted when
  the tab closes or changes account, and on the next start.
- VibeSpace never reads or uses your Claude login token. For your logged-in
  account it only checks that Claude's credentials exist.
- **Usage numbers.** For an account with no running agent, VibeSpace runs
  Claude Code's own `claude -p /usage --no-session-persistence` (at most every
  30 minutes per account) and reads the printed percentages. It is a local
  command, not a model request. Windows only for now.

## Files of Claude Code it reads

- Transcripts in `~/.claude/projects/` (to know which tab has which
  conversation, to show the last reply, compaction and errors).
- `~/.claude/sessions/*.json` (to tell Claude's background agents apart from
  the tab).
- `~/.claude.json` (whether a login exists) and `~/.claude/settings.json` (your
  status line, and the model guard below).

## Files outside `~/.vibespace` it may write

- **`~/.claude/settings.json`, `model` only:** when a z.ai/endpoint tab's
  `/model` pick changes Claude's global default model, VibeSpace puts the
  previous value back, so your Claude tabs keep their model. Nothing else in
  that file is changed.
- **Your repository:** a quiet background `git fetch` every few minutes (to
  show ahead/behind). The ⬇ Update pill runs `git merge --ff-only` only when
  you click it. Worktree tabs create `.claude/worktrees/<name>` on a `vs/<name>`
  branch and add `.claude/worktrees/` to `.git/info/exclude` (never your
  `.gitignore`). Every other git write is left to your agents.
- **Windows:** a Start Menu shortcut per workspace (so it can be pinned as its
  own app), a Desktop shortcut when you ask for one, and the Explorer
  right-click entry "Open with VibeSpace" (per-user registry keys under
  `HKCU\Software\Classes`) when you turn it on.
- **Cloud sessions** (*Send to cloud*): a token account signs in once into its
  own folder `~/.vibespace/cloud/<account>`, used only for cloud calls.

Everything else (window state, logs, the Inbox of agents' final replies, kept
for 30 days) lives in `~/.vibespace/`.

## Network

VibeSpace itself contacts only:

- **GitHub Releases** (`api.github.com/repos/enerage/vibespace/releases`) to
  check for an update, in installed copies, about every 6 hours; a download
  (from GitHub) is checked against the sha256 digest GitHub publishes for it,
  when there is one, before it is installed, and only installed when you
  click the update.
- **Your git remote**, for the background `git fetch`.
- **A reachability probe** (DNS lookup + TCP connect, no HTTP request) to the
  API host of a tab whose turn failed with a network error, to know when the
  internet is back.

Claude Code itself talks to Anthropic, and to any API endpoint you add (e.g.
`api.z.ai`), exactly as it would without VibeSpace.
