// Keyboard text selection in Claude Code's prompt: Shift+←/→, Ctrl+Shift+←/→
// (by word; Option on a Mac), Shift+Home/End. Then Backspace/Delete removes
// the selection, Ctrl+C copies it, and typing replaces it.
//
// Claude Code (2.1.289) has no keyboard-STARTED selection in its input
// (anthropics/claude-code#80734): Shift+arrows just move the caret. In
// fullscreen mode it does have a mouse selection, and once one exists it
// extends it on Shift+arrows and deletes it on Backspace. So we start one for
// it: a synthetic two-cell mouse drag at the caret (SGR mouse codes written to
// the pty), trimmed to one cell with Shift+←. All of this was verified live;
// none of it is documented, so every step is guarded and falls back to passing
// the key through untouched.
//
// Facts this relies on (re-check them when it breaks after a Claude update):
//   - the terminal cursor sits on Claude's caret;
//   - the prompt is the block of rows between two '─' border rows, text from col 2;
//   - press+move+release in ONE write selects the cells inclusive; a drag does
//     not move the caret; a press+release on one cell is a click (clears the
//     selection and puts the caret there);
//   - Shift+←/→ move the selection's focus end by one cell; Esc does NOT clear.
//
// On a Mac the keys follow its text fields: Option+Shift+←/→ by word (Ctrl
// arrows belong to macOS Spaces there), Cmd+Shift+←/→ to the line's start/end,
// Shift+Home/End as everywhere.

import { isMac } from './common.js';

const CSI = '\x1b[';
const SHIFT_LEFT = CSI + '1;2D';
const SHIFT_RIGHT = CSI + '1;2C';
const TEXT_START = 2;   // "❯ " gutter
const MAX_SCAN = 40;    // rows to look for the prompt's borders

const states = new WeakMap(); // term -> { row, origin, count } (count < 0: cells left of the caret)

const mouse = (code, col, row, up) => `${CSI}<${code};${col + 1};${row + 1}${up ? 'm' : 'M'}`;
const drag = (from, to, row) => mouse(0, from, row) + mouse(32, to, row) + mouse(0, to, row, true);
const click = (col, row) => mouse(0, col, row) + mouse(0, col, row, true);

// Claude copies a mouse selection when the button is released (copyOnSelect,
// via PowerShell Set-Clipboard, ~0.5-1 s later), so our synthetic two-cell drag
// put those 2 characters on the user's clipboard (found 2026-10-13). Keep what
// was there and put it back once Claude's copy lands. Only a clipboard that
// turned into exactly the dragged characters is restored: anything else is the
// user's own copy (e.g. Ctrl+C on the selection) and is left alone.
// Text only: an image on the clipboard can't be read back here.
const GUARD_MS = 3000;
let guard = null; // { saved, expect, until }
const same = (a, b) => String(a).trim() === String(b).trim();
async function guardClipboard(expect) {
  const api = globalThis.vs;
  if (!api || !api.readClipboard || !api.writeClipboard) return;
  if (guard) { guard.until = Date.now() + GUARD_MS; guard.expect.push(expect); return; } // keep the ORIGINAL clipboard
  const g = { saved: null, expect: [expect], until: Date.now() + GUARD_MS };
  guard = g;
  try { g.saved = await api.readClipboard(); } catch { guard = null; return; }
  const tick = async () => {
    if (guard !== g) return;
    if (Date.now() > g.until) { guard = null; return; }
    let now;
    try { now = await api.readClipboard(); } catch { guard = null; return; }
    if (now !== g.saved) {
      guard = null;
      if (g.saved && g.expect.some(e => same(now, e))) { try { await api.writeClipboard(g.saved); } catch {} }
      return;
    }
    setTimeout(tick, 120);
  };
  setTimeout(tick, 120);
}

export function reset(term) { states.delete(term); }

// The prompt row under the caret, or null when the caret isn't in Claude's prompt.
function promptRow(term) {
  let enc = null;
  try { enc = term._core.coreMouseService.activeEncoding; } catch {}
  if (enc !== 'SGR' || term.modes.mouseTrackingMode === 'none') return null;
  const buf = term.buffer.active;
  if (buf.viewportY !== buf.baseY) return null; // scrolled back: rows no longer match the screen
  const y = buf.baseY + buf.cursorY;
  const isBorder = (i) => { const l = buf.getLine(i); return Boolean(l) && l.translateToString(true).startsWith('──'); };
  let top = -1, bottom = -1;
  for (let i = y - 1; i >= Math.max(0, y - MAX_SCAN); i--) if (isBorder(i)) { top = i; break; }
  for (let i = y + 1; i <= y + MAX_SCAN; i++) if (isBorder(i)) { bottom = i; break; }
  if (top < 0 || bottom < 0 || isBorder(y)) return null;
  const line = buf.getLine(y);
  let text = line.translateToString(true);
  if ([...text].length !== text.length) return null; // astral chars (emoji): cells ≠ string indexes
  for (let x = 0; x < text.length; x++) if (line.getCell(x)?.getWidth() !== 1) return null; // wide chars: same
  // Claude doesn't draw trailing spaces, so after "word " the caret sits past the
  // trimmed text. Those cells are the typed spaces: count them as text, or the
  // caret reads as "outside the prompt" and the key falls through to a caret move.
  if (buf.cursorX > text.length) text = text.padEnd(buf.cursorX, ' ');
  return { row: buf.cursorY, caret: buf.cursorX, line, text, end: Math.max(text.length, TEXT_START), cols: term.cols };
}

// Claude paints its selection with a background colour (the caret is inverse).
function selectionShown(p, from, to) {
  for (let x = from; x <= to; x++) {
    const c = p.line.getCell(x);
    if (c && (c.getBgColorMode() !== 0 || c.isInverse())) return true;
  }
  return false;
}

function wordLeft(text, b) {
  let i = Math.min(b, text.length);
  while (i > TEXT_START && /\s/.test(text[i - 1] || ' ')) i--;
  while (i > TEXT_START && !/\s/.test(text[i - 1] || ' ')) i--;
  return i;
}
function wordRight(text, b, end) {
  let i = b;
  while (i < end && !/\s/.test(text[i] || ' ')) i++;
  while (i < end && /\s/.test(text[i] || ' ')) i++;
  return i;
}

// The key sequence that takes the selection from `old` cells to `next` cells.
function steps(p, old, next) {
  let seq = '';
  if (old !== 0 && (next === 0 || Math.sign(next) !== Math.sign(old))) { seq += click(p.caret, p.row); old = 0; }
  if (next === 0) return seq;
  const dir = Math.sign(next);
  if (old === 0) {
    // two cells by drag (one cell would be a click), then Shift+← trims it to one
    seq += (dir < 0 ? drag(p.caret - 1, p.caret, p.row) : drag(p.caret, p.caret + 1, p.row)) + SHIFT_LEFT;
    old = dir;
  }
  const grow = Math.abs(next) - Math.abs(old);
  const key = (grow > 0) === (dir < 0) ? SHIFT_LEFT : SHIFT_RIGHT;
  return seq + key.repeat(Math.abs(grow));
}

// xterm custom key handler hook. Returns true when the key was handled here
// (the caller must then swallow it); false = not ours, handle as usual.
export function onKey(term, ev, send) {
  if (ev.type !== 'keydown') return false;
  const k = ev.key;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return false;

  const mac = isMac();
  const arrow = k === 'ArrowLeft' || k === 'ArrowRight';
  const isSelKey = mac
    ? ev.shiftKey && !ev.ctrlKey && ((arrow && !(ev.altKey && ev.metaKey)) || ((k === 'Home' || k === 'End') && !ev.altKey && !ev.metaKey))
    : ev.shiftKey && !ev.altKey && !ev.metaKey
      && (k === 'ArrowLeft' || k === 'ArrowRight' || ((k === 'Home' || k === 'End') && !ev.ctrlKey));
  let st = states.get(term);

  if (!isSelKey) {
    // typing over our selection replaces it: Backspace deletes the selection, then the key types
    if (st && st.count !== 0 && k.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      const p = promptRow(term);
      if (p && p.row === st.row && p.caret === st.origin) {
        const from = st.count < 0 ? st.origin + st.count : st.origin;
        const to = st.count < 0 ? st.origin - 1 : st.origin + st.count - 1;
        if (selectionShown(p, from, to)) send('\x7f');
      }
    }
    states.delete(term);
    return false;
  }

  const p = promptRow(term);
  if (!p || p.caret < TEXT_START || p.caret > p.end) { states.delete(term); return false; }
  if (!st || st.row !== p.row || st.origin !== p.caret) st = { row: p.row, origin: p.caret, count: 0 };

  const b = p.caret + st.count; // the moving end of the selection
  let target;
  const byWord = mac ? ev.altKey : ev.ctrlKey;
  if (mac && arrow && ev.metaKey) target = k === 'ArrowLeft' ? TEXT_START : p.end; // Cmd: line start/end
  else if (k === 'ArrowLeft') target = byWord ? wordLeft(p.text, b) : b - 1;
  else if (k === 'ArrowRight') target = byWord ? wordRight(p.text, b, p.end) : b + 1;
  else target = k === 'Home' ? TEXT_START : p.end;
  target = Math.max(TEXT_START, Math.min(p.end, target));

  const next = target - p.caret;
  // a rightward start needs the cell after the caret for the drag
  if (next > 0 && st.count <= 0 && p.caret + 1 > p.cols - 1) return true;
  const seq = steps(p, st.count, next);
  if (seq) send(seq);
  // a drag (move code 32) makes Claude copy the two dragged cells: protect the clipboard
  if (seq && seq.includes(CSI + '<32;')) {
    const a = next < 0 ? p.caret - 1 : p.caret;
    guardClipboard(p.text.padEnd(a + 2, ' ').slice(a, a + 2));
  }
  st.count = next;
  states.set(term, st);
  return true;
}
