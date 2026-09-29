# RESEARCH — Claude Code data surfaces + UI ideas (2026-09-29)

Three parallel research passes (Opus subagents), merged verbatim. Part C is the idea list;
Part A says where the data comes from and how often; Part B is what VibeSpace reads today.
Formats marked [DOC] are from official docs but not yet tested inside a VibeSpace pty.

---

# Part A — Claude Code data surfaces for a wrapping app (VibeSpace)

Researched 2026-09-29 against Claude Code **v2.1.284** (installed: `C:\Users\Valentin\.local\bin\claude.exe`, native build).
Sources: raw markdown of the official docs (`https://code.claude.com/docs/en/<page>.md`), the `anthropics/claude-code` CHANGELOG.md, `claude --help`, and read-only inspection of `~/.claude`.
Raw doc copies were fetched into a session scratchpad (not kept); re-fetch from the doc URLs cited below.

Legend: **[DOC]** = documented officially · **[VERIFIED]** = seen on this machine · **[DE-FACTO]** = observed but undocumented / internal, may change any release · **[UNVERIFIED]** = inferred, not tested.

---

## 0. Verdict: best surfaces, ranked for VibeSpace

| # | Surface | What it gives | Cadence | Cost to adopt |
|---|---|---|---|---|
| 1 | **statusLine command injected via `--settings`** [DOC] | model, cost USD, durations, lines +/-, context window tokens + used %, 5h/7d rate-limit %, prompt-cache stats, effort, session id/name, prompt_id, transcript path, cwd/project/worktree/PR, output style, version | on session start, every new assistant message, `/compact` end, permission-mode change, vim toggle; 300 ms debounce; optional `refreshInterval` (>=1 s) timer | tiny: a script that tees stdin JSON to a per-terminal file and prints a line. User currently has NO statusLine, so nothing to preserve (verified) |
| 2 | **HTTP hooks** (`type: "http"`) to a localhost server in Electron main [DOC] | full hook JSON for ~33 events (tool calls with inputs/outputs + duration, prompts, stop w/ last message + background tasks, subagent start/stop w/ transcript path, compaction, model switches, notifications, task create/complete, cwd change...) | event-driven, per event | small: replaces the file-append-a-word hooks; no process spawn per event |
| 3 | **`~/.claude/sessions/<pid>.json`** + `claude agents --json` [DE-FACTO file / DOC CLI] | per running claude.exe: pid, sessionId, cwd, name, `status` busy/idle/waiting, `waitingFor`, version, updatedAt | rewritten on status change | tiny: pid of claude.exe (child of the pty's powershell) -> sessionId directly; could replace transcript-birth heuristics |
| 4 | **OpenTelemetry -> local OTLP http/json receiver** [DOC] | per-API-request cost/tokens/duration/model, tool_result (name, success, duration), tool_decision, user_prompt, compaction pre/post tokens, subagent_completed, api_error/retries, permission-mode changes; metrics counters incl. active time | logs/events batch every 5 s (default, tunable), metrics every 60 s (tunable) | medium: env vars per pty + an HTTP endpoint that parses OTLP JSON |
| 5 | **Transcript .jsonl** [DOC location, DE-FACTO format] | everything historically: messages, per-message usage, tool_use/tool_result, `cost-state`, `turn_duration`, `compact_boundary`, `ai-title`, subagent transcripts | append as written (async, may lag) | already used for session discovery; tail-parse for history views only |
| 6 | Terminal escape sequences [VERIFIED partially] | OSC 0 title (idle glyph "✳", busy spinner glyphs), focus reporting, mouse/alt-screen modes; OSC 9;4 progress only in ConEmu/Ghostty/iTerm2 | realtime | free via xterm.js `onTitleChange`, parser hooks |

---

## 1. Hooks (docs: https://code.claude.com/docs/en/hooks)

### 1.1 Handler types
`command` | `http` | `mcp_tool` | `prompt` | `agent`. All matching hooks run in parallel; identical handlers across settings files run once.

- **command**: fields `command`, `args` (exec form, no shell), `async` (background, can't block), `asyncRewake`, `shell` (`bash`|`powershell`; default bash = Git Bash on Windows, PowerShell if no Git Bash). JSON on stdin.
- **http**: fields `url`, `headers`, `allowedEnvVars`. **POSTs the same JSON body** (`Content-Type: application/json`). 2xx empty = success; 2xx JSON = decision output; non-2xx / connection failure = non-blocking error, execution continues. => Electron main can run `http://127.0.0.1:<port>/hook?term=<id>` and receive every event with zero process spawns. Per-terminal identity: put term id in the URL or a header with `allowedEnvVars: ["VIBESPACE_TERM_ID"]`. [DOC]; [UNVERIFIED on this machine]
- Common handler fields: `type`, `if` (permission-rule filter, tool events only), `timeout` (defaults: 600 s command/http/mcp_tool; 30 s prompt; 60 s agent; lowered to 30 s on UserPromptSubmit/PreModelSwitch/PostModelSwitch and 10 s on MessageDisplay; SessionEnd total budget 1.5 s, raisable to 60 s or via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`), `statusMessage`, `once` (skills only).

### 1.2 Common input fields (all events)
`session_id`, `prompt_id` (v2.1.196+, absent before first input; equals OTel `prompt.id`), `transcript_path` (written async, may lag), `cwd`, `scratchpad_dir` (v2.1.257+), `permission_mode` (not on all events; "Manual" arrives as `"default"`), `effort` `{level}` (tool-context events only), `hook_event_name`. In subagents / `--agent`: `agent_id`, `agent_type`.
No model field except SessionStart (`model`, optional) and Pre/PostModelSwitch (`from_model`/`to_model`). No `$CLAUDE_MODEL` env.
Env for hook processes: `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID` (matches session_id, updated on /clear), `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_EFFORT`, `CLAUDE_ENV_FILE` (SessionStart/Setup/CwdChanged/FileChanged), `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, plus inherited env **minus all `OTEL_*`**.

### 1.3 Events and event-specific input fields (verbatim from raw doc)
| Event | Fires | Extra input fields | Matcher |
|---|---|---|---|
| SessionStart | new/resume/clear/compact/fork | `source`, `model`?, `agent_type`?, `session_title`?; on resume/fork: `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (v2.1.251+) | startup/resume/clear/compact/fork |
| Setup | `--init-only`, `-p --init/--maintenance` | `trigger` | init/maintenance |
| InstructionsLoaded | CLAUDE.md / rules file loaded | `file_path`, `memory_type`, `load_reason`, `globs`?, `trigger_file_path`?, `parent_file_path`? | load reason |
| UserPromptSubmit | prompt submitted | `prompt` (pastes expanded) | none |
| UserPromptExpansion | slash command / MCP prompt expands | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` | command name |
| MessageDisplay | assistant text streams to screen (per batch of lines) | `turn_id`, `message_id`, `index`, `final`, `delta` | none |
| PreToolUse | before every tool call | `tool_name`, `tool_input`, `tool_use_id`, `mcp_server`? {name, source} | tool name |
| PermissionRequest | permission dialog about to show | `tool_name`, `tool_input`, `mcp_server`?, `permission_suggestions`? (no tool_use_id) | tool name |
| PermissionDenied | auto mode denies | `tool_name`, `tool_input`, `tool_use_id`, `reason` | tool name |
| PostToolUse | tool succeeded | `tool_name`, `tool_input`, `tool_response` (structured Output object), `tool_use_id`, `duration_ms`? | tool name |
| PostToolUseFailure | tool failed | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`?, `duration_ms`? | tool name |
| PostToolBatch | after a parallel batch resolves, before next model call | `tool_calls[]` {tool_name, tool_input, tool_use_id, tool_response (serialized, as model sees it)} | none |
| Notification | notification sent | `message`, `title`?, `notification_type` | permission_prompt, idle_prompt, auth_success, elicitation_dialog, elicitation_url_dialog, elicitation_complete, elicitation_response, agent_needs_input, agent_completed, quota_auto_resume_fired/stale/disabled |
| SubagentStart | subagent spawned | `agent_id`, `agent_type` | agent type |
| SubagentStop | subagent finished (also internal agents: prompt suggestions, /btw) | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` | agent type |
| TaskCreated / TaskCompleted | TaskCreate / task marked done | `task_id`, `task_subject`, `task_description`?, `teammate_name`?, `team_name` (deprecated) | none |
| TeammateIdle | agent-team teammate going idle | `teammate_name`, `team_name` | none |
| Stop | Claude finishes a turn | `stop_hook_active`, `last_assistant_message`, `background_tasks[]` {id,type,status,description,command?,agent_type?,server?,tool?,name?}, `session_crons[]` {id,schedule,recurring,prompt} | none |
| StopFailure | turn ended by API error | `error` (rate_limit, overloaded, authentication_failed, oauth_org_not_allowed, account_on_hold, billing_error, invalid_request, model_not_found, server_error, max_output_tokens, cloud_credential_error, unknown), `error_details`?, `last_assistant_message`? | error type |
| ConfigChange | settings/skills file changes mid-session | `source`, `file_path`? | source |
| CwdChanged | cwd changes | `old_cwd`, `new_cwd` | none |
| DirectoryAdded | /add-dir | `directory_path`, `add_method` | method |
| FileChanged | watched file changes | `file_path`, `event` (change/add/unlink) | literal filenames |
| WorktreeCreate / WorktreeRemove | worktree lifecycle | `base_path`/`worktree_path`, `context`? | none |
| PreCompact | before compaction | `trigger` (manual/auto), `custom_instructions` | manual/auto |
| PostCompact | after compaction | `trigger`, `compact_summary` | manual/auto |
| PreModelSwitch | before model switch | `from_model`, `to_model`, `requested_model`, `source`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` | model name |
| PostModelSwitch | after model change (incl. auto fallback, resume) | same, `source` adds auto/resume | model name |
| Elicitation / ElicitationResult | MCP asks for input / user answered | `server_name`, `elicitation_id`, form/response fields | server name |
| SessionEnd | session ends | `reason` (clear, resume, logout, prompt_input_exit, other) | reason |

Notification timing caveats [DOC]: `permission_prompt` fires only after ~6 s without typing (use **PermissionRequest** for instant "needs approval"); `idle_prompt` ~60 s after finish and only if you haven't typed. These use Claude's "user is away" logic — which in a terminal is driven by keystrokes and **focus reports** (see §6).

### 1.4 Hook output
Universal JSON fields: `continue`, `stopReason`, `suppressOutput` (no-op), `systemMessage`, **`terminalSequence`** (allowlist: OSC 0/1/2 titles, OSC 9 incl. `9;4` progress, OSC 99, OSC 777, BEL — Claude writes it into its own output stream, so a hook can push a custom escape sequence into our xterm, e.g. a private OSC 9 payload the renderer intercepts. Interactive only). Event-specific: `decision`/`reason`, `hookSpecificOutput` {`hookEventName`, `additionalContext`, `permissionDecision` allow/deny/ask/defer, `updatedInput`, `updatedToolOutput`, `displayContent` (MessageDisplay), `sessionTitle`/`initialUserMessage`/`watchPaths` (SessionStart), `retry` (PermissionDenied), `action`/`content` (Elicitation), `worktreePath`}. Strings capped at 10,000 chars. Exit 2 = block (per-event semantics).

### 1.5 --settings merge
`--settings <file-or-json>` is the "command line" precedence level: overrides user/project/local for the same key, lower-level values kept for omitted keys; managed settings still win. Hooks from different levels all run (deduped if identical). `statusLine` is a single key, so ours replaces any user statusLine for that session (user has none today — verified). `disableAllHooks` or `allowManagedHooksOnly` would silently disable both our hooks and our statusLine. Both hooks and statusLine require workspace trust accepted.

---

## 2. Status line (docs: https://code.claude.com/docs/en/statusline)

### 2.1 Settings
`"statusLine": {"type":"command","command":"...","padding":0,"refreshInterval":N,"hideVimModeIndicator":bool}`. `refreshInterval` minimum 1 s, re-runs on a timer in addition to events. Also `subagentStatusLine` (see 2.4). Windows: run via Git Bash if installed else PowerShell; use forward slashes in the command path; `COLUMNS`/`LINES` env provided; `CLAUDE_CODE_CHILD_SESSION=1` set.

### 2.2 Cadence [DOC]
Runs at session start/resume, then on: new assistant message, `/compact` finished, permission mode change, vim toggle, command change, `refreshInterval` tick, a rate-limit window reaching `resets_at`, a warm prompt cache reaching `expires_at`. **Debounced 300 ms**; an in-flight script is cancelled if a new update arrives. Can go quiet while idle (use refreshInterval). Hidden (probably not run) during help menu / permission prompts. Non-zero exit or empty output = blank line. `claude --debug` logs its stderr.

### 2.3 JSON on stdin (full field list)
`cwd`, `session_id`, `session_name`?, `prompt_id`? (v2.1.196+), `transcript_path`, `version`,
`model` {`id`, `display_name`},
`workspace` {`current_dir`, `project_dir`, `added_dirs[]`, `git_worktree`?, `repo`? {host, owner, name}},
`output_style` {`name`},
`cost` {`total_cost_usd` (client-side list price; resets on /clear since v2.1.211), `total_duration_ms`, `total_api_duration_ms`, `total_lines_added`, `total_lines_removed`},
`context_window` {`total_input_tokens`, `total_output_tokens`, `context_window_size` (200000 or 1000000), `used_percentage`, `remaining_percentage` (may be null early), `current_usage` {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} (null before first call and right after /compact)},
`exceeds_200k_tokens`, `fast_mode`, `effort` {`level`}?, `thinking` {`enabled`},
`rate_limits`? {`five_hour` {used_percentage, resets_at}, `seven_day` {...}, `spend_limit` {...}} — only Pro/Max subscribers (or gateway spend limits), only after first API response, windows independently absent,
`prompt_cache`? (v2.1.251+) {`warm`, `caching_observed`, `ttl`, `expires_at`, `requests`, `misses`, `expected_rebuilds`, `hit_ratio`, `cache_write_tokens`, `miss_recache_tokens`, `last_miss_at`, `last_miss_cause` {causes[], tools_added, tools_removed, system_char_delta}, `miss_causes` {}, `recache_tokens_if_cold`},
`vim` {`mode`}?, `agent` {`name`}?, `pr`? {`number`, `url`, `review_state`, `kind`}, `worktree`? {name, path, branch, original_cwd, original_branch}.
`used_percentage` = (input + cache_creation + cache_read) / window; excludes output.

### 2.4 subagentStatusLine [DOC]
Runs "once per refresh tick" with base hook fields + `columns` + `tasks[]` {`id`, `name`, `type`, `status`, `description`, `label`, `startTime`, `model`, `effort`, `contextWindowSize`, `tokenCount`, `tokenSamples`, `cwd`}. Output one `{"id","content"}` JSON line per row to override. => live per-subagent token/context data for a subagent panel. Exact tick rate undocumented [UNVERIFIED].

### 2.5 Siphon plan (answer to "can we inject via --settings?") — YES [DOC; not yet tested here]
Put `statusLine` in the per-instance `claude-hook-settings.json` we already pass with `--settings`. Command e.g. `node <BIN_ROOT>/assets/statusline-tap.cjs` (exec path with forward slashes) that reads stdin, writes it atomically to `$VIBESPACE_TERM_STATUS.statusline.json` (env is inherited from the pty), and prints a short line (or the same line Claude would show). Set `refreshInterval` only if we need idle updates. Caveats: spawning node per update (~every assistant message, debounced) is fine; the visible status row inside the terminal becomes ours (can print something useful or minimal); requires trust accepted; blank on first launch until trust dialog accepted.

---

## 3. OpenTelemetry (docs: https://code.claude.com/docs/en/monitoring-usage)

- Enable: `CLAUDE_CODE_ENABLE_TELEMETRY=1`; `OTEL_METRICS_EXPORTER` (otlp|prometheus|console|none), `OTEL_LOGS_EXPORTER` (otlp|console|none), `OTEL_TRACES_EXPORTER` (needs `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). `OTEL_EXPORTER_OTLP_PROTOCOL` **required** (no default): grpc | http/json | http/protobuf. Endpoint generic or per signal (`.../v1/metrics`, `/v1/logs`, `/v1/traces`). Settable in `env` of `--settings` too (settings `env` key), or directly in pty env.
- Intervals: `OTEL_METRIC_EXPORT_INTERVAL` default 60000 ms; `OTEL_LOGS_EXPORT_INTERVAL` default 5000 ms; traces 5000 ms. Temporality default **delta**.
- Content: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` (tool inputs/params, skill/MCP names), `OTEL_LOG_TOOL_CONTENT` (tracing), `OTEL_LOG_RAW_API_BODIES`.
- Cardinality: `OTEL_METRICS_INCLUDE_SESSION_ID` (default true), `..._VERSION`, `..._ACCOUNT_UUID`, `..._ENTRYPOINT`, `..._REPOSITORY`. `OTEL_RESOURCE_ATTRIBUTES` -> we can tag each pty (`vibespace.term_id=...`).
- Metrics: `claude_code.session.count`, `lines_of_code.count` {type added/removed, model}, `pull_request.count`, `commit.count`, `cost.usage` (USD) {model, query_source, speed, effort, agent/skill/plugin/mcp}, `token.usage` {type input/output/cacheRead/cacheCreation, model...}, `code_edit_tool.decision`, `active_time.total` (s) {type user/cli}.
- Events (logs): `user_prompt`, `assistant_response`, `tool_result` (tool_name, tool_use_id, success, duration_ms, sizes, decision_source...), `tool_decision`, `api_request` (model, cost_usd, duration_ms, input/output/cache_read/cache_creation tokens, request_id, speed, effort, query_source), `api_error`, `api_refusal`, `api_retries_exhausted`, `api_request_body`/`api_response_body`, `permission_mode_changed`, `auth`, `mcp_server_connection`, `internal_error`, `plugin_installed`, `plugin_loaded`, `skill_activated`, `at_mention`, `hook_registered`, `hook_execution_start`, `hook_execution_complete`, `hook_plugin_metrics`, `compaction` (trigger, success, duration_ms, pre_tokens, post_tokens), `subagent_completed` (total_tokens, is_async...), `feedback_survey`, `retention_sweep`, `managed_settings_resolved`. Events carry `session.id`, `prompt.id`, `event.sequence`, `message.uuid`, `request_id`.
- Traces (beta): spans `claude_code.interaction` (per prompt), `llm_request` (ttft_ms, tokens, stop_reason), `tool`, `tool.blocked_on_user` (permission wait duration!), `tool.execution`, `hook`.
- Local receiver feasibility: **yes** — `http/json` to `http://127.0.0.1:<port>` from Electron main, parse OTLP JSON (`resourceLogs[].scopeLogs[].logRecords[]`, `resourceMetrics[]`). Content-Length sent (v2.1.212+). Don't use `console` exporter (would print into the TUI's stdout) [UNVERIFIED but near-certain]. Don't use `prometheus` (binds fixed port 9464 per process -> clashes across many claude processes). OTEL_* is stripped from subprocesses so it won't leak into agents' Bash.
- Caveats: telemetry also sends to wherever the env says only; `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` interplay not verified; managed settings can override endpoints (not the case here). Latency: 5 s batch for events is coarser than hooks.

---

## 4. Transcript `.jsonl` (docs: https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)

Doc says: location `~/.claude/projects/<munged>/<session-id>.jsonl`; **"entry format is internal and changes between versions"**; recommended structured interfaces are `-p --output-format json/stream-json`, hooks' `transcript_path`, Agent SDK. Subagent transcripts: `<session-id>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json` {agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive, model} [VERIFIED]; `<session-id>/tool-results/` for persisted large outputs.

Record types seen across 24 recent transcripts (v2.1.28x) [DE-FACTO]:
- `assistant` — `message` {id, model, content[] (text/thinking/tool_use), stop_reason, usage {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, output_tokens_details.thinking_tokens, server_tool_use, service_tier, cache_creation {ephemeral_1h/5m}, speed, iterations}}, requestId, effort/perTurnEffort, isSidechain, isApiErrorMessage, error, apiErrorStatus, `quotaLimits` {status, resetsAt, rateLimitType, overageStatus, ...} on rate-limit errors.
- `user` — prompts and `tool_result` blocks; `toolUseResult` = structured tool output (Edit: structuredPatch/oldString/newString; Bash: stdout/stderr/interrupted; Agent: agentId/totalTokens/totalToolUseCount/usage...), promptId, permissionMode, isCompactSummary, isMeta.
- `attachment` — {type: total_tokens_reminder, edited_text_file, deferred_tools_*, skill_listing, plan_mode, queued_command, hook_non_blocking_error, ...}.
- `system` subtypes: `turn_duration` {durationMs, messageCount, pendingBackgroundAgentCount}, `stop_hook_summary` {hookInfos, hookErrors}, `compact_boundary` {compactMetadata {trigger, preTokens, postTokens, durationMs}}, `api_error` {retryInMs, retryAttempt, maxRetries}, `away_summary` (recap text), `informational`, `local_command`, `scheduled_task_fire`.
- `cost-state` — {totalCostUSD, totalAPIDuration, totalToolDuration, totalLinesAdded/Removed, totalDuration, startTime, modelUsage{model: {inputTokens, outputTokens, thinkingTokens, cacheRead/CreationInputTokens, webSearchRequests, costUSD}}} — written occasionally (72 in 24 files), likely at exit/resume.
- `ai-title` {aiTitle}, `agent-name` {agentName} (the /rename name!), `last-prompt`, `mode`, `permission-mode`, `queue-operation` (enqueue/dequeue of queued prompts), `file-history-snapshot`/`file-history-delta`, `bridge-session`, `atis-latch`.
- **No TodoWrite/todos**: `~/.claude/todos/` is legacy ("no longer written" [DOC]). Task lists live in `~/.claude/tasks/<list-id>/<n>.json` {id, subject, description, activeForm, status, blocks, blockedBy} [VERIFIED shape]; TaskCreated/TaskCompleted hooks give live events.

---

## 5. Other surfaces

- **`~/.claude/sessions/<pid>.json`** [DE-FACTO; doc only says "one small file per running session, used to detect concurrent sessions and crashes", removed on exit]: {pid (= claude.exe, whose parent is the pty's powershell.exe — verified), sessionId, cwd, startedAt, version, kind, entrypoint, messagingSocketPath (named pipe for cross-session messaging), name, nameSource, `status` ("busy"|"idle"|"waiting"), `waitingFor` ("input needed"), updatedAt, statusUpdatedAt}. Great for pty->session mapping and a hook-free busy light; sessionId presumably updates on /clear and /resume [UNVERIFIED].
- **`claude agents --json`** [DOC in --help]: prints active interactive + background sessions as JSON {pid, cwd, kind, startedAt, sessionId, name, status, waitingFor}; no TTY needed; `--all` adds finished background sessions. Stable CLI alternative to reading the files (costs a process spawn, ~1-2 s).
- **`~/.claude.json` projects[<path>]** [DE-FACTO]: last-session stats written at exit: lastCost, lastDuration, lastAPIDuration, lastToolDuration, lastLinesAdded/Removed, lastTotalInput/Output/CacheCreation/CacheReadInputTokens, lastModelUsage, lastSessionId, lastSessionMetrics, lastFpsAverage. Per project, not per session; overwritten by whichever session exits last.
- **`~/.claude/stats-cache.json`** [DOC: "aggregated token and cost counts shown by /usage"]: dailyActivity [{date, messageCount, sessionCount, toolCallCount}], ... — good for a usage heatmap.
- **`~/.claude/history.jsonl`** [DOC]: every prompt {display, pastedContents, timestamp, project, sessionId}.
- **`/usage`** (formerly `/cost`), `/context`, `/stats`: TUI-only renderings; no machine output. `/usage` report HTML at `~/.claude/usage-data/report.html`. Rate-limit numbers are available machine-readably only via statusLine `rate_limits` (and `quotaLimits` in transcripts on 429s).
- **`claude -p --output-format stream-json --verbose [--include-partial-messages] [--include-hook-events]`** [DOC]: NDJSON of SDKMessage union — `system/init` (model, tools, MCP, plugins), `assistant`/`user`, `stream_event` partials, `system/api_retry`, `system/compact_boundary`, `system/status`, `hook_*`, `task_started/progress/notification`, `rate_limit_event`, `permission_denied`, `prompt_suggestion`, final `result` {duration_ms, duration_api_ms, num_turns, total_cost_usd, usage, modelUsage, permission_denials, ttft_ms, stop_reason...}. Only for headless runs, not our interactive TUI tabs (would mean replacing the terminal with a custom chat UI).
- **Useful env vars**: `CLAUDE_CODE_SESSION_ID` (in hooks/Bash), `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (don't set: title is a signal), `CLAUDE_CODE_NO_FLICKER` / `tui` setting (fullscreen alt-screen renderer), `CLAUDE_CODE_DISABLE_MOUSE`, `CLAUDE_CODE_FORCE_SYNC_OUTPUT` (DEC 2026), `FORCE_HYPERLINK=1` (OSC 8 links if xterm link handler added), `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`, `CLAUDE_CODE_TMPDIR`.
- **Settings of interest**: `preferredNotifChannel` (auto|terminal_bell|iterm2|iterm2_with_bell|kitty|ghostty|notifications_disabled) — setting `terminal_bell` or `iterm2` in our --settings would make Claude emit BEL / OSC 9 notifications we can catch in xterm (hook events fire regardless); `terminalProgressBarEnabled` (default true, but OSC 9;4 is only emitted in ConEmu, Ghostty >=1.2, iTerm2 >=3.6.6 — detection method undocumented; spoofing e.g. `TERM_PROGRAM` is [UNVERIFIED] and risky); `terminalTitleFromRename`.

## 6. Terminal escape sequences (local probe: claude.exe in node-pty, 12 s idle, cwd VibeSpace) [VERIFIED]
Emitted: `CSI ?1004h` (**focus reporting** — Claude uses focus-in/out to judge "user away" for notifications; xterm.js sends `CSI I`/`CSI O` on textarea focus/blur, so background tabs look "away"), `CSI ?2004h` (bracketed paste), `CSI ?2031h` (theme/color-scheme change notifications), `CSI ?1049h` (alt screen — fullscreen `tui` renderer is on for this user), `CSI ?1000h/1002h/1003h/1006h` (mouse tracking, SGR), `OSC 0;claude` then `OSC 0;✳ Claude Code` (title; idle glyph ✳; changelog: busy state uses spinner glyphs, fixed-width braille), `CSI ?9001h` is ConPTY's win32-input-mode. Not seen during idle: OSC 9 / 9;4 / 777 / 99 (expected — not a "supported" terminal and not busy). A busy-state probe was not run [UNVERIFIED which title glyphs appear when busy].

## 7. Side effects of this research
- The pty probe launched claude.exe for ~12 s in `D:\Repositories\VibeSpace` then killed it; no message was sent (no transcript). Claude Code itself then updated its own `~/.claude.json` project entry (lastSessionId `30ed0967-...`, lastDuration 11973) and may have left a stale `~/.claude/sessions/<pid>.json` that Claude clears on next launch. No user config files were edited by me.
- Spotted in a transcript: a user-level Stop hook `powershell -ExecutionPolicy Bypass -File ...notify.ps1 stop` failed with `/usr/bin/bash: line 1: powershell: command not found` (session 33d619e8, 2026-09-26) — hooks default to Git Bash on Windows, and that bash lacked System32 on PATH (likely the Path/PATH bug fixed in e58c98d). Worth a look separately.

## 8. Unverified / to test before building
1. statusLine injected via `--settings` actually runs in a VibeSpace pty and receives `rate_limits` on this Max/Pro account.
2. HTTP hooks to 127.0.0.1 from claude.exe (no proxy interference; latency).
3. OTLP http/json payload shape from v2.1.284 and whether `OTEL_*` in `--settings` `env` is honored as well as pty env.
4. Whether `sessions/<pid>.json` `sessionId` follows `/clear` and `/resume` switches (would close the TODO hole on manual /resume).
5. Busy-state title glyphs; subagentStatusLine tick rate.


---

# Part B — What VibeSpace reads today + what real transcripts contain (2026-09-29)

(Explore agent was read-only; findings transcribed by the orchestrator.)

## Today
- sessions.cjs: filename/mtime discovery of ~/.claude/projects/<munged>/*.jsonl (fs.watch + 700 ms debounce + 4 s poll). Never parses content. Surfaces: tab light "on", tooltip, resume.
- Hooks (ensureHookSettings in main/index.cjs): UserPromptSubmit/PreToolUse→working, Notification→waiting (idle "waiting for your input" skipped), Stop→done, appended to $VIBESPACE_TERM_STATUS.
- status.cjs watches status files (200 ms debounce) → term:status → lights, unread, toasts, taskbar badge, busy check.
- updater.cjs: `claude --version` at open + every 5 min.
- Reads NO tokens / cost / model / tools / todos.

## Transcript contents (sampled)
- Record types: user, assistant, attachment, system (stop_hook_summary, turn_duration, away_summary, compact_boundary, local_command, informational), cost-state, ai-title, agent-name, last-prompt, mode, permission-mode, queue-operation, file-history-snapshot/delta, atis-latch. No `summary` records; compaction = compact_boundary with pre/post tokens.
- Common fields: uuid, parentUuid, timestamp, cwd, gitBranch, version, sessionId, isSidechain, slug; assistant has effort; message.model (incl. non-Claude like glm-5.3); message.usage input/output/cache_read/cache_creation (+ thinking, 5m/1h cache split).
- Tools: tool_use (name, input); tool_result + structured toolUseResult (Edit patch, Bash stdout/stderr/interrupted).
- TodoWrite todos[{content,status,activeForm}] in transcript; TaskCreate/TaskUpdate tasks in ~/.claude/tasks/<session>/<n>.json (id, subject, status, blocks, blockedBy). No ~/.claude/todos/.
- cost-state (101/149 transcripts): running totalCostUSD, API/tool durations, lines added/removed, per-model costUSD. ~/.claude.json projects[...] has only last-session totals (lastCost, lastTotalInputTokens, lastModelUsage, lastSessionId).
- Subagents: <project>/<sessionId>/subagents/agent-<id>.jsonl + .meta.json (agentType, description, parent toolUseId, model). Large outputs in <sessionId>/tool-results/.
- **~/.claude/sessions/<pid>.json**: live session registry — sessionId, cwd, version, name, status idle/busy/waiting, waitingFor. Could replace timing-based session matching and the echo hooks.
- Also: stats-cache.json (daily activity + model tokens), history.jsonl (prompt log).


---

# Part C — Claude Code GUI / multi-agent manager landscape (as of 2026-09-29) — ideas for VibeSpace

## Verdict

The market has converged on four things: **(1) at-a-glance agent state** (working / needs input / done / failed),
**(2) isolation + review** (worktree per agent, diff-first review with comments sent back to the agent),
**(3) quota/context awareness** (context %, 5h/7d plan limits with reset countdowns), and **(4) "what is it doing"
visibility** (tasks/todos, tool timeline, subagent tree). VibeSpace already has (1) and a first cut of (2).
The cheapest big win is the **statusline JSON tee**: VibeSpace already injects `--settings`, so it can add a
`statusLine` command that records Claude's official per-session JSON (context %, rate limits with reset times,
cost, lines changed, session name, prompt-cache state) and then chains to the user's own statusline. That one
data source powers context meters, plan-limit bars, cost chips, and compaction/cache warnings — all without
scraping the TUI.

---

## 1. Landscape — tool by tool

| Tool | Form | Standout UI features | Data source | Windows? |
|---|---|---|---|---|
| **Claude Code Agent View** (Anthropic, `claude agents`, research preview since May 2026) | TUI inside claude | One table of all background sessions; states Working/Needs input/Idle/Completed/Failed/Stopped with icons+colors; grouping Pinned / Ready for review (open PR) / Needs input / Working / Completed; Haiku-generated name + one-line live summary (every 15 s, fresh at turn end); peek panel (Space) shows the exact pending question and lets you reply inline; "session recap" on attach; PR label per row; pin to keep alive | Supervisor daemon; `~/.claude/jobs/<id>/state.json`; **`claude agents --json`** (id, state, status, waitingFor, sessionId, name, pid, cwd); `claude attach/logs/stop/respawn <id>` | Yes |
| **Claude Code Desktop** (Anthropic, redesign Apr 14 2026) | Native app | Multi-session sidebar, drag-drop pane layout (watch 3 agents at once), integrated terminal + file editor, HTML/PDF preview, rebuilt diff viewer (collapsible, inline comments), worktree per session, Routines (cloud cron agents), "Plan" panel | Built-in | Yes |
| **claude.ai/code** (web) | Web | Parallel cloud tasks, diff view → Create PR (draft/full), teleport session to terminal, session sharing, Remote Control of a local session from phone/browser | Built-in | n/a |
| **VS Code extension** | IDE panel | Side-by-side proposed-edit diffs, plan review/edit before accepting, **checkpoint rewind** per message (fork conversation / rewind code / both, 30-day retention), multiple conversation tabs, @-mention with line ranges. Top request: hunk-level Keep/Undo inline diffs ([#80909](https://github.com/anthropics/claude-code/issues/80909), [#33932](https://github.com/anthropics/claude-code/issues/33932)), persistent task/plan view ([#8723](https://github.com/anthropics/claude-code/issues/8723)) | Built-in | Yes |
| **JetBrains plugin** | IDE bridge | Proposed edits open in the IDE diff viewer; current selection + open tabs + diagnostics auto-shared with claude; Ctrl+Alt+K file refs | **IDE protocol**: `~/.claude/ide/<port>.lock` + WebSocket MCP (tools openFile, openDiff, getCurrentSelection, getOpenEditors, getDiagnostics…) — reverse-engineered in [claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md) | Yes |
| **opcode** (ex-Claudia, [winfunc/opcode](https://github.com/winfunc/opcode), [opcode.sh](https://opcode.sh/)) | Tauri GUI | Visual project/session browser + search, resume past sessions, usage analytics dashboard (cost by model/project/day), timeline & checkpoints (branchable), custom agents, MCP manager, CLAUDE.md editor | `~/.claude/projects/*.jsonl` transcripts; runs claude with stream-json | Yes |
| **Crystal → Nimbalyst** ([crystal](https://github.com/stravu/crystal) deprecated Feb 2026; [nimbalyst](https://github.com/nimbalyst/nimbalyst)) | Electron | Session **kanban** that auto-moves cards (running → In Progress, asks question → Waiting); one-click worktree per session; WYSIWYG editors (markdown, mockups, Mermaid, Excalidraw, CSV); red/green diff with per-edit accept/reject; tracker items agents can edit; iOS companion with push, voice reply, swipe-diffs | Claude Agent SDK / CLI | Yes |
| **Conductor** ([conductor.build](https://www.conductor.build/docs/)) | Mac app ($22M Series A, Mar 2026) | Workspace = worktree + branch + terminal + diff + review path; diff-first review with **comments the agent reads and responds to** (local PR review); checks; PR → merge → archive workspace flow; Claude Code + Codex + Cursor + OpenCode | Agent SDK / CLI | No (Mac) |
| **Vibe Kanban** ([BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)) | Web (local) | Kanban issues → attempts; each attempt gets branch + terminal + dev server; compare attempts side-by-side; line comments sent back to agent; PR creation; is an MCP server itself (agents can create tickets) | CLI agents in worktrees | Yes |
| **Sculptor** (Imbue, [imbue.com/sculptor](https://imbue.com/sculptor/)) | Mac app | Every agent in its own container; **Pairing Mode** two-way syncs an agent's container into your local checkout/IDE for live testing; forwards devcontainer ports | Claude Code in containers | No |
| **Superset** ([superset-sh/superset](https://github.com/superset-sh/superset), [HN](https://news.ycombinator.com/item?id=46368739)) | Electron terminal | Worktree per task; sidebar with working indicators, **completion chimes, dock badges**; try two approaches and keep one; CLI + TS SDK + MCP server to drive it | PTY + agent hooks | No (Mac, Linux exp.) |
| **parallel-code** ([johannesjo/parallel-code](https://github.com/johannesjo/parallel-code)) | Electron | Tiled panels + focus mode; diff viewer with inline comments; **guided change tour** (walkthrough of the diff); steps panel (`.claude/steps.json`); per-task notes/canvas; PR CI watcher with notifications | CLI agents | No |
| **cmux** ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)) | Ghostty-based Mac terminal | Vertical tabs showing git branch, PR status, cwd, listening ports, **latest notification text**; waiting pane gets a blue ring; built-in scriptable browser; socket/CLI API. Lesson: its todo ingestion broke when Claude switched TodoWrite → TaskCreate/TaskUpdate ([#8960](https://github.com/manaflow-ai/cmux/issues/8960)) | OSC 9/99/777 + `cmux notify` from hooks | No |
| **claude-squad** ([smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)) | TUI | tmux session per agent + worktree; preview/diff tabs; pause (commit+detach)/resume; `--autoyes` | tmux pane capture | WSL only |
| **CCManager** ([kbwo/ccmanager](https://github.com/kbwo/ccmanager)) | TUI, no tmux | Real-time Idle/Busy/Waiting per session in the menu (its pitch vs claude-squad); status-change hook commands; Haiku-verified auto-approval; devcontainers; `.worktreeinclude` copies untracked files into new worktrees; copies session history into new worktrees; multi-project | PTY output parsing per agent CLI | Yes |
| tmux family (claude-tmux, dmux, agent-deck, agent-view, recon, tcmux, Corral — see [runpane overview](https://runpane.com/tmux-agent-managers)) | TUI | Popups, Docker sandboxes, read-only monitors | tmux capture / hooks | Mostly no |
| **Happy / Omnara** ([happy.engineering](http://happy.engineering/), [Omnara](https://www.producthunt.com/products/omnara)) | Mobile | Push on permission/finish, one-tap approve from phone, voice coding, E2E encryption | Wrapper around CLI + hooks | n/a |
| **ccusage** ([blocks guide](https://ccusage.com/guide/blocks-reports), [statusline](https://ccusage.com/guide/statusline)) | CLI | Daily/monthly/session reports; 5h "blocks" with burn rate $/h and projected block total (live mode removed in v18) | Transcripts `.jsonl` | Yes |
| **Claude-Code-Usage-Monitor** ([Maciek-roboblog](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)) | Python TUI | Live bars for tokens/cost/messages vs plan, burn rate, predicted time-to-limit, reset-aware pace, auto-learned custom limits (P90 of 8 days) | Transcripts | Yes |
| **ccstatusline** and other statuslines ([docs](https://code.claude.com/docs/en/statusline), [ohugonnot](https://github.com/ohugonnot/claude-code-statusline), [pacing guide](https://gist.github.com/jtbr/4f99671d1cee06b44106456958caba8b)) | In-TUI | 30+ widgets: context % bar (green/yellow/red), 5h/7d % with reset countdown, pacing targets, cost, git branch/worktree | **Statusline stdin JSON** | Yes |
| **Menu-bar quota apps** (CodexBar, [ClaudeBar](https://github.com/tddworks/ClaudeBar), Usagebar, ClaudeUsageBar) | macOS tray | Highest-% limit in the menu bar, per-limit bars (5h, weekly, per-model), reset time local tz, warn-before-out notification | OAuth usage endpoint (same as `/usage`) | Mac |
| **ccq-burn** ([list91/ccq-burn](https://github.com/list91/ccq-burn)) | **Windows taskbar strip** | Always-on-top strip: bright = used now, faded = forecast at reset; yellow 75 / red 90; weekly separate; "~" marks extrapolated values | Usage API every ~5 min + transcripts between | **Yes** |
| **claude-devtools** ([claude-dev.tools](https://claude-dev.tools/)) | Electron | **Context attribution** (CLAUDE.md, skills, @files, tool I/O, thinking, user text), compaction visualised (fill → shrink → refill), tool call inspector, subagent trees with tokens/cost/duration, alerts (.env access, tool errors, token thresholds, regex), memory pane | Transcripts | Yes |
| History viewers ([jhlee0409/claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) etc.) | Desktop | Browse/search past sessions as chat, tool indicators | Transcripts | Yes |
| **Hook observability** ([disler multi-agent observability](https://github.com/disler/claude-code-hooks-multi-agent-observability), [agents-observe](https://github.com/simple10/agents-observe)) | Web dashboard | Live event stream, per-agent swim lanes, pulse chart of activity, task/SendMessage flow, failure + permission events highlighted, subagent hierarchy | **Hooks** → HTTP → SQLite → WebSocket | Yes |
| **OTel/Grafana** ([ColeMurray/claude-code-otel](https://github.com/ColeMurray/claude-code-otel), [Grafana 25255](https://grafana.com/grafana/dashboards/25255-claude-code-metrics-prometheus/)) | Dashboards | Cost/tokens by model, sessions, active time, LOC, commits/PRs, tool accept/reject, cache hit ratio | **OpenTelemetry** (`CLAUDE_CODE_ENABLE_TELEMETRY`) | Yes |
| **Codex app** (OpenAI; Windows since Mar 2026) — competitor bar | Native | Worktrees, automations (scheduled, local or worktree), **review queue** approving diffs from many agents in one place | Built-in | Yes |

Overviews used: [Nimbalyst multi-agent tools 2026](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/),
[session kanban comparison](https://nimbalyst.com/blog/claude-code-session-kanban-organize-ai-agents/) (also covers
Claude Code Board, Kanban Code, Claudine), [DEV parallel agents 2026](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8),
[Addy Osmani: code agent orchestra](https://addyosmani.com/blog/code-agent-orchestra/), [Desktop redesign](https://pasqualepillitteri.it/en/news/866/claude-code-desktop-redesign-parallel-sessions).

### Repeated user asks (GitHub issues / threads)
- "Which session is blocked vs working?" — terminal-title issues [#78128](https://github.com/anthropics/claude-code/issues/78128), [#62384](https://github.com/anthropics/claude-code/issues/62384), [#33851](https://github.com/anthropics/claude-code/issues/33851), [#95359](https://github.com/anthropics/claude-code/issues/95359). Users trade off project identity vs Claude's status-prefixed title.
- Task/plan progress visible outside the chat — [#31243](https://github.com/anthropics/claude-code/issues/31243), [#8723](https://github.com/anthropics/claude-code/issues/8723), Desktop's Plan panel staying empty.
- Hunk-level accept/undo of edits; inline review comments that go back to the agent (Conductor/Vibe Kanban praise).
- Remote/mobile approval of permission prompts ([#60433](https://github.com/anthropics/claude-code/issues/60433)).
- Quota anxiety: the menu-bar/taskbar quota app category exists purely because of 5h/weekly limits.

---

## 2. Data sources available to VibeSpace (terminal-first, keeps the real TUI)

1. **Hooks** (already used: Notification/Stop/UserPromptSubmit/PreToolUse). Full event list ([docs](https://code.claude.com/docs/en/hooks)) adds, notably:
   `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `StopFailure` (matchers `rate_limit`, `overloaded`, `server_error`, …),
   `SubagentStart`/`SubagentStop` (`agent_type`, `agent_id`), `TaskCreated`/`TaskCompleted`, `PreCompact`/`PostCompact`,
   `SessionStart` (`source`: startup/resume/clear/compact/fork — fixes the "/resume inside a tab" TODO), `SessionEnd`,
   `CwdChanged`, `WorktreeCreate/Remove`, `PostModelSwitch`. `Stop` carries **`last_assistant_message`**. `Notification`
   carries `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, `agent_completed`, …).
2. **Statusline JSON** ([docs](https://code.claude.com/docs/en/statusline)), per session, event-driven (300 ms debounce, optional `refreshInterval`):
   `context_window.used_percentage/remaining_percentage/context_window_size/current_usage`, `exceeds_200k_tokens`,
   `rate_limits.five_hour|seven_day.{used_percentage,resets_at}` (Pro/Max only, after first response), `cost.total_cost_usd`,
   `cost.total_duration_ms`, `cost.total_lines_added/removed`, `session_id`, `session_name` (AI title or /rename),
   `model.display_name`, `workspace.git_worktree`, `worktree.*`, `prompt_cache.{warm,expires_at,hit_ratio,misses,last_miss_cause,recache_tokens_if_cold}`.
   Integration: add `statusLine` to the injected `--settings` file pointing at a VibeSpace script that writes the JSON to a
   per-pty file (like `$VIBESPACE_TERM_STATUS`) and then **pipes stdin to the user's own statusLine command and echoes its output**
   so their TUI statusline is untouched. (CLI `--settings` outranks user/project settings, so the wrapper must do the chaining.)
3. **Task files**: `~/.claude/tasks/<sessionId>/<n>.json` — `{id, subject, activeForm, status, blocks, blockedBy}` (verified locally).
   VibeSpace already knows each tab's session id → `fs.watch` gives a live todo list. TodoWrite is legacy since v2.1.16; don't key on it.
4. **Transcripts** `~/.claude/projects/<munged>/<uuid>.jsonl` — history, per-turn tokens, tool calls, subagent sidechains, context attribution.
5. **OSC terminal title** Claude sets (AI summary + status prefix) — free via xterm `onTitleChange`.
6. **Agent View**: `claude agents --json`, `claude attach <id>`, `claude logs <id>` for background (`--bg`, `/bg`) sessions.
7. **IDE protocol** (`~/.claude/ide/<port>.lock` + WebSocket MCP) — undocumented but stable enough that Neovim, Nova, JetBrains all use it.
8. **OTel** — overkill for a local app; skip.
9. **OAuth usage endpoint** (what `/usage`, menu-bar apps and ccq-burn call) — undocumented, needs credentials; prefer statusline `rate_limits`.

---

## 3. Top 15 feature ideas for VibeSpace

Ranked by (user demand × fit) / effort. Effort: S < 1 h, M = an evening, L = a few sessions (matches TODO.md scale).

| # | Feature | User value | Effort | Data source |
|---|---|---|---|---|
| 1 | **Context meter per tab** — thin bar under each tab name (green/amber/red), % on hover; red pulse ≥ 85 % | The #1 statusline widget everyone builds; know when to /compact or start fresh before quality drops | M (the tee is the work; UI is S) | Statusline JSON `context_window.*` via `--settings` wrapper that chains the user's statusline |
| 2 | **Plan-limit bar in the window header + launcher** — 5h and 7d % with reset countdown, pace marker ("on track to hit 100 % at 16:40"), warning toast at 80/95 % | Kills quota anxiety; the whole menu-bar/taskbar-app category (ClaudeBar, CodexBar, ccq-burn) exists for this | S after #1 | Statusline `rate_limits.five_hour/seven_day` (freshest across all tabs); burn-rate extrapolation from successive samples |
| 3 | **Live task checklist per agent** — "3/7" progress on the tab, expandable panel showing `activeForm` of the in-progress task, blocked items dimmed | Most-requested panel in Desktop/VS Code issues; turns an opaque long turn into visible progress | M | `~/.claude/tasks/<sessionId>/*.json` watched + `TaskCreated`/`TaskCompleted` hooks |
| 4 | **"Now doing" ticker** — one line under the tab: `Edit renderer/app.js`, `Bash npm test`, `Task → Explore`; red flash on tool failure | Tells you at a glance whether an agent is productive or looping, without switching tabs | S | `PreToolUse`/`PostToolUseFailure` hook payloads (`tool_name`, `tool_input`) |
| 5 | **Peek card / last message** — hover (or Space in overview) shows the agent's last reply or the exact pending question; toast body uses it too | Agent View's peek and "session recap" are its best-loved parts; already TODO #5 | S | `Stop.last_assistant_message`, `Notification.message` — no transcript parsing needed |
| 6 | **Richer state vocabulary** — split "waiting" into *needs permission* / *asked a question* / *idle-done*, add *failed* (rate limit, overloaded) with distinct colour/icon | Permission prompts are urgent, "done" is not; errors currently look like "done" | S (change hooks + lights + toasts + badge together per CLAUDE.md) | `Notification.notification_type`, `PermissionRequest`, `StopFailure` matchers |
| 7 | **Agent overview board** (per window, then cross-workspace) — cards grouped *Needs you / Working / Ready for review / Done*, each with context bar, task progress, diff stats, last message, quick-reply box | Agent View, Nimbalyst kanban, Conductor all converge here; already TODO "cross-workspace overview" — now all its signals exist | M (window) / L (cross-workspace) | Status file + statusline tee + tasks + Stop payload; reply = write to the pty |
| 8 | **Per-turn diff + review comments back to the agent** — "Changes this turn" (snapshot at prompt submit, diff at Stop), Monaco inline comments collected into one prompt typed into the agent's pty | Most praised feature of Conductor/Vibe Kanban/parallel-code/Desktop: local PR-review loop | M | `UserPromptSubmit` → `git stash create`/`write-tree` snapshot; `Stop` → diff; existing DiffEditor |
| 9 | **AI subtitle + auto tab naming** — keep user's tab name, show Claude's session title as subtitle; offer "rename to AI title" | Directly answers the terminal-title issue cluster; helps tell 5 agents apart | S | xterm `onTitleChange` (OSC title) or statusline `session_name` |
| 10 | **Compaction + cache warnings** — toast/badge "auto-compact imminent", compaction marker in the tab; for idle tabs a "cache cold in 3:12" chip | Compaction silently loses detail; cold cache makes the next prompt slow/expensive — nobody else surfaces the cache countdown | S | `PreCompact`/`PostCompact` hooks; statusline `prompt_cache.warm/expires_at`, `context_window.used_percentage` |
| 11 | **Session stats chip** — cost (API-equivalent), duration, +lines/−lines per tab and summed per window | Cheap "how much did this agent do" signal; lines added pairs well with diff review | S after #1 | Statusline `cost.*` |
| 12 | **Worktree tabs** — "+ Claude (isolated)" spawns into `.claude/worktrees/<name>` with branch, merge/discard actions, `.worktreeinclude` copy | Table stakes in Conductor, Desktop, Codex, Superset, Nimbalyst, CCManager; enables true parallel edits | L (existing TODO) | git worktree + claude `--worktree` / `WorktreeCreate` hook; statusline `worktree.*` |
| 13 | **Subagent badge + mini-tree** — "⎇ 2 subagents" on the tab, expandable list with type, running time, result | Long "quiet" turns are usually subagents; users want to see the fan-out | S/M | `SubagentStart`/`SubagentStop` hooks (`agent_type`, `agent_id`) |
| 14 | **IDE bridge: VibeSpace as Claude's IDE** — claude opens proposed edits as Monaco diffs in the preview pane, sees preview-pane selection/open files, `/ide` shows "VibeSpace" | JetBrains/VS Code users' favourite integration (selection context, IDE diff); makes the preview pane part of the conversation | M/L (undocumented protocol; pin to claudecode.nvim's spec) | `~/.claude/ide/<port>.lock` + WebSocket MCP (openDiff, getCurrentSelection, openFile, getDiagnostics) |
| 15 | **Background-agent interop** — show `claude --bg` / `/bg` sessions of this repo in the overview; "Attach in tab" runs `claude attach <id>` in a new pty | Anthropic's own multi-agent path (Agent View) grows; VibeSpace becomes the GUI for it instead of competing | S/M | `claude agents --json --cwd <repo>`, `claude attach`, `claude logs` |

**Honourable mentions**
- **Session history browser** with subagent tree and per-turn tokens / context attribution (claude-devtools, opcode) — L; transcripts.
- **Completion chime + distinct sounds** per state (Superset) — S; existing status events.
- **Taskbar-strip quota widget / jump list** (ccq-burn) — piggybacks on #2; Windows-only strength.
- **Activity pulse / swim-lane timeline** across agents (disler observability) — M; hooks with timestamps.
- **Guided change tour** (parallel-code) — ask the agent to narrate its diff, render as steps linked to Monaco — M.
- **Checkpoint rewind UI** — Claude's own `/rewind` exists in the TUI; a GUI list is L and duplicates it; skip for now.

### Suggested order
1. Statusline tee (#1 plumbing) → #1, #2, #11, #10 fall out of it (~1–2 evenings total).
2. Hook expansion (one change to the injected settings + status.cjs) → #4, #5, #6, #13.
3. Tasks watcher → #3.
4. Overview board (#7) once 1–3 provide the signals; then #8, #15, #12, #14.

### Gotchas to carry into implementation
- The statusline wrapper **must chain the user's existing statusLine** or VibeSpace silently removes it; also statusline suppresses Claude's footer hints (`esc to interrupt`) — acceptable, but note it.
- `rate_limits` is absent for API-key users and before the first response; each window may be missing independently — render "—", not 0 %.
- `context_window.used_percentage` is null early and after `/compact` until next call.
- Don't key task UI on `TodoWrite` (cmux broke on the switch to TaskCreate/TaskUpdate).
- Hook payload growth: `PostToolUse` fires a lot; keep the hook a tiny append (VibeSpace already caps hooks at 10 s) and coalesce in `status.cjs`.
- IDE protocol is unofficial; gate behind a setting and version-check.

---

# Part D — Live probe (claude 2.1.284 in ConPTY, 2026-09-29) [VERIFIED]

Three probe runs (~$1.25). Raw data lived in the session scratchpad and wasn't kept.
These results override Parts A–C where they disagree.

- **statusLine via `--settings` works.** It runs through Git Bash and gets `COLUMNS`,
  `LINES`, `CLAUDE_CODE_SESSION_ID` and our pty env, so `VIBESPACE_TERM_ID` identifies
  the tab for free.
- **`rate_limits` is present from the first tick on a Max account,** before any API
  call. Fields: 5h/7d whole-number % plus `resets_at` in epoch seconds. No
  `spend_limit` seen. (The docs imply it only appears after the first call.)
- Other statusLine fields present: context %, cost, model, workspace, `session_name`
  (auto title), `prompt_id` and `prompt_cache`. Context %, `current_usage` and
  `prompt_cache` stay empty until the first model response. Cost and `session_id`
  reset on `/clear`.
- **Cadence:** first tick ~3 s after trust, then per message and around tool calls.
  With `refreshInterval: 2` it ticks every 2.0 s even when idle. **No ticks while a
  permission dialog is open.**
- **HTTP hooks work with no noticeable latency.** Env vars in headers are expanded
  (`$VIBESPACE_TERM_ID` came through). Fired: UserPromptSubmit, PreToolUse,
  PermissionRequest, PostToolUse, PostToolBatch, MessageDisplay, Notification,
  TaskCreated/TaskCompleted, Stop (includes `last_assistant_message`), SubagentStop,
  SessionEnd, InstructionsLoaded.
- **SessionStart never fires as an HTTP hook,** not even after `/clear`; the command
  form does. It's the only event carrying `model`. Never observed, so payloads are
  unverified: PostToolUseFailure, StopFailure, SubagentStart, Pre/PostCompact.
- **If the hook server is down, claude doesn't hang, but it prints red "hook error /
  ECONNREFUSED" lines in the TUI on every prompt and turn.** The listener must be up
  before any agent starts and for as long as its ptys live.
- **PermissionRequest arrives ~0.1 s after PreToolUse** (has `tool_name`, `tool_input`,
  `permission_suggestions`; no `tool_use_id`). The `permission_prompt` Notification only
  comes ~6 s later; `idle_prompt` ~58 s after Stop.
- Valentin's default mode is bypassPermissions, so permission prompts are rare for him.
- **Task tools are OFF by default in 2.1.284.** They appeared with
  `CLAUDE_CODE_ENABLE_TASKS=true` + `CLAUDE_CODE_ENABLE_TODO_TOOLS=true` (not isolated
  which one matters); `=1` alone didn't work. Files: `~/.claude/tasks/<sessionId>/<n>.json`
  (id, subject, description, status, blocks, blockedBy) + `.lock` + `.highwatermark`.
  So a task panel means changing agent behavior through env.
- **`~/.claude/sessions/<pid>.json`:** pid = claude.exe (parent = the pty's powershell).
  Status goes idle → busy → waiting (`waitingFor: "permission prompt"`) → idle. It stays
  idle when idle_prompt fires. `sessionId` updates within ~1 s of `/clear`; `/resume`
  untested. Deleted on exit.
- **Titles:** busy shows ◐/◑ alternating ~1 s + session name, idle shows ✳. A pending
  permission prompt also shows ✳, so the title can't signal "needs approval". Claude
  also emits OSC 99 notifications because Valentin has `preferredNotifChannel: kitty`.
- Accepting the trust prompt programmatically: Down then Enter (plain Enter = "No, exit").
