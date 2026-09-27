# Research: why a VibeSpace source save is destructive, and the fix layers

Date: 2026-09-26. Question from Valentin: saving VibeSpace source while agents run
inside VibeSpace windows reloads/restarts everything — unacceptable with several
instances open. Findings from reading `main/index.cjs`, `main/devwatch.cjs`,
`main/ptyhost.cjs`, `renderer/workspace/app.js`, `renderer/workspace/ui/terms.js`.

## The exact kill chain (one save → all agents bounce)

1. **Every unpackaged process runs the watcher.** `devwatch.start()`
   (`main/index.cjs:469`) is called unconditionally; its only gates are
   `app.isPackaged || VIBESPACE_NO_WATCH` (`main/devwatch.cjs:11`). The launcher
   AND every workspace window are separate processes, all watching the same three
   folders. **N instances open = N reloads/relaunches per save.**
2. `renderer/`+`preload/` save → each process calls `ptyhost.killAll()`
   (`main/devwatch.cjs:32`) then `webContents.reload()`. `main/` save → each process
   `app.relaunch()` + exit.
3. Renderer reload destroys the xterm DOM widgets. On boot, `terms.init`
   (`renderer/workspace/ui/terms.js:86-102`) re-creates a tab per saved terminal:
   **new random termId** (`newTermId()`), new pty spawn, 900 ms wait, then types
   `claude --resume <session-id>` + Enter into the fresh shell
   (`terms.js:187-195`).
4. So the running claude process (and any agent working inside it) is killed and
   re-instantiated from the transcript `.jsonl`. Conversation survives (session
   pinning), but: the in-flight turn dies, scrollback is lost, keystrokes typed
   during rebuild are dropped.

## Key insight: the pty does not have to die

Ptys are **main-process objects** (`ptyhost` Map). They only get killed because the
renderer that hosted their xterm widget went away and the simple path is
kill-and-recreate. VS Code's terminals survive renderer reloads because the
terminal process outlives the renderer and re-attaches. We can do the same.

## Related bugs found while reading (evidence the attach protocol doesn't exist yet)

- **Logo swap leaks ptys:** `ws:updateLogo` (`main/index.cjs:351`) calls
  `win.reload()` WITHOUT `killAll()`. New renderer boots new termIds → the old
  ptys (with running claude sessions!) are orphaned: invisible, unkillable from
  UI, still burning CPU until app quit. Same class of bug, opposite sign.
- **`render-process-gone`** (`main/index.cjs:219-223`) also does killAll+reload —
  a crashed renderer nukes all agents unnecessarily.

## Fix layers (independent, stackable)

### Layer 1 — watcher opt-in instead of opt-out (S, ~20 min)
`devwatch` only starts when explicitly enabled: `--watch` CLI flag (parseArgv
already exists, `main/index.cjs:17-30`) or `VIBESPACE_WATCH=1` env. Launcher
children inherit env (`launchWorkspaceProcess` passes `process.env`,
`main/index.cjs:245`), so a watched launcher propagates to workspaces it spawns —
or start one window directly with the flag.

- Kills the N-instance problem dead: normal windows NEVER watch, so a save can
  only ever bounce the one dev window you consciously opted in.
- Docs: CLAUDE.md hot-reload section flips from "disable with NO_WATCH" to
  "enable with --watch".
- Cost: none. Risk: none. Landing it requires ONE final bounce across currently
  open instances (current watcher fires on the `main/` edit itself).

### Layer 2 — ptys survive renderer reload (M, an evening)
The real UX fix — reload becomes a visual blip, agents never notice:

1. `ptyhost`: per-term output ring buffer (~200 KB) + `list()` of live
   {termId, cwd, bornAt}; no more `killAll()` in devwatch.
2. New IPC `pty:attach`: renderer boot asks what's alive; for each, create tab
   UI bound to the EXISTING termId, `term.write(ringBuffer)` (scrollback
   restored), never spawn, never type `claude --resume` (process still running).
3. Only spawn/resume for terminals that have no live pty (true first boot).
4. Same mechanism fixes logo-swap orphans and makes `render-process-gone`
   recoverable without killing agents.
5. Gotchas: exit events missed during the boot gap (pty:list only returns live
   sessions), resize-on-attach (existing pipe works, termId stable), focus
   restore, tabs mid-rename.

### Layer 3 — busy-guard on the remaining destructive path (S, after Layer 2)
`main/` saves still relaunch the dev process (code changed — unavoidable). Guard:
defer relaunch while any pty had output/input in the last ~5 s (activity map in
ptyhost). Reload/relaunch fires when agents go idle. Polish, not a substitute.

## Recommendation

**Layer 1 + rules in CLAUDE.md now.** It's tiny, makes the multi-instance scenario
impossible, and turns every future session (including Layer 2 work) safe by
default. Layer 2 as the next feature session. Layer 3 last.

## Rules to codify (CLAUDE.md + agent memory)

- Dev hot reload is opt-in (`--watch`). An agent editing VibeSpace from inside a
  VibeSpace window must be in a non-watching window (the default after Layer 1).
- If you must land a watched-dir change while old watchers run: batch ALL writes
  into one <400 ms burst (devwatch debounce, `main/devwatch.cjs:58`), announce the
  bounce first, resume is verified working (session pinned in state.json).
- Root-level files (CHANGELOG.md, TODO.md, this file) are NOT watched — safe to
  write any time.
