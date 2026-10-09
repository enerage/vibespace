'use strict';
// Background agents (claude 2.1.284: `claude --bg`, `claude agents --json`,
// `claude attach <id>`). Read-only listing for the agent board.
// Verified shape (2026-09-29): a JSON array of every live session on the machine,
// interactive ones included. Background entries look like
//   { pid, id: '6ce06036', cwd, kind: 'background', startedAt (ms), sessionId,
//     name (first prompt), status: 'busy'|'idle'|'waiting', state: 'working'|'done'|… }
// `id` (short) is what attach/logs/stop/rm take. `--cwd <path>` pre-filters,
// `--all` adds completed ones. A call took ~0.8 s here.
const path = require('node:path');
const { spawn } = require('node:child_process');
const U = require('./util.cjs');
const { claudeCommand } = require('./updater.cjs');

const TIMEOUT = 8000;
const ID = /^[0-9a-f]{6,64}$/i;

// pure: background sessions started at or under repoPath (case-insensitive)
function filterBg(list, repoPath) {
  if (!Array.isArray(list)) return [];
  const root = path.resolve(repoPath).toLowerCase();
  return list
    .filter(a => a && a.kind === 'background' && typeof a.cwd === 'string' && ID.test(String(a.id || '')))
    .filter(a => { const c = path.resolve(a.cwd).toLowerCase(); return c === root || c.startsWith(root + path.sep); })
    .map(a => ({
      id: String(a.id), name: String(a.name || a.id).slice(0, 120), status: a.status || null, state: a.state || null,
      startedAt: typeof a.startedAt === 'number' ? a.startedAt : null, waitingFor: a.waitingFor || null,
      sessionId: typeof a.sessionId === 'string' ? a.sessionId : null, // restore: the job that holds a saved conversation
    }))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

// → Promise<{ ok, agents, ms, error? }> — never rejects; the board shows an
// empty state on any failure (no claude, old version, slow machine)
function list(repoPath) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const { cmd } = claudeCommand();
    let out = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve({ ms: Date.now() - t0, ...r }); };
    let child;
    try {
      // cwd: a real dir even when packaged; env: process.env as-is (ONE Path key,
      // rebuilt from the registry at boot — never a spread copy with PATH added)
      child = spawn(cmd, ['agents', '--json', '--cwd', repoPath], { cwd: U.BIN_ROOT, windowsHide: true });
    } catch (e) { finish({ ok: false, agents: [], error: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, agents: [], error: 'timeout' }); }, TIMEOUT);
    child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) child.kill(); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, agents: [], error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { finish({ ok: true, agents: filterBg(JSON.parse(out), repoPath) }); } catch (e) { finish({ ok: false, agents: [], error: 'bad json' }); }
    });
  });
}

module.exports = { list, filterBg, validId: (id) => ID.test(String(id || '')) };
