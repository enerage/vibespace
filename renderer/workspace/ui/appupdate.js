// One-click VibeSpace self-update (main/appupdate.cjs), shared by the workspace
// window (folded into the ↻ Restart button) and the launcher (its own button).
// Main owns everything; this module only shows the state and starts the install.
// common.js only: the launcher imports this file too.
import { toast, confirmBox } from './common.js';

let view = null;
const listeners = [];

export function current() { return view; }

// cb(view) now and on every change: { enabled, current, update: { version,
// name, url } | null, busy: { phase, pct } | null, result, error }
export function watch(cb) {
  listeners.push(cb);
  if (listeners.length === 1) {
    vs.onAppUpdateState((v) => set(v));
    vs.appUpdateGet().then(set).catch(() => {});
  } else if (view) {
    cb(view);
  }
}

function set(v) {
  view = v || null;
  announce(view);
  for (const cb of listeners) { try { cb(view); } catch {} }
}

// once per version per window (sessionStorage survives a renderer reload)
function once(key) {
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch {}
  return true;
}

function announce(v) {
  if (!v || !v.enabled) return;
  if (v.update && !v.busy && once(`vs-appupdate-toast-${v.update.version}`)) {
    toast(`VibeSpace ${v.update.version} is available`, 'ok', { action: { label: 'Update', run: () => run() } });
  }
  if (v.result && once(`vs-appupdate-result-${v.result.at}`)) {
    if (v.result.ok) toast(`VibeSpace updated to ${v.result.version}`, 'ok');
    else toast(`The update to VibeSpace ${v.result.version} didn't finish (${v.result.reason || 'unknown'}). Still on ${v.current}; details in ~/.vibespace/updates/install.log`, 'err');
  }
}

// button text while an update is offered / running
export function label(v = view) {
  if (!v || !v.update) return null;
  const b = v.busy;
  if (b && b.phase === 'download') return `Downloading… ${b.pct == null ? 0 : b.pct} %`;
  if (b && b.phase === 'verify') return 'Verifying…';
  if (b && b.phase === 'install') return 'Installing…';
  if (b && b.phase === 'quit') return 'Restarting…';
  return `↻ Update to ${v.update.version}`;
}

export function tooltip(v = view) {
  if (!v || !v.update) return '';
  return [
    `VibeSpace ${v.update.version}: ${v.update.name}`,
    v.update.url ? `What's new: ${v.update.url} (right-click to open)` : '',
    `Click to update from ${v.current}: VibeSpace downloads it, checks it, and restarts every window. Agent conversations resume.`,
  ].filter(Boolean).join('\n');
}

export function openNotes() { vs.appUpdateNotes().catch(() => {}); }

// ownBusy(): names of agents working in THIS window (the workspace's pty:busy);
// the update quits every VibeSpace window, so the others are asked too.
// Confirms only when it would interrupt someone, like ↻ Restart.
export async function run(ownBusy = null) {
  const v = view;
  if (!v || !v.update || v.busy) return;
  const own = ownBusy ? await ownBusy().catch(() => []) : [];
  const others = await vs.appUpdateBusy().catch(() => []);
  const names = [...(own || []), ...(others || [])];
  if (names.length) {
    const msg = `Update VibeSpace to ${v.update.version}? Every VibeSpace window restarts.\n\n${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} working right now — ${names.length > 1 ? 'they' : 'it'} will be interrupted and resumed after the update.`;
    if (!(await confirmBox(msg, { ok: 'Update anyway' }))) return;
  }
  const r = await vs.appUpdateInstall().catch((e) => ({ ok: false, error: e.message || String(e) }));
  if (!r) return;
  if (r.manual) toast(r.message, '', { action: { label: 'OK', run: () => {} } });
  else if (!r.ok) toast(`Update failed: ${r.error}`, 'err');
  else if (r.dryRun || r.test) toast(r.message, 'ok');
}
