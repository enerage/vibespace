# Research: phone control of VibeSpace agents ("away mode")

2026-09-29. The question: when Valentin is away from the PC (gym), can he get pushes only then,
and answer questions, approve prompts and continue the SAME local agents from his phone?
Three research passes (official Anthropic, third-party ecosystem, VibeSpace codebase fit)
are appended below. This top section is the synthesis.

## Verdict

**Worth it, and most of it already exists: Claude Code's built-in Remote Control.** Don't
build a phone app. VibeSpace's job is a thin integration layer. The one real risk is
reliability on Windows, so run a hands-on test before writing any code.

## What Remote Control gives us for free (verified in official docs, claude 2.1.284 on this PC)

- Launch any interactive `claude` with `--rc "<name>"` (or set `remoteControlAtStartup: true`
  in user settings). The session keeps running in OUR pty and also appears in the Claude
  phone app's Code tab.
- From the phone you get the live transcript, permission approval, AskUserQuestion answers
  and new prompts. Pushes fire on "action required" and "Claude decided"
  (`agentPushNotifEnabled` is already true in `~/.claude/settings.json`).
- **Away mode is a documented hook:** phone pushes are skipped while the file named by
  `CLAUDE_CLIENT_PRESENCE_FILE` exists (v2.1.181+). VibeSpace creates it while Valentin is
  at the PC and deletes it when he's away.
- The PC only makes outbound HTTPS connections: no open ports, no tunnel, no auth to build.
  After sleep or a network drop it reconnects on its own.

## Limits and risks

- **One remote session per claude process:** about 20 agents means about 20 entries in the
  phone list, so names must be good (`<repo> · <tab>`). Server mode
  (`claude remote-control`, 32 sessions) refuses `--settings`, so it is out.
- **Reliability:** open GitHub issues report phone approvals that never unblock the PC
  (#52084, #59855, #64797). Windows issue #55619 says a prompt ALREADY waiting when you
  leave doesn't show on mobile. There are recent Windows 403 and landing-page bugs
  (2026-09-08, 2026-09-25).
- **The phone can't set Auto/Bypass mode.** Valentin runs bypassPermissions by default, so
  most asks will be questions and "done, what next", not permission prompts. That is fine
  for this use.
- **Privacy:** while Remote Control is connected, the full transcript and tool activity are
  stored on Anthropic servers. Consider per-repo opt-out for client/prod repos.
- **The PC must stay awake**, with processes running. Nothing wakes it remotely.
- **Untested here:** `--rc` combined with our `--settings` hooks and statusLine, and roughly
  20 simultaneous sessions (an undocumented server-side limit is possible).

## Third-party: no better option exists

- Every serious tool (Happy ~24k★, HAPI, Orca ~81k★) **wraps the claude process itself**,
  so none of them can attach to a pty VibeSpace already owns. Happy also reserves
  `--settings`. Orca is a competitor, not a plug-in.
- Transcript readers (claudecodeui, Yep Anywhere) reply by starting a second process on
  the same session, which is unsafe. tmux/SSH/VibeTunnel setups don't work with ConPTY.
  agentapi and CUI are archived, and Omnara pivoted.
- Practitioner pain points: (1) approvals and messages that never arrive, (2) typing and
  reading diffs on a phone (voice input is the #1 request), (3) notification fatigue plus
  a sleeping PC. People keep phone pushes to "waiting" and "done" only.
- If a DIY fallback is ever needed, a **Telegram bot** is the best channel: Approve/Deny
  buttons that work on iOS, free-text replies, no open port, one bot for every tab. ntfy
  is flaky on iOS, and iOS web-app pushes can't show action buttons.

## Plan

1. **Hands-on test (~15 min, no code):** start 2 tabs with `--rc`, lock the PC, then answer
   a question, approve a prompt and send a follow-up from the phone. Check that our lights
   and the feed stay correct, and test the prompt-waiting-before-leaving case. Go/no-go.
2. **VibeSpace integration (~half a day, if the test passes):**
   - a per-tab `--rc "<repo> · <tab>"` in the claude launch line (`terms.js` ~452), with an
     opt-out per workspace;
   - `CLAUDE_CLIENT_PRESENCE_FILE` set per pty in ptyhost (one global file under dataRoot);
   - an "I'm away" toggle in the launcher/board, plus auto-away via Electron `powerMonitor`
     (`lock-screen` / `unlock-screen`, plus idle > N min);
   - on going away, a catch-up for issue #55619: list the agents already waiting (the feed
     knows them) so nothing is missed.
3. **DIY fallback only if Remote Control fails the test (~2–4 sessions):** a Telegram bot
   in a new always-on hub process. PermissionRequest HTTP hooks would be held open until
   the phone answers (reply-as-decision, UNVERIFIED here), and follow-ups would go through
   `ptyhost.write` using bracketed paste. The pieces that exist today are listed in the
   codebase appendix.

---

# Appendix A: codebase fit (Explore agent, read-only)

- Feed per terminal (`main/claudefeed.cjs:73-240`): tool + detail, attention
  (permission/question/input), `lastMessage` (≤2000 chars), sessionId. The question text,
  options and `permission_suggestions` arrive in hook bodies but are dropped by the reducer.
- The server always answers hooks `{}` immediately (`claudefeed.cjs:300-318`), with a 3 s
  hook timeout (:404). Holding a PermissionRequest reply open as the decision is possible
  in principle but untested.
- Board files (`main/board.cjs:25-43`) have no termId, no lastMessage and no question text,
  so they can't drive replies as-is.
- Toast/badge hook point: `notifyAttention()` in `main/index.cjs:218-248`.
- Input path: `ptyhost.write(termId, data)` (`main/ptyhost.cjs:146`). The quick reply is
  xterm `paste()` + `\r` (`terms.js:785-791`), so a main-side sender must add the
  bracketed-paste markers itself. Typing into an open dialog picks the highlighted option,
  which is why quick reply is Done/failed only (`board.js:43-49`).
- Process model: one detached process per workspace, each with its own feed port. The
  launcher is optional. There is no natural home for a single phone server, so DIY would
  need a new hub process.
- No `powerMonitor`/idle use and no phone channel exist yet. The feed server is
  127.0.0.1-only with no auth, so it must never be exposed.
- Claude launch: `claude [--resume id] --settings "<instance>/claude-hook-settings.json"`
  (`terms.js:452-464`). `claude attach` tabs ignore `--settings` (`terms.js:772-775`).


# Appendix B: official Anthropic options (full notes)

# Official Anthropic options for phone control of local Claude Code agents

Research date: 2026-09-29. Local Claude Code version on this PC: **2.1.284** (the latest in the public CHANGELOG as of today).
Target setup: VibeSpace (Electron on Windows) runs about 20 interactive `claude` processes (5 repos x 4 agents) in its own ConPTY terminals. Goal: approve prompts and answer questions from the phone while away, with notifications only when away.

## Verdict

**Remote Control is the official answer, and it already covers nearly all of this for interactive CLI sessions running in any terminal.**

- Set `remoteControlAtStartup: true` in user `~/.claude/settings.json` and every interactive `claude` process auto-registers its own remote session.
- The phone (Claude app, Code tab) sees the live transcript, answers permission prompts and AskUserQuestion, and sends new prompts.
- Push notifications are already configured on this machine: `inputNeededNotifEnabled` and `agentPushNotifEnabled` are both `true` in `~/.claude/settings.json`.
- "Only when away" is supported through `CLAUDE_CLIENT_PRESENCE_FILE`, a marker file. While it exists, pushes are skipped. VibeSpace can create and delete it from Electron `powerMonitor` lock/unlock or idle events.
- The main costs:
  - About 20 separate entries in the phone's session list, one per process.
  - The transcript is stored on Anthropic servers while Remote Control is connected.
  - The PC must stay awake with the processes running.
  - There are some fresh Windows/Pro 403 bug reports.

Channels (Telegram/Discord) are the second-best official path. Dispatch and cloud sessions don't fit this goal.

---

## 1. Remote Control

Primary source: https://code.claude.com/docs/en/remote-control (fetched 2026-09-29). Launched 2026-02-25 as a research preview (VentureBeat, https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote; Techmeme https://www.techmeme.com/260224/p53). The current docs no longer call it a preview.

### VERIFIED (official docs and changelog)

**What it is**
- The phone app or claude.ai/code acts as "a window into that local session". Execution, filesystem, MCP servers, tools and project config stay local.
- "Your computer has to stay on and the `claude` process has to keep running."

**Ways to start it**
- `claude remote-control`: server mode. One process serves many sessions, `--capacity` defaults to 32, and `--spawn same-dir|worktree|session` sets how sessions are created.
- `claude --remote-control` / `--rc [name]`: a normal interactive session that is also remotely controllable. You can still type locally.
- `/remote-control` / `/rc` inside a running session. It carries over the existing conversation history.
- Also available from Claude Desktop and VS Code.

**Enabling it for all sessions**
- `/config` → "Enable Remote Control for all sessions", or `remoteControlAtStartup: true` in user `~/.claude/settings.json` or managed settings.
- Project and local settings can only turn it OFF (changed in v2.1.222).
- "With this setting on, each interactive Claude Code process registers one remote session. If you run multiple instances, each one gets its own remote session."
- Settings reference: https://code.claude.com/docs/en/settings-reference (remoteControlAtStartup, disableRemoteControl, dialogExpiry).

**Sessions per process vs per machine**
- An interactive process has exactly one remote session ("One remote session per interactive process").
- Server mode serves up to 32 sessions per process by default.
- A machine can run many of either.

**Server mode vs VibeSpace:** in server mode, a global flag such as `--settings` placed before `remote-control` makes Claude Code "refuse to start". VibeSpace injects `--settings <instance>/claude-hook-settings.json`, so server mode can't carry VibeSpace's hooks. Server-mode sessions also aren't typed into a local pty. **Use interactive `--rc` / auto-connect, not server mode.**

**What the phone or web can do**
- Send messages "from your terminal, browser, and phone interchangeably". Attach photos and files; files are downloaded locally as `@` references.
- See the conversation live, including subagent and workflow progress and the git diff pane.
- Answer permission prompts and AskUserQuestion. Claude Code "keeps permission prompts and `AskUserQuestion` questions open until you answer them". Other forwarded dialogs expire after 5 minutes (`dialogExpiry`, v2.1.224+).
- Fixes that matter here:
  - v2.1.217: a pending permission prompt is now shown to viewers who connect after it appeared.
  - v2.1.248: fixed prompts sometimes not showing after a silent reconnect.
- Change model and effort, stop background tasks, and fork a session from the app (v2.1.273).
- Run some slash commands: `/compact`, `/clear`, `/context`, `/model x`, `/effort x`, `/config key=value`, `/mcp` and others. Local-only commands such as `/plugin` and `/resume` don't work remotely.

**Permission modes from the app:** Remote Control sessions offer only Manual, Accept edits and Plan. Bypass and Auto can't be selected from the app (https://code.claude.com/docs/en/mobile). This is unverified for a session already in auto or bypass mode locally; presumably the mode it already has keeps running.

**Sleep and network**
- "If your laptop sleeps or your network drops, Claude Code reconnects automatically when your machine comes back online."
- Interactive sessions retry for the whole length of an outage.
- Server mode exits after about 10 minutes offline.
- A presence-heartbeat failure of about 30 minutes means you run `/remote-control` again.
- HTTP 403s are tolerated for up to 3 minutes.
- Closing the terminal marks the session offline within seconds (v2.1.236).
- A sleeping PC means no progress and no pushes until it wakes. Nothing wakes it remotely.

**Plans and auth**
- Pro, Max, Team and Enterprise. On Team and Enterprise an Owner must enable it.
- **API keys are not supported.** It fails if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` is set, even when a claude.ai login also exists (v2.1.139).
- It needs a full-scope `claude auth login`. `setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` tokens are rejected.
- It is unavailable on Bedrock, Vertex or Foundry, or with a non-Anthropic `ANTHROPIC_BASE_URL`.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_GROWTHBOOK` kill it. `DISABLE_TELEMETRY` is fine from v2.1.283.
- Zero Data Retention and HIPAA orgs can't use it.
- This PC's settings: no API-key vars in the env and no nonessential-traffic kill switch found. `remoteControlUpsellSeenCount: 3` in `~/.claude.json` suggests the account is eligible, but that is inferred.

**Windows**
- There is no Windows exclusion anywhere in the docs.
- Changelog v2.1.261: "Fixed Remote Control's inbound event stream failing behind TLS-inspecting corporate proxies on native Windows." Native Windows is therefore a supported target.

**Third-party terminal or pty:** the docs place no terminal requirement on the interactive mode. It is a flag or setting of the `claude` process itself, and connections are outbound HTTPS from that process. Things to watch:
- Server mode's workspace-trust prompt needs a real TTY.
- The one-time "Enable Remote Control?" consent dialog must be accepted once. v2.1.281/284 added a key-debounce on it after focus returns.

**Push notifications** (same page, section "Mobile push notifications")
- They need the Claude app signed into the same account and org, with notifications allowed.
- Two toggles, set with `/config` or in settings:
  - "Push when actions required" = `inputNeededNotifEnabled`: permission prompts and questions.
  - "Push when Claude decides" = `agentPushNotifEnabled`: the PushNotification tool, added in v2.1.110. You can also say "notify me when the tests finish".
- "Beyond the two on/off toggles … there is no per-event configuration."
- Pushes are sent only while Remote Control is active for that session.
- Pushes are skipped automatically while you type in or focus the connected terminal. Whether that focus detection works in an Electron-hosted ConPTY rather than a real console window is unverified.
- **Conditional "only when away":** `CLAUDE_CLIENT_PRESENCE_FILE=<path>`. While the file exists, pushes are skipped. It is checked once per push-triggering event, not polled. Requires v2.1.181+ (https://code.claude.com/docs/en/env-vars). The docs suggest a screen-lock listener that creates the file on unlock and deletes it on lock.
- Troubleshooting: "No mobile registered" in `/config` means you should open the app. iOS Focus and notification summaries can suppress pushes, and Android battery optimization can delay them.

**Security** ("Connection and security" section)
- Outbound HTTPS only, with no inbound ports. It registers with the Anthropic API and polls, and messages are routed through Anthropic servers over TLS with multiple short-lived single-purpose credentials.
- "While Remote Control is connected, the session transcript, including your messages, Claude's responses, and tool activity, is stored on Anthropic servers". Data-usage policy retention applies.
- Auto-connect uses your own account, so sessions appear only in your apps.
- Optional **Trusted Devices** (beta, Pro and Max can self-enable): device enrollment plus a sign-in no older than 18 h, with biometric step-up.
- `disableRemoteControl` switches it off entirely.

**Session identity:** names come from `--rc "name"`, then `/rename`, then the last message, then `hostname-random`. The prefix is set with `--remote-control-session-name-prefix` or `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX`. VibeSpace could pass `--rc "<repo> · <agent>"` to get readable phone lists.

**Resume:** a session started with `--rc` or `/rc` is brought back with `claude --resume` / `--continue`, which reattaches. If two terminals resume the same conversation, the second prints "Remote Control not started here".

### Known issues and recent status (flag: may change)

- **#92760** (OPEN, 2026-09-08): Windows, Pro plan, Desktop bundled 2.1.260. `/remote-control` fails with HTTP 403 "server rejected the request"; this appeared after Remote Control opened to Pro. https://github.com/anthropics/claude-code/issues/92760
- **#97226** (OPEN, 2026-09-25): claude.ai/code in a browser redirects to GitHub onboarding, so Remote Control sessions can't be reached without the session URL. It is a web issue; the mobile Code tab list is reported separately in the docs. https://github.com/anthropics/claude-code/issues/97226
- **#72149** (closed 2026-07-02): `/remote-control` disappeared on Windows CLI 2.1.126. It was a transient entitlement issue. https://github.com/anthropics/claude-code/issues/72149
- **#48949** (OPEN): the Desktop app ignored `remoteControlAtStartup`. This does not affect the CLI, and the docs now list a Desktop toggle. https://github.com/anthropics/claude-code/issues/48949
- **#69878**: phone messages took more than 30 s to arrive (slow relay). https://github.com/anthropics/claude-code/issues/69878
- Around 150 Remote Control fixes are in the changelog from v2.1.81 to v2.1.284, including stale permission prompts, stuck spinners and stale modes. The feature is actively maintained but still moves quickly.

### UNVERIFIED / inferred

- Whether ~20 concurrent auto-connected sessions per account hit any server-side limit. None is documented; server mode's default capacity of 32 suggests dozens are expected.
- Whether `--rc` combined with VibeSpace's `--settings` works in interactive mode. The server-mode restriction is documented only for `claude remote-control`; interactive is expected to be fine but was not tested, to avoid registering a live session without consent.
- Whether terminal-focus push suppression detects focus inside an Electron/xterm pty. Treat it as not reliable and use the presence file instead.
- Interaction with VibeSpace's own Notification hooks: the hooks keep firing locally. The push and hook paths are independent.

---

## 2. Claude mobile app (iOS/Android), Code tab

Source: https://code.claude.com/docs/en/mobile

- VERIFIED: the app is a client only. Its Code tab lists cloud sessions and Remote Control sessions. "Remote Control sessions show a computer icon with a green status dot when online."
- You can connect by QR code (`/remote-control` shows one), by session URL, or by picking the session by name. `/mobile` shows the app-store QR.
- Push notifications: see section 1. They only work with Remote Control active (or Dispatch). There is no per-event or per-session configuration beyond the two toggles and the presence file.
- The app can't start a brand-new local session on the PC by itself, except in three cases:
  - Server mode (the app can create sessions on a running `claude remote-control`).
  - A Projects thread "on your computer", which uses Remote Control.
  - Dispatch.
- Forking an `--rc` session from the app creates a background session on the PC (v2.1.273).

---

## 3. Cloud sessions (Claude Code on the web), `--cloud` / `--remote`, teleport

Source: https://code.claude.com/docs/en/claude-code-on-the-web

- VERIFIED: sessions run in an isolated Anthropic-managed VM, or on self-hosted runners for Team and Enterprise. The repo is cloned from GitHub at the pushed branch, or uploaded as a git bundle (under 100 MB; untracked files are excluded).
- **No access to the PC's local env, DBs, local MCP servers or unpushed work.** Network is allowlisted; secrets go into the environment config.
- `claude --cloud "task"` starts a new cloud session. `--remote` is a deprecated alias. The CLI cannot push an existing terminal session to the cloud; Desktop's "Continue in" menu can.
- `claude --teleport` / `/teleport` pulls a cloud session into the local terminal. It needs a clean git tree, the same repo and the same account. "To keep steering from your phone after teleporting, start `/remote-control`."
- `claude -p "msg" --cloud <session-id>` queues a follow-up from any CLI.
- Plans: Pro, Max and Team, plus Enterprise with premium seats. It shares your rate limits and needs claude.ai auth.
- Fit: poor for this user. The agents rely on local repos, DBs (several pg MCPs), local MCP servers and Windows tooling. Cloud sessions keep running with the PC off, but that is a different workflow.
- Related: **Projects** (public beta, Pro and Max, gradual rollout) coordinate cloud threads and can "run a thread on your own computer" through Remote Control. https://code.claude.com/docs/en/claude-projects

---

## 4. Channels (Telegram / Discord / iMessage / fakechat)

Sources: https://code.claude.com/docs/en/channels, https://code.claude.com/docs/en/channels-reference

**VERIFIED**
- **Research preview.** Added in v2.1.80, with permission relay in v2.1.81.
- A channel is an MCP-server plugin (Bun) that pushes messages into an **already-running local session**, started with `claude --channels plugin:telegram@claude-plugins-official`.
- It is two-way: Claude replies through a `reply` tool. The reply appears in Telegram, not the terminal.
- Only allowlisted plugins run (claude-plugins-official). A custom channel needs `--dangerously-load-development-channels`, which shows a confirmation dialog.
- iMessage is macOS-only. **Telegram and Discord work from Windows.**
- **Permission relay:** a channel that declares `claude/channel/permission` gets Bash, Write and Edit approval prompts with a 5-letter ID. You reply "yes abcde" or "no abcde", and the first answer wins between terminal and phone.
  - Project-trust and MCP-consent dialogs are not relayed.
  - Inputs are sanitized, and credentials are masked from v2.1.234.
  - The docs don't state whether the official Telegram and Discord plugins declare relay; check the plugin source.
- **AskUserQuestion:** v2.1.83 disabled AskUserQuestion and plan tools whenever `--channels` was active. v2.1.126 restored plan-mode tools in interactive sessions. Current docs say only that in `-p` mode, "multiple-choice questions and plan mode approval" are disabled.
  - Flag: whether AskUserQuestion works in interactive `--channels` sessions today is **unverified**, and it is not relayed to the chat in either case.
- **Security:**
  - Sender allowlist via pairing code; anyone allowlisted can approve tools.
  - Chat content passes through Telegram or Discord servers, and bot tokens are stored in `~/.claude/channels/<name>/.env`.
  - Claude.ai or Console API-key auth both work. Channels are on by default for Pro and Max; Team and Enterprise need `channelsEnabled`.
- Events queue into the session and are processed in order. "To process independent event streams concurrently, run separate sessions."

**Inferred fit**
- One bot per session is awkward for 20 agents: each session runs its own plugin poller on the same bot token, and Telegram's getUpdates doesn't allow two pollers on one token.
- Pushes are chat messages, with no presence gating.
- A custom VibeSpace-built channel (one bridge that multiplexes all tabs) is possible, but only via the dev flag during the preview.

---

## 5. Dispatch / Cowork and other official features

Sources: https://support.claude.com/en/articles/13947068, https://code.claude.com/docs/en/desktop#sessions-from-dispatch

- VERIFIED: Dispatch is one persistent conversation in the Desktop app's Cowork tab, paired with the mobile app. From your phone you message a task and Dispatch decides whether to spawn a **Desktop Code session** or run Cowork.
- You get pushes when a task finishes or needs approval.
- Requirements: Pro or Max only, the Desktop app open and the PC awake. It runs on Windows x64, macOS and Linux.
- Only a single thread.
- **Flag, recent status:** the support article says Dispatch is in "limited beta for Pro and Max plans and isn't available to new users" (existing users continue).
- Fit: none for VibeSpace. It drives Desktop-app sessions, not the CLI processes in VibeSpace ptys, and can't attach to existing terminal sessions.
- Other related features:
  - **Cross-session messaging.** `ListAgents` and `SendMessage` reach Remote Control sessions on other machines, and messages ride the Remote Control connection. https://code.claude.com/docs/en/cross-session-messaging
  - **Trusted Devices.** See section 1.
  - **Slack / Claude Tag.** Cloud-only.
  - **Self-hosted runners.** Team and Enterprise only.
  - **Scheduled tasks and routines.**
  - None of these solves "approve from the phone" better than Remote Control.

---

## 6. Security model summary

| Option | Where code runs | What leaves the PC | Auth |
|---|---|---|---|
| Remote Control | Local PC | Full transcript + tool activity stored on Anthropic servers while connected; attachments down to PC | claude.ai subscription login (no API key); optional Trusted Devices |
| Mobile push | n/a | Push payload via Anthropic → APNs/FCM | same account in app |
| Cloud sessions | Anthropic VM (or self-hosted runner) | Repo clone/bundle, env config, secrets you add | claude.ai; GitHub App or `/web-setup` gh token |
| Channels | Local PC | Messages + relayed tool previews via Telegram/Discord servers | bot token local; sender allowlist/pairing |
| Dispatch | Local PC (Desktop app) | Conversation via Anthropic; computer-use risk warnings | Pro/Max, paired devices |

## 7. Practical implication for VibeSpace (inferred, not tested)

1. Put `remoteControlAtStartup: true` in user settings, or add `--rc "<repo> · <tab name>"` to VibeSpace's claude launch args so phone entries are readable.
2. Set `CLAUDE_CLIENT_PRESENCE_FILE` in the per-pty env through ptyhost. The launcher or main process creates the file on `powerMonitor` `unlock-screen` or activity and deletes it on `lock-screen` or when `getSystemIdleTime()` passes a threshold.
3. Keep the PC from sleeping while away (`powerSaveBlocker`), otherwise no progress and no pushes.
4. Expect about 20 phone list entries. Mitigate by closing idle tabs, or by making Remote Control opt-in per tab with `/rc` sent into the pty.

# Appendix C: third-party ecosystem (full notes)

# Phone control of Claude Code: third-party landscape, sentiment, and DIY building blocks

Research date: 2026-09-29. Scope: a Windows Electron app (VibeSpace) that already owns ~20 interactive `claude` ConPTY sessions (5 repos x ~4 agents) and has command hooks plus a local HTTP hook/statusLine feed. Goal: when Valentin is away (gym), push only then, and let him approve permissions, answer questions and send follow-ups to the same local sessions.

GitHub stats pulled live with `gh api` on 2026-09-29 (stars / last push).

---

## 0. Verdict (read this first)

1. **The first-party option now covers most of the requirement and is the only one that attaches to a session VibeSpace already owns.** Claude Code's built-in **Remote Control** runs *inside* the `claude` process. VibeSpace can keep its pty and just launch each tab with `claude --remote-control "<repo>/<tab>"`, or set `remoteControlAtStartup: true`. The phone surface is the official Claude iOS/Android app (Code tab) or claude.ai/code. It includes permission approval, AskUserQuestion answers, follow-ups, diffs and push. `CLAUDE_CLIENT_PRESENCE_FILE` is the "away mode" hook: pushes are suppressed while the file exists. The catch is reliability. Many open GitHub issues report phone approvals that never unblock the host, including one filed from Windows 11. Details in section 1.
2. **Nearly every third-party tool wants to own the claude process.** Happy, HAPI, Orca, VibeTunnel, agentapi and Claude-Code-Remote all wrap or spawn `claude`, or drive it via the Agent SDK. claudecodeui/CloudCLI and Yep Anywhere discover sessions from the transcripts but *run* turns through the Agent SDK in a separate process. None of them can drive a pty that VibeSpace already owns. The only parts that coexist cleanly are hook-based ones, such as ntfy/Telegram approvers built on the `PermissionRequest` / `Notification` / `Stop` hooks.
3. **Strongest third-party tools:** **Happy** (24k stars, E2E encrypted, free, self-hostable relay, native apps; wrapper plus Agent SDK "remote mode", Windows "experimental"). **Orca** (81k stars, Windows desktop plus mobile companion; a full competing ADE, so it replaces VibeSpace rather than plugging in). **Yep Anywhere** (small but mobile-first, E2E relay, reads existing CLI sessions, Windows installer). **HAPI** (5k stars, "local-first Happy", Telegram Mini App/PWA/native, WireGuard+TLS relay) is also worth knowing.
4. **For a DIY channel on top of VibeSpace's own hooks, the most practical choice is a Telegram bot, or ntfy as the simplest option.** Telegram gives free, reliable APNs/FCM delivery, inline buttons that work on iOS (Approve/Deny/option picks), free-text replies for follow-ups and answers, and long-polling with no inbound port. ntfy is the quickest to wire up, but action buttons on iOS are shaky and iOS self-hosting needs the ntfy.sh upstream. An iOS PWA with Web Push is the weakest for approvals: iOS ignores notification action buttons entirely and needs a Home-Screen install.

---

## 1. First-party baseline (not third-party, but it reframes everything)

### 1a. Claude Code Remote Control
Docs: https://code.claude.com/docs/en/remote-control. It launched 2026-02-24 as a Max research preview: https://www.reddit.com/r/ClaudeCode/comments/1rdr7ga/claude_code_just_got_remote_control/. Device cards and reliability upgrades followed on 2026-08-21/22: https://www.explainx.ai/blog/claude-code-mobile-remote-control-phone-guide-2026.

- **How it attaches:** it is inside the `claude` process itself. The process makes outbound HTTPS only, registers with the Anthropic API and polls. Messages route through Anthropic over TLS using short-lived, scoped credentials. It opens no inbound ports and needs no Tailscale.
- **Ways to turn it on:**
  - `claude --remote-control "Name"` (alias `--rc`): a normal interactive TUI that is *also* remotely controllable, so the local terminal keeps working.
  - `/remote-control` inside an existing session: carries the existing history over.
  - `claude remote-control`: server mode, with multiple sessions per process, `--spawn same-dir|worktree|session` and `--capacity` (default 32). Server mode has no local TUI input.
  - `remoteControlAtStartup: true` in user `~/.claude/settings.json`: auto-connects every interactive session. A project-level `true` is ignored, and a project-level `false` is honored.
- **One remote session per interactive process.** That fits VibeSpace exactly: one pty = one claude = one remote session.
- **What the phone can do:** send prompts, approve or deny permissions, answer AskUserQuestion, attach photos and files, view a git diff pane, change model and effort, and stop subagents. Local-only commands such as `/plugin` and `/resume` don't work from the phone. After a local `/resume` switch, the phone does not get the history of the switched-to conversation.
- **Push notifications:** two toggles in `/config`: "Push when actions required" (permission prompts and questions) and "Push when Claude decides" (the model decides, typically when a long task finishes). There is no per-event config beyond that. Pushes are skipped while you are typing in or focused on the connected terminal.
  - **`CLAUDE_CLIENT_PRESENCE_FILE`** (v2.1.181+) sets a marker file, and no push goes out while it exists. Anthropic's docs explicitly suggest driving it from a screen-lock listener. This is the built-in "away mode" hook, and VibeSpace could own that file from Electron `powerMonitor` (see section 5).
- **Limits:**
  - Requires claude.ai subscription auth (Pro/Max/Team/Ent). API keys are not supported, and ZDR orgs can't use it.
  - The process must stay alive, so a sleeping PC means an offline session. It reconnects when the machine wakes.
  - Interactive sessions retry through outages. Server mode exits after about 10 minutes offline.
  - The error "could not reach the Remote Control server for about 30 minutes" requires a manual `/remote-control` to recover.
  - Forwarded non-permission dialogs expire after 5 minutes (`dialogExpiry`).
  - Team/Ent sign-in must be refreshed within 18 hours (biometric step-up).
- **Windows:** works. Issue #55619 was filed from Windows 11 PowerShell. One early Reddit commenter said "doesn't work for Windows + iPhone", which was a rollout-era complaint.
- **Reliability (the big risk)**, a cluster of open or duplicate issues:
  - #45942: Android permission approval / "always allow" breaks tool calls.
  - #52084 (https://github.com/anthropics/claude-code/issues/52084): approving from the phone hangs the host.
  - #55619 (https://github.com/anthropics/claude-code/issues/55619): the mobile session is locked out when the desktop already has an unanswered permission prompt. The prompt is invisible on mobile and queued messages never deliver. **Windows 11.**
  - #59855 (https://github.com/anthropics/claude-code/issues/59855): Android approvals do not unblock the local TUI, still reproducing on 2.1.143/2.1.159 and also from Claude Desktop.
  - #64797 (https://github.com/anthropics/claude-code/issues/64797): the Android WebSocket goes stale after idle, and approvals or messages sit in "pending delivery" for 5 to 30 minutes. Workarounds: airplane-mode toggle, or back out and re-enter the session.
  - #28508: mobile AskUserQuestion selections not received. #51267 / #50463: silent hangs recovered only by a local Esc.
  - HN launch thread (https://news.ycombinator.com/item?id=47148454): "extremely clunky and buggy prerelease", with stop not interrupting, intermittent disconnects, one session at a time, and the Android app demanding a GitHub connection to list sessions.
  - Later HN comment (https://news.ycombinator.com/item?id=48621188): "Connections drop so fast and flakily... every time I've been sorely disappointed."
- **Pricing:** included in Pro/Max.

### 1b. Claude Code Channels (Telegram / Discord / iMessage plugins)
Docs: https://code.claude.com/docs/en/channels. It is a research preview.
- A channel is an MCP server (Bun) loaded into the running session with `claude --channels plugin:telegram@claude-plugins-official`, and the flag must be given at launch. Messages go into *that* session. Channels that declare the capability can also relay permission prompts (plugin v0.0.2+, CC v2.1.81+). Access is gated by a sender allowlist that you set up by pairing.
- **Fit for VibeSpace:** it is in-process like Remote Control, so it coexists with an owned pty. But one Telegram bot token can only be long-polled by one consumer, so 20 sessions would need 20 bots or a custom multiplexing channel. Bug #40064 reports permission relay not working with dev channels. Replies show only as a tool call in the TUI.
- Practitioner report: Ultra Lab ran a self-built Telegram bridge on Windows for months (a 200-line toolkit patching OS gaps), then retired it for Remote Control. Notably, their bridge "could not" approve permissions; they had to pre-widen them. https://ultralab.tw/en/blog/claude-code-remote-control-mobile-2026

### 1c. Other first-party pieces
- **Dispatch / Cowork** (Claude Desktop): phone-to-desktop task dispatch that spawns a Desktop session, not your existing pty.
- **`/teleport`** and cloud sessions: move work to the cloud. That is a different machine and a different environment.

---

## 2. Third-party tools

Legend for **Attach**:
- **WRAP**: you launch the tool instead of `claude`, and it spawns claude in its own pty.
- **SDK**: it drives turns through `@anthropic-ai/claude-agent-sdk` or headless `claude -p` / `--resume`.
- **TRANSCRIPT**: it reads `~/.claude/projects/**.jsonl`.
- **TMUX-INJECT**: it sends keys into a tmux pane.
- **HOOK**: it uses Claude Code hooks.
- **SSH**: a terminal to the machine.

**Coexist?** means: could it drive sessions whose pty VibeSpace already owns?

| Tool | Stars / last push | Attach | Windows | Coexist with VibeSpace-owned pty? | Security model | Price |
|---|---|---|---|---|---|---|
| **Happy** (slopus/happy) | 23,944 / 2026-09-28 | WRAP (local mode: pty, plus a file watcher on session JSONL and a SessionStart hook) and SDK (remote mode). Switching modes restarts claude with `--resume`. | "Experimental" | No. It must be the launcher, and it reserves `--settings`, which clashes with VibeSpace's own `--settings` hook file. | E2E: master secret on the phone, per-session AES-256 DEKs, TweetNaCl auth, QR pairing. The relay (~1.3k LOC) sees ciphertext only and is self-hostable. Pseudonymous analytics. | Free, MIT |
| **HAPI** (tiann/hapi) | 5,137 / 2026-09-27 | WRAP ("wraps your agent instead of replacing it"), local hub | Via Bun single-exe; not verified | No (wrapper) | Hub on your machine. Optional relay "WireGuard + TLS E2E", or self-host behind Cloudflare Tunnel or Tailscale. Native iOS/Android, PWA, Telegram Mini App. | Free, AGPL-3.0 |
| **Orca** (stablyai/orca) | 81,231 / 2026-09-29 | Its own ADE: spawns agents in its own terminals and worktrees. Mobile companion pairs with the desktop app. | Yes (Windows .exe) | No. It is a direct VibeSpace competitor (file tree, terminals, agents, notifications, mobile). | Pairing with the desktop app; details not reviewed | Free, MIT (YC-backed) |
| **CloudCLI / claudecodeui** (siteboon) | 13,851 / 2026-09-28 | TRANSCRIPT (auto-discovers all existing sessions), SDK (claude-agent-sdk runtime) for chat, plus a node-pty "shell" tab | Node server plus Windows tray app | Partial. It can *read* VibeSpace sessions and resume them, but a resume runs in a separate SDK process, which risks two writers on one session. | A plain web server on `[ip]:3001` with app login. No E2E, so it needs Tailscale. There is also a hosted CloudCLI Cloud. | Free (AGPL); Cloud paid |
| **Yep Anywhere** (kzahel/yepanywhere) | 531 / 2026-09-29 | TRANSCRIPT ("uses your existing CLI session history") plus its own server-driven sessions | Signed Windows installer (beta) | Partial, same caveat as CloudCLI | Direct connection or E2E public relay; no accounts, no DB | Free, MIT |
| **VibeTunnel** (amantus-ai) | 4,675 / 2026-08-05 | WRAP (`vt claude` forwards a pty to the browser) | **Not supported** (issue #252) | No | Local server; you bring Tailscale/ngrok; optional auth | Free, MIT |
| **Claude-Code-Remote** (JessyTsui) | 1,286 / 2025-12-06 (stale) | HOOK (notify) plus TMUX-INJECT or its own PTY to send replies; email/Telegram/LINE | Effectively no (tmux) | No | ID whitelist; 24 h tokens | Free, MIT |
| **coder/agentapi** | 1,500 / 2026-09-13, **archived and deprecated** | WRAP: in-memory terminal emulator, HTTP `/message` `/status` `/events` | Binaries only (linux/darwin in quickstart) | No | Localhost Host-header allowlist | Free, MIT, dead |
| **CUI** (BMPixel → wbopan/cui) | 1,142 / 2026-03-20, **archived** | SDK | n/a | n/a | n/a | Archived. The README points users to Remote Control. |
| **Omnara** (omnara-ai) | 2,877 / 2026-09-29 | *Was* a WRAP/SDK mobile remote for Claude Code and Codex, $9/mo per user in 2025. **Pivoted in 2026** to "open-source alternative to Claude Managed Agents". The old product is kept only as "historical reference", though the iOS app still lists Claude Code control (v2.0.5, Apr). | Daemon: Linux/macOS, "Windows coming soon" | No | Cloud control plane | Pay-as-you-go |
| **claude-code-telegram** (overwirehq) | 2,796 / 2026-09-22 | SDK: the bot runs its *own* Claude sessions | Python | No. These are separate sessions, not your ptys. | Telegram user allowlist | Free |
| **Codeman** (Ark0N) | 780 / 2026-09-28 | Self-hosted dashboard that runs agents 24/7 (tmux-based) | Unclear | No | Self-hosted | Free, MIT |
| **PUNK** (punkcode.rocks, Show HN) | n/a (TestFlight, ~50 users) | Local daemon. Lock-screen approvals via iOS Live Activities; a cross-session "pending permissions" sheet. | macOS-centric | No | n/a | n/a |
| **claude-remote-approver** (yuuichieguchi) | 74 / 2026-03-02 | HOOK: `PermissionRequest` → ntfy topic with Approve / Always / Deny buttons → SSE response topic → `{"behavior":"allow"}`. AskUserQuestion options become buttons (max 3 per notification). Falls back to the CLI prompt; auto-deny after 120 s. | Node, so yes | **Yes.** It's just a hook. | 128-bit random topic on public ntfy.sh (anyone with the topic can approve), or self-host | Free |
| **claude-code-ntfy / agent-notifications / ClaudeNotify / berk-karaal plugin** | 777genius/agent-notifications 814 / 2026-09-27 (Windows supported); others small | HOOK (or a thin WRAP for joshsymonds) | Several work on Windows | Yes (notify-only) | Topic secrecy | Free |
| **Termius / Blink + tmux + Tailscale (+ mosh)** | n/a | SSH into a tmux pane where claude runs | The Windows host needs OpenSSH plus a tmux substitute (WSL). ConPTY sessions owned by VibeSpace are not attachable. | No (VibeSpace ptys are not tmux panes) | WireGuard mesh; no public ports | Tailscale Personal is free (6 users, unlimited devices). Termius has a free tier and a paid Pro; Blink is a paid subscription (prices not re-verified) |

Sources:
- Happy: https://github.com/slopus/happy · https://happy.engineering/docs/security/ · https://happy.engineering/docs/faq/ · https://happy.engineering/docs/guides/self-hosting/ · architecture: https://mintlify.wiki/slopus/happy/guides/session-management · mode-switch bug #932 (a new session is created and the conversation lost; Windows twin #496, fixed via #974): https://github.com/slopus/happy/issues/932
- HAPI: https://github.com/tiann/hapi
- Orca: https://github.com/stablyai/orca
- CloudCLI: https://github.com/siteboon/claudecodeui (package.json deps: `@anthropic-ai/claude-agent-sdk`, `node-pty`)
- Yep Anywhere: https://github.com/kzahel/yepanywhere
- VibeTunnel: https://github.com/amantus-ai/vibetunnel
- Claude-Code-Remote: https://github.com/JessyTsui/Claude-Code-Remote
- agentapi: https://github.com/coder/agentapi (README: "deprecated and no longer maintained")
- CUI: https://github.com/wbopan/cui
- Omnara: https://github.com/omnara-ai/omnara · https://www.omnara.com/blog/mobile-coding-landscape · https://www.ycombinator.com/launches/T9k-omnara-the-api-for-production-ready-agents
- PUNK: https://news.ycombinator.com/item?id=47414328
- claude-remote-approver: https://github.com/yuuichieguchi/claude-remote-approver · HN https://news.ycombinator.com/item?id=47111171
- claude-code-ntfy: https://github.com/joshsymonds/claude-code-ntfy
- ClaudeNotify (Windows, ntfy quota note): https://github.com/bojnesh/ClaudeNotify

### Key architectural takeaway for VibeSpace
- **Remote Control and Channels live inside claude.** Zero conflict with VibeSpace owning the pty; you only add a launch flag or a settings key.
- **Hooks are VibeSpace's existing lever.** It already injects `--settings` with command and HTTP hooks. A `PermissionRequest` hook can *block and return a decision*, which is how claude-remote-approver works. That means VibeSpace's local HTTP feed could hold the hook request open until the phone answers.
  - Caveat: if the phone never answers, the hook must time out and return `ask` so the TUI prompt still appears.
- **Follow-up text** can be injected by VibeSpace itself: it owns the pty, so it can write to stdin.
  - Only do this when the tab is idle. The board.js note applies: "text + Enter" inside a dialog picks the highlighted option.
- **Wrappers (Happy/HAPI/VibeTunnel/agentapi) would require VibeSpace to spawn `happy` instead of `claude`.** That breaks VibeSpace's `--settings` injection, and Happy reserves `--settings`. It also doubles the session-tracking logic.

---

## 3. Practitioner sentiment

Sources:
- r/ClaudeCode "Claude Code just got Remote Control" thread (Feb 2026, 1,300 lines): https://www.reddit.com/r/ClaudeCode/comments/1rdr7ga/
- "You don't need Telegram bots…" (server mode as a launchd service): https://www.reddit.com/r/ClaudeCode/comments/1ruyhyl/
- HN threads listed above
- Omnara landscape post
- wmedia.es guide: https://wmedia.es/en/tips/claude-code-notifications-on-your-phone

**Do people find it useful?** Yes, but mostly for *unblocking* rather than *driving*. Most-cited wins:
- "Start a long session before bed… have to stay awake just to approve the next permission request". Remote approval lets you step away.
- Long 45-minute test runs where you check whether it got stuck.
- Plan-mode Q&A while walking.
- Dictating an idea on a walk and checking back 15 minutes later.
- PUNK author: "get a permission request on my lock screen. One tap."

**Skeptics:**
- "The Venn diagram of people who are controlling their agents from a phone and people who read diffs before committing is just two circles."
- "If you are tapping away at Claude with a tiny keyboard… you aren't seeing the sun."
- "Remote Control is the steering layer, not the availability layer": you still need the machine awake, reachable and the session alive.

**Top pain points (ranked by frequency):**
1. **Reliability and state desync.** Approvals that don't reach the host, stale WebSockets, invisible pending prompts, "Happy stopped working for me", "Happy… getting buggier", sessions that stop and need a "continue" kick while you're away. This is the #1 complaint for both first-party and third-party tools.
2. **Phone input and reading UX.** "Using a terminal on a phone keyboard is not a great UX"; "typing and scrolling experience on the iOS app has been horrible" (Termius); raw XML instead of buttons. Voice input is the top-requested fix (Happy, HAPI, PUNK and Omnara all ship voice). Reading diffs on a phone is widely considered impractical.
3. **Setup, security and availability.** Exposing SSH or a web shell, and needing Tailscale. The PC sleeps and the session dies or goes offline. Account and GitHub-connection quirks. Separating work and personal logins. The official Android app initially demanded a GitHub OAuth scope.
4. **Notification fatigue / quota.** The official push only fires when you are not focused on the terminal, and `CLAUDE_CLIENT_PRESENCE_FILE` extends that. ClaudeNotify limits phone pushes to Waiting/Done because PreToolUse fires on every tool and ntfy.sh has a daily per-IP quota. The wmedia.es advice: "if [the permissions push] fires too often… your permissions are [the problem]", so tighten allowlists or use auto mode rather than muting.
5. **Multi-session triage.** With many agents, people want one inbox of "pending permissions grouped by session" (PUNK, Yep Anywhere "one inbox", Codeman "mission control"). This maps directly to VibeSpace's Agent board "Needs you" column.

**Away-mode / presence patterns seen in the wild:**
- Official: pushes are suppressed while focused on or typing in the terminal. `CLAUDE_CLIENT_PRESENCE_FILE` is created on unlock and deleted on lock.
- joshsymonds/claude-code-ntfy: a backstop timer sends ONE notification after 30 s of inactivity once output stops, and cancels permanently if you start typing.
- Naveenxyz/claude-code-notifier: notifies only when the terminal app is not focused (macOS AppleScript focus check).
- Claude Code's own `Notification` hook fires on permission requests and when the prompt has been idle for 60 s or more.
- Common DIY rule: phone only on Waiting/Done/Error; desktop toast/sound when present.

---

## 4. DIY notification and reply channel comparison (for "push only when away, act from phone")

| Channel | iOS delivery | Action buttons on iOS | Free-text reply | Inbound port needed | Cost | Notes |
|---|---|---|---|---|---|---|
| **Telegram bot** | Native Telegram push (reliable) | **Yes**: inline keyboards with callback_query (Approve / Deny / option N) | **Yes**: plain messages, or reply-to a specific notification message to target a tab | No (long-poll `getUpdates` from the PC) | Free | One bot can multiplex all 20 tabs if VibeSpace owns the bot, keying on message ids. Messages go through Telegram's servers and are not E2E (bot chats never are). Restrict to your chat id. |
| **ntfy** (app or ntfy.sh) | App uses FCM/APNs. Known iOS flakiness: messages only on pull-to-refresh, fixed by reinstall (#1305, #880). A self-hosted server needs `upstream-base-url: https://ntfy.sh` for iOS instant push. | `http`/`view` actions exist. iOS app support for http actions is reported working but fragile (#1332, cert issues). | No real reply; you'd need a web page | No for publishing. Replies need the PC to subscribe (SSE) to a response topic. | Free (ntfy.sh quota); ntfy Pro paid | Simplest to wire. claude-remote-approver proves the approve/deny loop. Topic = shared secret; no E2E by default. |
| **Web Push to a PWA** (VibeSpace-served) | iOS 16.4+, **only after Add to Home Screen**. Permission must come from a user gesture. No silent push. Reported unsubscribe/reliability rough edges. | **No**: WebKit ignores `actions`, so every tap just opens the PWA | Yes, inside the PWA UI | The phone needs to reach the PC's web UI (Tailscale Serve gives HTTPS at `*.ts.net`). Push itself goes via Apple's push service, no inbound port. | Free (VAPID) | Best *UI* (a rich approval screen, per-tab list, diff glance), but it is 2 taps minimum on iOS and needs a PC-hosted web app plus a tunnel. Android supports actions. |
| **Pushover** | Very reliable, priority and emergency levels | No custom actions (a supplementary URL only) | No | No | One-time fee per platform (roughly $5; verify) | Good alert-only channel. |
| **Official Claude app push** (via Remote Control) | Reliable delivery, but the model decides for "Claude decides" | Permission and question dialogs in-app | Yes | No | Included | Approval delivery bugs, see section 1a. |

Sources:
- iOS Web Push: https://openpwa.net/reference/notifications/ios-safari-push/ · https://www.web-push-notifications.com/core-protocols-browser-implementation/safari-ios-web-push-integration/ (a table confirming `actions` are ignored on iOS) · https://stackoverflow.com/questions/79548556 · reliability caveats: https://derkonline.com/blog/pwa-that-feels-native-on-ios
- ntfy: https://docs.ntfy.sh/known-issues/ · https://github.com/binwiederhier/ntfy/issues/1305 · https://github.com/binwiederhier/ntfy/issues/880 · https://github.com/binwiederhier/ntfy/issues/1332 (ntfy: 34.5k stars, active)
- Tailscale Personal plan (free, 6 users, unlimited user devices): https://tailscale.com/pricing · Tailscale Serve (tailnet-only HTTPS with auto Let's Encrypt cert; Funnel = public): https://tailscale.com/docs/features/tailscale-serve

**Recommendation for a DIY channel:**
- **Telegram bot** as the away channel. It gives real inline buttons on iOS, free-text follow-ups and answers, no port-forwarding, no Tailscale, and one bot for all tabs.
- **ntfy** if you want alert-only with near-zero code, or approve/deny from Android.
- **PWA plus Tailscale Serve** only when you want a real multi-tab dashboard on the phone. That is a bigger build, and iOS still can't approve from the notification itself.

---

## 5. Presence / idle detection on Windows (for "push only when away")

- **Electron `powerMonitor`** (https://www.electronjs.org/docs/latest/api/power-monitor):
  - `getSystemIdleTime()` (seconds) and `getSystemIdleState(threshold)` → `active|idle|locked|unknown` work on Windows.
  - The `lock-screen` / `unlock-screen` and `suspend` / `resume` events fire on Windows.
  - `user-did-become-active` / `user-did-resign-active` are macOS-only.
- A sensible away rule is "locked OR idle > N min (e.g. 5–10)". On return, flip back immediately on `unlock-screen` or when idle drops below the threshold.
- **Tie-in with the official push:** VibeSpace main can create and delete the file named by `CLAUDE_CLIENT_PRESENCE_FILE`, set per pty through ptyhost env. That gives the Claude app's push the same away semantics as VibeSpace's own channel.
- **Sleep:** Remote Control reconnects after wake, but nothing runs while the PC sleeps. For gym sessions the PC must stay awake. Options are Windows power plan "never sleep while plugged in", or `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` / Electron `powerSaveBlocker.start('prevent-app-suspension')` while any agent is working or waiting. Practitioners flag "PC asleep" as a top failure mode.
- Remote-control software note: VibeSpace users run UltraViewer. The idle timer resets on remote-desktop input too, which is fine.

---

## 6. Implications / options for VibeSpace (input for the orchestrator's decision)

1. **Cheapest path:** add an opt-in "Remote Control" toggle that launches claude tabs with `--remote-control "<ws>/<tab name>"`, owns `CLAUDE_CLIENT_PRESENCE_FILE` from `powerMonitor`, and keeps the PC awake while away with agents busy.
   - Zero phone code; approvals and follow-ups go through the official app.
   - Risk: the documented approval-desync bugs, plus Windows issue #55619, where a prompt that was already pending before you left is invisible on mobile.
   - Also needs claude.ai subscription auth, which Valentin has, and the per-user `/config` push toggles turned on.
2. **DIY hook path:** VibeSpace's feed already receives HTTP hooks with the tab id. Add a blocking `PermissionRequest` HTTP hook, plus Notification/Stop, and have it forward to a Telegram bot only while away. The phone taps Approve/Deny, the hook returns allow/deny, and a timeout returns `ask`. Follow-ups and free-text answers are typed into the pty by VibeSpace only when the tab is idle.
   - No vendor dependency, and it works even when Remote Control misbehaves.
   - Content passes through Telegram, so it is not E2E.
3. **Hybrid:** use (1) for rich interaction and (2) as a thin, reliable "you're needed on tab X" alert and approve/deny path. Watch for double-answering: whichever answers first wins, and the other surface must reconcile.
4. **Not recommended:** adopting Happy/HAPI/VibeTunnel/agentapi, because they must own the process. Nor Orca, which is a competitor ADE. Nor tmux/SSH, because Windows ConPTY sessions are not attachable. CloudCLI/Yep Anywhere could be run *alongside* for read-only transcript viewing, but resuming from them forks a second writer on the same session.
