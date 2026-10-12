# HANDOFF — state of VibeSpace work (2026-10-12)

For any agent picking up VibeSpace work, especially a **cloud session** (Linux, no
access to Valentin's PC). Read CLAUDE.md first; it is the source of truth.
This file is the short "where are we" note.

## Where things stand
- `main` is at **0.6.58**, all pushed. Smoke 136/136 on Windows.
- Shipped 2026-10-08 → 10-12 (details in CHANGELOG.md):
  - 0.6.52: process tree killed with tabs (no orphan MCP servers), Search tab
    (Ctrl+Shift+F), model picker, worktree setup command, background `git fetch`,
    per-account limit chip.
  - 0.6.53: automatic account order (soonest weekly reset first).
  - 0.6.54 / 0.6.57: internet outages wait quietly and continue by themselves
    (main thread: `continue`; subagent: one nudge to the idle main agent).
  - 0.6.55: no tab can get another tab's conversation; restore onto a background
    job; batched move toasts; `#` in setup commands; `/model` survives restart.
  - 0.6.56: effort level in the status bar. 0.6.58: Send to cloud (verified live).

## Open checks that need the Windows PC (not for cloud sessions)
See TODO.md (top section + "Internal"). Mainly: Send to cloud's Bring back /
open link / restart persistence; the next real internet drop (`net:` log lines);
automatic account moves (`account auto:`); packaged smoke for a new installer.

## Ideas Valentin wants to review before anyone builds them
Fresh installer (0.6.58), Git pane for worktree tabs, reviewing one agent turn
as a diff with comments sent back, new-agent presets. Ask him first.

## Rules for a cloud session building VibeSpace code
1. Work on a NEW branch `cloud/<topic>`; push it; never merge into `main`.
   A Windows agent reviews, runs smoke and merges.
2. You can't run the app or `npm run smoke` (ConPTY, Windows only). Write pure,
   node-testable helpers, add smoke checks, run `node --check main/*.cjs` and
   node tests of your helpers. Say exactly what you could not test.
3. Follow CLAUDE.md's ground rules (Path not PATH, path.join for Windows paths,
   writeJsonAtomic, no `-EncodedCommand`, no window.confirm/alert/prompt).
4. Docs per "How we work": CHANGELOG (new version section), DECISIONS,
   CLAUDE.md lesson bullets, TODO (with a checklist for the Windows agent).
5. Finish with: files changed, what was tested, and the Windows checklist.
