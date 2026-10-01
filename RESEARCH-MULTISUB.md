# Multi-subscription agents (research, 2026-10-01)

Goal: one VibeSpace runs agents on several Claude subscriptions (e.g. a Max 20x and a
Max 10x) plus a third-party Anthropic-compatible endpoint (z.ai GLM). When one account
hits its usage limit, the work continues on another account automatically.

Checked against Claude Code 2.1.286 and code.claude.com docs (authentication,
env-vars, settings, statusline, hooks, remote-control, llm-gateway, sessions).

**Decision (2026-10-01): option A, token profiles, Claude accounts only, auto-switch on
limit.** GLM is out for now: Valentin had already found that Claude conversations don't
resume well on GLM. GLM only works as a fresh conversation, so the z.ai parts below are
reference only.

## What Claude Code gives us

| Mechanism | What it does | Catch |
|---|---|---|
| `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` | One-year OAuth token for a Pro/Max plan. A process with it set uses THAT subscription instead of the stored `/login`. | Inference only. **No Remote Control** (phone) and no claude.ai connectors. |
| `CLAUDE_CONFIG_DIR=<dir>` | A full second `~/.claude`, with its own `/login`. This is the docs' official "multiple accounts" answer. | Moves EVERYTHING: `projects/` transcripts, `sessions/`, settings.json, skills, CLAUDE.md, memory, plugins. It must come from the process env (a settings `env` block ignores it). |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (+ `ANTHROPIC_DEFAULT_*_MODEL`) | Points claude at z.ai. Can be set per session through the `env` block of the file passed with `--settings`. That file outranks `~/.claude/settings.json`, whose `env` wins over the shell env. | **No Remote Control** with a non-Anthropic base URL (since 2.1.196). Anthropic doesn't support non-Claude models. |
| statusLine `rate_limits.five_hour/seven_day` | `used_percentage` + `resets_at`, per account, after the first API response. | Pro/Max only. z.ai sends none. |
| `StopFailure` hook, `error_type: rate_limit` | A turn died on a limit. This is the switch trigger. | We already receive StopFailure over the feed (0.6.17 toasts). |
| `CLAUDE_CODE_RETRY_WATCHDOG=1` | The session waits out the reset instead of failing. | That's the opposite of switching; it could be useful as a "no spare account" fallback. |

The auth precedence is cloud provider → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` →
`apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → stored `/login`.

## Options

**A. Token profiles (recommended first step).** Each extra Max account is a
`setup-token` token. z.ai is an env profile. They all share the one `~/.claude`, so:
- Transcripts stay in `~/.claude/projects`. `sessions.cjs`, restore and the feed are untouched.
- The switch is: quit claude, then `claude --resume <id>` with the other profile's env, then type "continue".
- Skills, memory, CLAUDE.md, MCP and settings are the same on every account.
- The cost: phone control works only on the stored-`/login` account.

**B. One `CLAUDE_CONFIG_DIR` per account.** Remote Control works on every Max
account. But each dir is a separate world. To share transcripts, skills, memory and
settings we would have to junction `projects/`, `skills/`, `CLAUDE.md`, `settings.json`,
… back to `~/.claude`. That's fragile: claude writes atomically (rename) into some of
those paths, and `.claude.json` holds MCP and trust state. `util.cjs` `projectsDir()`
and the resume picker would also have to learn about several roots.

**C. Hybrid.** A now. Spike B later, only if phone control on the backup account matters.

## Design sketch for A

- `main/profiles.cjs` keeps a machine-wide `<dataRoot>/profiles.json`:
  `{ id, label, kind: 'login'|'oauth-token'|'endpoint', env, priority }`.
  - Secrets go in Windows Credential Manager / `safeStorage`, never plain JSON, and
    never in the repo, which is public.
- Each tab carries a `profile`. It gets that profile's `--settings` file
  (`claude-hook-settings.<profile>.json`, with an `env` block) or pty env.
  - `claudeCommand()` stays the one builder.
  - The wrapper's `$env:VIBESPACE_CLAUDE_SETTINGS` points at the profile's file.
- `limits.json` becomes keyed per profile, filled from each tab's statusLine.
  - New tabs pick the profile with the most headroom.
  - A tab pill shows which account it runs on.
- On `StopFailure rate_limit`, the profile is marked exhausted until `resets_at`.
  - Then either ask once (toast plus a button) or switch automatically: wait for the
    prompt, `/exit`, relaunch `claude --resume <id>` on the next profile, then paste
    "continue".
  - Profiles without `remote-control` drop that flag.

## Status

Built in 0.6.29 (smoke 82/82). Live limit → switch still pending (TODO.md).
Risk 1 below is moot: GLM is out. Risk 2 doesn't apply: the token goes in through
the process env, not the `--settings` env block.

## Open risks (verify live before building)

1. Does a session that started on Anthropic resume cleanly on z.ai? Thinking blocks
   carry Anthropic signatures, and GLM may reject them or ignore them. Test it with a
   throwaway session in both directions.
2. Does a token set in the `env` block of `--settings` really authenticate? `/status`
   shows the auth source.
3. Does a resumed session keep its model? A model set by env at launch is not restored.
4. Does the phone app show a resumed-on-token session as gone? Expected yes. The tab
   label should say so.

Side note: the z.ai config pasted on 2026-10-01 spells `ANCHROPIC_DEFAULT_HAIKU_MODEL`,
so the Haiku override never applied (haiku-tier calls sent claude's default Haiku id
and relied on z.ai's own mapping).
