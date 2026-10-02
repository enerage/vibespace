# Garbled Claude Code TUI in VibeSpace (xterm.js 6.0 + node-pty 1.1.0 + ConPTY): research

Date: 2026-10-02. Claude Code on this machine is 2.1.287, `"tui": "fullscreen"` (alt-screen renderer), Windows 11 build 26200.

## Facts about VibeSpace's stack (checked in the repo, not guessed)

- `renderer/workspace/ui/terms.js` `TERM_OPTS`: font `"Cascadia Mono", Consolas`, `allowProposedApi: true`. Only the fit and search addons are loaded. **No WebGL addon, no canvas addon, no unicode11 or unicode-graphemes addon, no `windowsPty` option.** So xterm 6.0 uses the **DOM renderer** and its **default Unicode 6 width table**.
- `main/ptyhost.cjs`: `pty.spawn('powershell.exe', …, { useConpty: true })` with no `useConptyDll`, so it uses the **in-box Windows conhost ConPTY**, not the newer `conpty.dll`/`OpenConsole.exe` that node-pty 1.1.0 ships in `prebuilds/win32-x64/conpty/`.
- Reload re-attach replays a 256 KB tail of raw pty output (`pushBuffer` drops whole chunks from the front) into a fresh xterm, then calls `ptyResize` with the current size.

## Two local experiments (scratchpad `pt2026.cjs`, `ptemoji.cjs`, plain node + VibeSpace's node-pty)

1. **In-box ConPTY strips DEC 2026 and re-renders.** PowerShell wrote `MARK1 ESC[?2026h inside ESC[?2026l ESC[?1049h ALT ESC[?1049l MARK2`.
   - System ConPTY output: the 2026 pair was **gone**. The 1049 switch came out as conhost's own repaint: CUP home, padded rows, `ESC[K` on each line. After leaving the alt screen it **re-painted the whole main screen** (`ESC[H` … `MARK1insideMARK2`).
   - `useConptyDll: true`: the bytes came through **verbatim** (`ESC[?2026h…ESC[?2026l…ESC[?1049h…`).
   - Conclusion: on this build the in-box ConPTY is still the old "VtEngine" kind. It renders its own buffer instead of passing the app's VT through. Passthrough came with microsoft/terminal PR #17510, and DEC 2026 support with #18826. Both are in the bundled conpty.dll but not in-box here.
2. **Width disagreement on emoji.** The test wrote `MARK1 a😀b ⏺ c ✅ d`, then `CUP(5,20)`, then `X`.
   - System ConPTY collapsed the CUP: it emitted `…✅ dX`. Conhost counts 😀 and ✅ as **2 cells** each, so it decided the cursor was already at column 20 and dropped the move.
   - xterm's default `UnicodeV6.wcwidth` (node_modules/@xterm/xterm/src/common/input/UnicodeV6.ts) returns **1** for every astral code point outside the CJK planes (U+1F600) and for U+2705. So in VibeSpace the `X` lands 2 columns left of where Claude put it.
   - With the conpty.dll the CUP survives, but the emoji cells still disagree. xterm thinks they are 1 cell wide, so the glyph overlaps the next character.

## Candidates, ranked by likelihood for VibeSpace

### 1. Emoji / wide-char width mismatch: xterm Unicode 6 vs Claude + conhost (Unicode 9+). Label: **speculative (strong local evidence)**
- Claude Code's renderer counts emoji such as ✅ 🚀 😀 as 2 cells. Conhost agrees (experiment 2). VibeSpace's xterm uses the Unicode 6 table and counts them as 1.
- On any row that contains such an emoji, every cell after it is shifted left by one per emoji. Claude's frame-diff updates then write into the wrong cells. Leftover characters and "mixed up" fragments stay behind until a full repaint.
- The in-box ConPTY makes this worse: it turns absolute cursor moves into elided text runs that depend on its own widths (experiment 2).
- Same mechanism, documented for a terminal/app width disagreement: anthropics/claude-code#80475 https://github.com/anthropics/claude-code/issues/80475 (Unicode 17 emoji, fixed on Claude's side).
- xterm background: https://github.com/xtermjs/xterm.js/issues/1059 and the unicode11 addon https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11. VS Code loads it by default (`terminal.integrated.unicodeVersion: "11"`), which is one reason VS Code shows this less.
- Claude-side width fixes, all already in 2.1.287: 2.1.257, 2.1.260 and 2.1.282 in https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md. They don't help when the terminal itself counts differently.
- **How to tell:** the damage is confined to rows that contain an emoji or symbol. Text right of the emoji is offset by about 1 column per emoji. ASCII-only rows are perfect. You can reproduce it by asking Claude to print a line like `✅ done ✅ done`.
- Fix to try: load `@xterm/addon-unicode11` and set `term.unicode.activeVersion = '11'`. Optionally use `@xterm/addon-unicode-graphemes` for VS16/ZWJ sequences, but it is experimental and has an open DOM-renderer emoji regression in 6.1 betas: https://github.com/xtermjs/xterm.js/issues/5893.

### 2. Overlap / doubled characters under heavy concurrent output on Windows ConPTY. Label: **open**
- anthropics/claude-code#19637 https://github.com/anthropics/claude-code/issues/19637 (OPEN since Jan 2026, 25 comments, still reported on 2.1.181 and 2.1.198).
- One commenter (2026-07-02) has VibeSpace's exact stack: **an Electron app with xterm.js and node-pty 1.1.0 over ConPTY** (Orca).
  - Symptoms: lines drawn on top of each other, doubled letters ("docdocs"), and a column of stale tails at the right edge.
  - It happens while several agents stream at once on a CPU-saturated machine.
  - Ctrl+L restores the screen, so it is a paint bug, not data loss.
- Related open fullscreen-on-Windows paint bugs: #92678 https://github.com/anthropics/claude-code/issues/92678 (live frame outgrows the viewport, analysed in a bare ConPTY with xterm.js replay on 2.1.278) and #91198 https://github.com/anthropics/claude-code/issues/91198 (stale ConPTY size until a real resize; `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` did not cure it).
- Fixed relatives: 2.1.183 "fullscreen TUI corruption (statusline mid-screen, duplicated spinner rows, merged text) in Windows Terminal under heavy nested-subagent load"; 2.1.282 "garbled, misplaced rows in the non-fullscreen renderer".
- **How to tell:** it correlates with load (many agents streaming, CPU busy) rather than with emoji. Whole lines overlap or tails are stranded at the right edge. Ctrl+L makes it vanish instantly.

### 3. In-box ConPTY re-rendering (no passthrough, no DEC 2026) amplifying tearing and races. Label: **speculative (verified mechanism, unverified as the trigger)**
- Experiment 1 shows the in-box ConPTY drops `?2026` and rewrites output from its own buffer on its own render cadence.
  - Claude Code cannot get atomic frames through it.
  - Every resize or alt-screen switch produces a conhost repaint that interleaves with Claude's own repaint.
- Claude decides on synchronized output from env: `TERM_PROGRAM` in {vscode, Tabby, WezTerm, …}, `WT_SESSION`, or `CLAUDE_CODE_FORCE_SYNC_OUTPUT` (read from the 2.1.287 binary). VibeSpace's ptys set none of these, so Claude assumes there is no sync. Even if forced, the in-box ConPTY would strip it.
- References:
  - ConPTY passthrough rewrite: https://github.com/microsoft/terminal/pull/17510
  - DEC 2026 in conhost/WT: https://github.com/microsoft/terminal/pull/18826
  - xterm.js got DEC 2026 in 6.0: https://github.com/xtermjs/xterm.js/pull/5453. The installed 6.0.0 has it, with a 1 s safety timeout.
  - The option: node-pty `useConptyDll` https://github.com/microsoft/node-pty/pull/694
- Caveats if you switch to `useConptyDll: true`:
  - The bundled conpty sends DA1/`ESC[1t` queries at start, and the shell waits for the reply. xterm answers them through `onData`, so VibeSpace is fine, but see https://github.com/microsoft/node-pty/issues/894.
  - xterm's DEC 2026 can drop to about 1 fps under continuous animation: https://github.com/xtermjs/xterm.js/issues/6071 (open, fix PR #6073).
- **How to tell:** tearing or half-old/half-new frames during fast streaming and spinners, and right after resizes or alt-screen switches. Glyphs are correct, positions are transiently wrong, and the next frame often heals it.

### 4. Resize races (splitter drag, window resize, tab switch). Label: **known + fixed in 2.1.144 for the missed-resize case; still open for Windows stale-size variants (#91198)**
- 2.1.144: "Fixed garbled terminal output after a missed window-resize event (e.g. dragging a VS Code split-pane divider) — now self-heals on the next frame instead of requiring Ctrl+L."
- VibeSpace throttles refit to one every 120 ms during drags, and each refit is a pty resize. Two things repaint during that window: the in-box ConPTY repaints its buffer at the new size, and Claude repaints for the new size.
- Stale-size variant: #91198 https://github.com/anthropics/claude-code/issues/91198 (open; Windows, fullscreen, healed only by a real resize).
- `windowsPty` is unset in VibeSpace. That is roughly equivalent to "ConPTY with build ≥ 21376" (reflow on), and the alt screen doesn't reflow anyway, so it is low priority. See the typings comment in node_modules/@xterm/xterm/typings/xterm.d.ts near `windowsPty`.
- **How to tell:** it appears only right after a resize or drag, or after showing a hidden tab. The screen shows wrong-width wrapping (cut lines, repeated prompt boxes). A small real resize or Ctrl+L fixes it.

### 5. VibeSpace re-attach replay (renderer reload / hot reload / render-process-gone self-heal). Label: **speculative (VibeSpace-specific, from code reading)**
- The replay is the last 256 KB of raw output, cut at a chunk boundary. Three things can go wrong:
  - It can start mid-escape-sequence.
  - It usually lacks the original `ESC[?1049h` and the mode setup, so Claude's fullscreen diffs get applied to the wrong buffer.
  - It assumes the original size.
- The follow-up `ptyResize` with an unchanged size may not make Claude repaint.
- **How to tell:** it happens only right after the "Re-attached N live terminals" toast or a dev reload. The screen is a collage of old frames until Claude repaints, and Ctrl+L or a resize fixes it.
- Possible fix: after re-attach, force a repaint by nudging the size (cols-1, then back), or send Ctrl+L only when the tab is idle.

### 6. WebGL texture-atlas corruption (wrong glyphs, "matrix"/CJK-looking characters). Label: **known + fixed in 2.1.154 (Claude side); not applicable to VibeSpace today**
- anthropics/claude-code#59915 https://github.com/anthropics/claude-code/issues/59915 and #59163 https://github.com/anthropics/claude-code/issues/59163, plus duplicates #59553 and #59401: in VS Code (xterm.js WebGL), Latin text turned into fallback glyphs while layout and colours stayed right. Selecting the text repainted it correctly.
- Fixes and workarounds:
  - 2.1.152 recycles the style pool.
  - 2.1.154 caps the thinking spinner's distinct colours.
  - 2.1.157 `/terminal-setup` turns off VS Code GPU acceleration.
  - Claude 2.1.287 also ships an "atlas recorder" with a `tengu_xterm_atlas_reset` flag for proactive resets.
- Related xterm atlas LRU bug with CJK floods: https://github.com/wavetermdev/waveterm/issues/3386.
- **VibeSpace loads no WebGL or canvas addon, so it uses the DOM renderer and has no atlas.** If WebGL is ever added (SwiftShader, since GPU is off):
  - Wire `webgl.onContextLoss(() => webgl.dispose())` to fall back to DOM.
  - Call `term.clearTextureAtlas()` on visibility change.
  - Docs: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl
- **How to tell:** the glyphs themselves are wrong (other characters) while positions, colours and layout are perfect. Selecting the text fixes it.

### 7. Stuck G1 charset / combining marks (regression 2.1.141 to 2.1.143). Label: **known + fixed (closed 2026-05-22, around 2.1.144)**
- anthropics/claude-code#58905 https://github.com/anthropics/claude-code/issues/58905, reproduced on Windows 11 with a VS Code xterm.js ConPTY terminal. It was fine on 2.1.140.
- **How to tell:** the whole screen is remapped (`ShÌtÉ$Ì…` or accent marks over letters) while lines that reset the charset stay fine. It persists after Claude exits.
- 2.1.287 is far past the fix, so it is unlikely unless it has regressed.

### 8. Console code page or encoding (mojibake `â€"`, `ΓöÇ`, or CJK-looking text after 60 to 90 minutes). Label: **open / not planned (VS Code, Windows)**
- #59672 https://github.com/anthropics/claude-code/issues/59672 (CJK-looking glyphs after a long session on Windows VS Code; closed as stale) and #34247 https://github.com/anthropics/claude-code/issues/34247 (UTF-8 read as CP1252, mostly on clipboard paste between windows).
- **How to tell:** these are systematic byte-level substitutions. Every `─` becomes `ΓöÇ` and every `—` becomes `â€"`. Layout is fine, it persists for the rest of the session, and Ctrl+L doesn't fix it.

### 9. Startup terminal-query replies leaking as text. Label: **known + fixed in 2.1.269 / 2.1.272**
- #92275 https://github.com/anthropics/claude-code/issues/92275: replies to the XTVERSION and DA1 queries plus the `ESC[I` focus report get echoed above the banner (`^[[I…1;2c`).
- **How to tell:** only a few junk characters, only at startup. Fixed in the current version.

### 10. Typed input arriving out of order. Label: **speculative (no evidence found)**
- VibeSpace's input path is `term.onData` → `vs.ptyWrite` → `proc.write`. Electron IPC and the node-pty socket preserve order.
- No GitHub issue reports reordering through node-pty or ConPTY. Related input bugs are drops or garbage, not reordering:
  - ConPTY split-sequence parsing: https://github.com/microsoft/terminal/pull/16352
  - win32-input-mode leak: anthropics/claude-code#38609
  - Claude 2.1.110 dropped keystrokes after a relaunch
  - Claude 2.1.280 fixed "the prompt line staying scrambled on Windows terminals after invisible characters were removed on Enter"
  - #93372 https://github.com/anthropics/claude-code/issues/93372: a ~5 s stall on the first Enter after idle, which makes input feel late or duplicated
- **How to tell:** the scrambling is only inside the prompt input box. The submitted message (visible in the transcript and the .jsonl) is scrambled too, and Ctrl+L does NOT fix it. Paint bugs (1 to 5) leave the submitted text correct.

## Claude Code knobs that touch rendering (names confirmed in the 2.1.287 binary)

| Knob | What it does |
|---|---|
| `tui` setting / `/tui` (`fullscreen` vs classic) | Selects the renderer. Valentin runs fullscreen. Classic has its own fixed bugs (2.1.282) and the open #92678. |
| `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (2.1.132) | Opts out of the alt-screen renderer. |
| `CLAUDE_CODE_NO_FLICKER=1` (2.1.89) | Older opt-in to the alt-screen renderer. |
| `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` (2.1.129) | Forces DEC 2026. Useless through the in-box ConPTY because it strips 2026. Only meaningful with `useConptyDll: true`. |
| `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` | Undocumented. Repaints the whole alt screen each frame instead of diffs. A good A/B test for the diff-misplacement candidates (1 to 3). |
| `CLAUDE_CODE_DEBUG_REPAINTS`, `CLAUDE_CODE_FRAME_TIMING_LOG` | Undocumented diagnostics. |
| `CLAUDE_CODE_DISABLE_MOUSE` | Mouse only; does not affect rendering. |

## Suggested triage order

1. Get one screenshot and match it against the "How to tell" lines.
2. If emoji rows are involved, load the unicode11 addon. This is the cheapest and most likely fix.
3. If it is load-correlated overlap, A/B `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` against `useConptyDll: true` (plus `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1`).
4. If it only happens after a reload, add a forced repaint after re-attach.
