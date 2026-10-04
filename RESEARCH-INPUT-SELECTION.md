# Claude Code prompt input: keyboard text selection (checked 2026-10-04, local claude 2.1.288)

## Verdict

**Not supported in the prompt input itself.** The prompt input has no selection state of its own
(no anchor). Shift+Arrow, Ctrl+Shift+Arrow and Shift+Home/End do not start a selection, and
nothing can be rebound to do it: no `Chat` action for selection exists.

**Partial workaround, fullscreen renderer only** (`/tui fullscreen` or `CLAUDE_CODE_NO_FLICKER=1`):
- Start a selection with the MOUSE (drag, double-click = word, triple-click = line). This is a
  screen-cell selection over the whole UI, not a text-aware input selection.
- Then Shift+Left/Right/Up/Down and Shift+Home/End EXTEND it (`selection:extend*`, `Scroll` context).
- Ctrl+C (while a selection exists), Ctrl+Shift+C or Cmd+C copy it; copy-on-select is on by default.
- **Backspace / Delete (no modifiers) delete the selected range when it lies inside the prompt
  input** (`InputSelectionBridge.tryDelete` in the 2.1.288 binary; it maps screen rows/cols back
  to text offsets). It is undocumented; the 2.1.186 changelog line "Fixed mouse-selected text staying
  highlighted after deleting it in `claude agents`" shows it already existed by then.
- There is no cut. Typing over a selection does NOT replace it: any other key clears the selection
  and then types normally.
- Vim mode (`/config` → Editor mode) has real text-aware selection: `v` / `V` visual mode and `d`, `y`,
  `c`, `p`. This is the only text-aware selection in the prompt input.

## What the prompt input does with modified arrows (binary, text-input key handler)

The key parser decodes xterm modifier sequences (`ESC[1;2D` = Shift+Left, `ESC[1;5D` = Ctrl+Left,
`ESC[1;6D` = Ctrl+Shift+Left, `ESC[1;2H` / `ESC[1;2F` = Shift+Home/End) into `{name, shift, ctrl, meta}`.
The input handler then does this:

| Key | Prompt input behaviour |
|---|---|
| Shift+Left / Shift+Right | shift ignored: moves the cursor 1 char (classic). In fullscreen it is first offered to the `Scroll` binding `selection:extendLeft/Right`, which only acts when a selection exists. |
| Ctrl+Shift+Left/Right (`ESC[1;6D/C`) | treated as Ctrl+Left/Right = `backwardWord` / `forwardWord`. Nothing is selected. |
| Shift+Up / Shift+Down | `if (shift||ctrl||meta) return;` = nothing in the input. In fullscreen it extends an existing selection. |
| Shift+Home / Shift+End | Home/End only bail on Ctrl, so the shift variant = startOfLine / endOfLine. In fullscreen it extends an existing selection. |
| Backspace/Delete with a fullscreen selection over the input | deletes the selected text range |

Issues #80734 and #93978 report that these keys "do nothing" for selection, which matches: no
selection starts from the keyboard.

## Keybindings (`~/.claude/keybindings.json`)

All registered `select*` actions in 2.1.288, extracted from the binary:
- `selection:copy` (Ctrl+Shift+C, Cmd+C), `selection:clear` (unbound, 2.1.234+),
  `selection:extendLeft/Right/Up/Down` (Shift+arrows), `selection:extendLineStart/LineEnd`
  (Shift+Home/End). All of these are in the `Scroll` context (fullscreen only).
- `select:*` = list navigation (next/previous/accept…); `messageSelector:*` = legacy aliases.
- There is NO `selectWordLeft`, `chat:select*`, `input:select*`, cut or delete-selection action.
- Word-wise extension (`selectWordLeft`) does not exist anywhere. Unknown action names are skipped
  with a debug-log warning.
- The `Chat` context has no cursor-movement actions at all (also see #94909: Home/End
  can't be rebound to line navigation).

Default `Scroll` block from the binary:
```
{context:"Scroll",bindings:{pageup:"scroll:pageUp",pagedown:"scroll:pageDown",wheelup:"scroll:lineUp",
 wheeldown:"scroll:lineDown","ctrl+home":"scroll:top","ctrl+end":"scroll:bottom",
 "ctrl+shift+c":"selection:copy","cmd+c":"selection:copy","shift+left":"selection:extendLeft",
 "shift+right":"selection:extendRight","shift+up":"selection:extendUp","shift+down":"selection:extendDown",
 "shift+home":"selection:extendLineStart","shift+end":"selection:extendLineEnd"}}
```

## Changelog milestones (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- 2.1.113: "Fullscreen mode: Shift+↑/↓ now scrolls the viewport when extending a selection past the
  visible edge" (Shift-extend existed before this).
- 2.1.186: fixed mouse-selected text staying highlighted after deleting it (claude agents).
- 2.1.234: added `selection:clear`. Esc no longer clears a mouse selection.
- 2.1.239: fixed `selection:copy` dropping a selection extended with Shift+Arrow.
- No entry adds keyboard-started selection, cut, or type-to-replace in the prompt input.

## Docs
- https://code.claude.com/docs/en/keybindings: Scroll actions table (selection:*), "Conversation
  scrolling and text selection in fullscreen mode". No Chat selection actions.
- https://code.claude.com/docs/en/fullscreen#use-the-mouse: "With a selection active, hold Shift and press
  the arrow keys to extend it…"; "If you have a selection active, Ctrl+c copies instead of
  cancelling". Any other key (plain arrows, Enter, typed characters) clears the selection.
- https://code.claude.com/docs/en/interactive-mode: editing keys (Ctrl+W, Alt+B/F/D, Ctrl+Y, Ctrl+K/U),
  vim visual mode `v`/`V`. No keyboard selection.

## GitHub issues (anthropics/claude-code)
| Issue | Status | Note |
|---|---|---|
| [#80734](https://github.com/anthropics/claude-code/issues/80734) Chat input has no text selection: shift+arrow, shift+home/end, ctrl+shift+arrow all do nothing | OPEN (area:tui), 2026-07-24 | the canonical report; a Windows user +1 |
| [#87817](https://github.com/anthropics/claude-code/issues/87817) text selection in chat input with shift+arrow and delete | OPEN, labelled `stale`, platform:windows | asks for anchor, Backspace/Delete removes range, typing replaces |
| [#93978](https://github.com/anthropics/claude-code/issues/93978) Keyboard text selection in the prompt input (Shift+Arrow, Cmd+Shift+Arrow) | OPEN, labelled `duplicate` (so likely auto-closed soon) | filed as the "focused issue" #27561's close asked for; verified on 2.1.270 fullscreen |
| [#97985](https://github.com/anthropics/claude-code/issues/97985) standard text-editing model for the prompt input (selection, cut/copy/paste, word nav) | OPEN, enhancement, 2026-09-28 | lists the history of closed duplicates; the addendum notes plain xterm modifier encoding suffices |
| [#92287](https://github.com/anthropics/claude-code/issues/92287) NVDA: can't select text in the prompt box | OPEN, a11y, Windows | |
| [#94909](https://github.com/anthropics/claude-code/issues/94909) Home/End jump to buffer start/end; Chat has no line-navigation actions | OPEN, bug | related |
| [#27561](https://github.com/anthropics/claude-code/issues/27561) Modern text input: click-to-position, selection, standard editing | CLOSED completed 2026-08-17 | bcherny: "Most of this is available in fullscreen rendering mode… click-and-drag to select text…"; open a focused issue for anything missing |
| [#23396](https://github.com/anthropics/claude-code/issues/23396) Shift+Arrow selection in chat input | CLOSED as duplicate of #14789 | |
| [#14789](https://github.com/anthropics/claude-code/issues/14789) standard text-editing shortcuts in PowerShell | CLOSED not planned 2026-03-13 | |
| [#63058](https://github.com/anthropics/claude-code/issues/63058) word-jump actions bindable | CLOSED not planned (stale) | |
| [#81472](https://github.com/anthropics/claude-code/issues/81472) META copy/paste tracking | OPEN | |

## Implications for VibeSpace
- If VibeSpace wants Shift+Arrow selection in the claude prompt, Claude won't do it. Sending
  `ESC[1;2D` etc. just moves the cursor (classic) or does nothing until a mouse selection exists (fullscreen).
- Achievable today in fullscreen: the user mouse-drags in xterm (claude has mouse tracking on), then
  Shift+arrows extend and Backspace deletes; Ctrl+C copies. That covers delete and copy, but there is
  no keyboard start, no cut and no type-to-replace.
- Emulating it client-side (VibeSpace tracks a selection over the input line and sends N×Backspace)
  is possible but fragile, because VibeSpace can't know claude's input buffer/cursor exactly.
