'use strict';
// Base-status arbitration between the status files (hooks → status.cjs, the
// source of truth) and the claude data feed's instant "needs you" signal.
//
// The permission_prompt Notification — the only hook that writes `waiting` —
// comes ~6 s after the dialog opens (claude's "user is away" logic). The feed's
// PermissionRequest (or AskUserQuestion PreToolUse) arrives ~0.1 s after it. So
// main flips the base status to `waiting` at once through an in-memory OVERRIDE
// (never by writing the hook-owned files) and hands it back when the tool runs.
// Pure per-term state machine; index.cjs applies the returned status through the
// same path the file listener uses (lights, toasts, badge, busy check).
//
//   term = { status, override, ask, turnEndedAt }   (created by newTerm)
//   → { apply: status | null, notify: boolean }

const ASK = new Set(['permission', 'question']);

function newTerm() {
  return { status: null, override: false, ask: false, turnEndedAt: null, before: null };
}

// a status-file line (working | waiting | done)
function fileStatus(t, st) {
  // PreToolUse's `working` line is written by a Git Bash hook that can land
  // AFTER the feed's PermissionRequest: while the dialog is still open (feed
  // says so), that stale line must not turn the red light back to amber
  if (t.override && t.ask && st === 'working') return { apply: null, notify: false };
  t.override = false;
  const changed = st !== t.status;
  t.status = st;
  // toasts fire once per episode: the late permission_prompt `waiting` after
  // the instant one is not a new episode
  return { apply: st, notify: changed };
}

// a feed snapshot for this term
function feedState(t, feed) {
  const ask = Boolean(feed && !feed.failure && ASK.has(feed.attention));
  if (ask && !t.ask) {
    t.ask = true;
    t.turnEndedAt = (feed && feed.turnEndedAt) || null;
    t.before = t.status; // what to hand back: a background subagent can ask AFTER the turn ended
    if (t.status === 'waiting') return { apply: null, notify: false }; // already red
    t.status = 'waiting';
    t.override = true;
    return { apply: 'waiting', notify: true };
  }
  if (!ask && t.ask) {
    t.ask = false;
    t.override = false;
    // red because of this ask (instant override, or the late Notification line
    // that took it over): the dialog is answered, so hand back `working`
    if (t.status !== 'waiting') return { apply: null, notify: false };
    // the turn ended (Stop) while we held it: the Stop hook's `done` line is on
    // its way — never clobber it with `working`
    if (((feed && feed.turnEndedAt) || null) !== t.turnEndedAt) return { apply: null, notify: false };
    // the tool was approved/answered and runs now. If the ask came from a
    // background subagent while the tab was already `done`, it goes back to
    // `done` (the main turn is still over), not to `working`
    t.status = t.before === 'done' ? 'done' : 'working';
    return { apply: t.status, notify: false };
  }
  return { apply: null, notify: false };
}

module.exports = { newTerm, fileStatus, feedState };
