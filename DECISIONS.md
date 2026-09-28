# Decisions

Flat decision log — one line each, append-only, newest at the bottom. Format:
`- **<topic>** — <choice>. Why: <reason>. (YYYY-MM-DD)`

- **No caching in `app://`** — protocol reads disk + `Cache-Control: no-store`. Why: cached net.fetch served stale mixed bundles through hot reload. (2026-09-26)
- **Splitter drag physics** — frozen start size + cumulative clientX/Y deltas on window capture; no movementX, no pointer capture. Why: remote-control input and flexbox feedback spirals. (2026-09-26)
- **Dev hot reload is opt-in** (`--watch` / `VIBESPACE_WATCH=1`), default OFF. Why: every unpackaged process watched by default, so one save bounced every open workspace's agents. (2026-09-26)
- **Ptys survive renderer reloads** — main-side ring buffer (256 KB/term) + `pty:list` attach; logo swaps and renderer crashes recover without killing agents. Why: the running process IS the agent; transcripts are a fallback, not a refresh mechanism. (2026-09-26)
- **Agent status via injected hooks** — claude launches with `--settings` injecting hooks that append `working|waiting|done` to `$VIBESPACE_TERM_STATUS`; main watches → lights, toasts, badges. Why: reading the TUI is unreliable; we own the spawn. (2026-09-26)
- **⟳ and ↻ buttons are conditional** — only render when there's actually something to restart onto (claude disk≠baseline / source fingerprint changed). Why: always-on buttons train ignoring them. (2026-09-27)
- **PATH rebuilt from the registry at boot** (machine+user, deduped, nonexistent entries dropped). Why: agent-spawned chains strip or backslash-mangle PATH (`C:Windows`); the registry is the only authoritative source. (2026-09-27)
- **Tree is live** — recursive repo watcher + rebuild preserving expansion/selection; drag-drop copies never overwrite (`name (2).ext`). Why: agents write files constantly; a snapshot tree is useless. (2026-09-27)
- **Windows-only, dependency-free renderer, no bundler.** Why: ConPTY/AUMID are the product; readability is a feature. (standing, since 2026-09-26)
- **Knowledge is tracked AS WE GO** — decisions → DECISIONS.md immediately; changes → CHANGELOG; lessons → CLAUDE.md; tasks → TODO.md; prefs/facts → agent memory. "update all docs" = run `/sync-docs`. The 📨 broadcast button is optional sugar, not the system. Why: end-of-session archaeology loses everything the moment it matters. (2026-09-28)
- **Workspaces self-claim their taskbar identity** — at window open: `setAppDetails` (AppID/icon/relaunch/name), auto-create the Start Menu shortcut, purge junk bare `Electron*.lnk`. Why: pinning a running window before its shortcut existed produced "Electron" pins; relying on users to press the launcher's Pin button first failed for 4 of 7 workspaces. (2026-09-28)
- **Picker resume pins the revived conversation** — right-click `+ Claude` → claude's `--resume` picker; the old session file that starts receiving appends gets pinned. Why: forced blank sessions + untracked `/resume` made restarts resume the wrong conversation. (2026-09-28)
