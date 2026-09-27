'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Resolve the real claude.exe so we never need shell:true (avoids arg-escaping issues)
function claudeCommand() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return { cmd: local, shell: false };
  return { cmd: 'claude', shell: false }; // CreateProcess resolves PATH for .exe
}

function spawnClaude(args, handlers) {
  const { cmd, shell } = claudeCommand();
  try {
    return spawn(cmd, args, { shell, windowsHide: true });
  } catch {
    // last resort for .cmd installs
    return spawn(`${cmd} ${args.join(' ')}`, { shell: true, windowsHide: true });
  }
}

// Runs `claude update` and streams output lines to the caller.
// All terminals share one Claude Code install, so one update covers every agent.
function runClaudeUpdate(onLine) {
  return new Promise((resolve) => {
    const child = spawnClaude(['update'], {});
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch {}
      onLine('[vibespace] claude update timed out after 5 minutes');
      resolve(-1);
    }, 5 * 60 * 1000);
    const push = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (t) onLine(t);
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => {
      clearTimeout(timer);
      onLine(`[vibespace] failed to launch claude: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(killed ? -1 : (code ?? 0));
    });
  });
}

function claudeVersion() {
  return new Promise((resolve) => {
    const child = spawnClaude(['--version'], {});
    let out = '';
    child.stdout?.on('data', d => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
    setTimeout(() => { try { child.kill(); } catch {} resolve(out.trim() || null); }, 8000);
  });
}

// Claude Code auto-updates itself in the background; running agents keep the OLD
// version until restarted. "2.1.283 (Claude Code)" -> [2,1,283] so we can tell when
// the on-disk version no longer matches what a window's agents were started on.
function parseVersion(v) {
  if (!v) return null;
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function versionChanged(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false; // unknowable -> don't nag
  return pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2];
}

module.exports = { runClaudeUpdate, claudeVersion, _parseVersion: parseVersion, _versionChanged: versionChanged };
