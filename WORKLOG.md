# WORKLOG — overnight autonomous session, 2026-09-26 → 09-27

Boss: Valentin (asleep). Mandate: work many hours, ship Layers 2+3 + packaging + QoL,
test everything, no questions, no overengineering, stability first. Morning summary at
the bottom when done.

## Safety guarantees (verified 23:1x)

- 0 VibeSpace processes run the hot-reload watcher (`--watch` count = 0; watch is
  opt-in since 0.3.0). Saves from this session bounce nothing.
- PlacementFlow (PID 24008) + this window (PID 71080) run uninterrupted all night.
- One disposable `--watch` test instance may be spawned at the END for Layer 2 E2E,
  on a throwaway workspace, then killed. Nothing else gets `--watch`.
- Real shortcuts / registry / user data are NOT migrated (packaging is built + tested
  in a sandbox only).

## Phase checklist (updated as I go)

- [x] P0 Guardrails: process scan, this worklog
- [x] P1 Research: RESEARCH-USER-PAIN.md (14 candidates; shortlist = status lights,
      toasts, jump hotkey, per-agent diff review, last-message preview)
- [x] P2 Layer 2: ptys survive reload — ring buffer, `pty:list` attach, no-kill
      devwatch/logo/crash paths. Smoke 12/12 + E2E PROOF: claude.exe PID identical
      across a real `--watch` renderer reload (test rig: disposable instance via
      `--open-repo` + temp VIBESPACE_HOME + VIBESPACE_WATCH=1, killed after).
- [x] P3 Layer 3: busyNow guard (output+input) defers reload/relaunch. Smoke 13/13.
      Nits fixed: `\+$` PATH strip, write() activity, smoke double-7 numbering.
- [x] P4 QoL: supervision set (status hooks + lights + toasts + badge + Ctrl+Shift+U,
      chain verified live) · session picker on dead resume · tree git colors +
      ignore list + expanded-folder memory · Ctrl+P file finder · Ctrl+F terminal
      search. Smoke 16/16.
- [x] P5 Packaging: electron-builder — unpacked build + NSIS installer
      (dist\VibeSpace Setup 0.5.0.exe). PACKAGED smoke 16/16 + clean packaged
      workspace boot. Not installed; migration left for you (TODO).
- [x] P6 Final: dev smoke 16/16, both real instances never restarted
      (placementflow PID 24008 and vibespace PID 71080 — same PIDs as at start),
      zero stray test processes, docs updated.

## Decision log

- Layer 2 attach keeps saved termIds; a live pty with no saved tab still gets a
  "recovered" tab (state-loss safety net). Buffer cap 256 KB/terminal.
- Updater flow (`⟳ Update & Restart All`) still kills agents on purpose — it must
  relaunch them on the NEW claude version. Attach is not used there.
- E2E test rig pattern (reusable): temp VIBESPACE_HOME + `--open-repo` + env-
  inherited VIBESPACE_WATCH → fully isolated watched instance; verify via its log +
  CIM process tree; kill tree + rm temp after.
- Lesson: a syntax error in smoke.cjs = SILENT hang (require throws inside
  whenReady; no output at all). `node --check` before every run — added to CLAUDE.md.
- Status hooks use `claude --settings <file>` (verified: merges with user settings,
  claude 2.1.283 accepts it; test claude ran with the file and stayed alive).
  Hook words: working/waiting/done via UserPromptSubmit/PreToolUse/Notification/Stop.
- Packaging: npmRebuild:false — winpty's gyp (GetCommitHash.bat) fails without VS
  toolchain; installed prebuilds are correct (running app proves ABI match).
- Packaged-build gotcha fixed: asar paths can't be pty cwd (error 267) → U.BIN_ROOT.
- dist/ is disposable output (~530 MB with win-unpacked); delete freely.

## Morning summary

Shipped overnight, all verified (smoke 16/16 dev AND packaged; every risky change
proven with a live instance, not just unit tests):

1. **Reloads can no longer kill agents.** Renderer reload/hot-reload/logo-swap/
   crash-recovery all re-attach to live ptys (same processes, scrollback restored).
   Proven: claude.exe PID identical across a real reload. On top, the opt-in watcher
   now waits for agents to go idle before reloading/relaunching.
2. **Agent supervision** (research-backed): status lights per tab (working/waiting/
   done via injected claude hooks), Windows toast + taskbar badge when an unfocused
   agent needs you or finishes (click = focus window + tab), Ctrl+Shift+U to cycle
   attention, bold unread tabs. Chain verified live end-to-end.
3. **Daily-driver QoL:** Ctrl+P fuzzy file finder · Ctrl+F terminal search ·
   dead-session restore now opens claude's resume picker · git status colors in the
   tree (files + folders) · expanded folders remembered · bigger ignore list.
4. **Packaging:** real NSIS installer at `dist\VibeSpace Setup 0.5.0.exe`, validated
   from the packaged binary itself. NOT installed — installing + re-pointing your
   shortcuts is yours to do (TODO has the checklist).
5. Docs: CHANGELOG 0.4.0 + 0.5.0, CLAUDE.md (lessons: packaged smoke, asar/BIN_ROOT,
   hook format), TODO triaged, research in RESEARCH-USER-PAIN.md.

Your windows ran uninterrupted all night (same PIDs at 07:00 as at 23:00). To pick
up the new code, close + reopen workspaces at your leisure — sessions auto-resume.

Manual checks worth 60 seconds (things only a human can see):
- Status light round-trip: send a message in an agent tab → dot goes amber; when it
  asks permission → red pulse + (unfocused) toast; when it finishes → green.
- Ctrl+P / Ctrl+F / Ctrl+Shift+U feel.
- Install the setup exe if you want the packaged life (then TODO "Install + migrate").

Addendum (morning, 0.5.2): ↻ Restart VibeSpace button — auto-detects source changes
(fingerprint at window open, 30 s probe) and offers a one-click relaunch with
conversations resumed. First E2E attempt MISSED because the baseline was captured at
the first 30 s interval instead of at window open (changes made during boot became
the baseline) — fixed by probing in createWorkspaceWindow, then detection proven
live. Smoke 20/20. This is the permanent answer to "hot reload is off by default":
automatic detection, manual restart.

Addendum (morning, 0.5.1): Valentin pointed out the ⟳ button was always visible
even with nothing to update, and that claude auto-updates itself in the background
(both true). Now: button hidden unless the on-disk claude version differs from what
this window's agents started on (baseline at open, 5-min probe, re-baseline after a
restart-all). Smoke 18/18.

Next best work (my opinion): last-message preview per tab (S-M), per-agent diff
review in Monaco (M), editor tabs (M), then the cross-workspace overview.
