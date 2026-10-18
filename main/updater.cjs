'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Resolve the real claude.exe so we never need shell:true (avoids arg-escaping issues)
function claudeCommand() {
  if (process.platform === 'darwin') return { cmd: darwinClaudePath(), shell: false };
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return { cmd: local, shell: false };
  return { cmd: 'claude', shell: false }; // CreateProcess resolves PATH for .exe
}

// macOS: the native installer's ~/.local/bin/claude (a symlink into
// ~/.local/share/claude/versions/<v>), else the first claude on PATH (rebuilt
// from the login shell at boot), else Homebrew's. No .exe/.cmd.
function darwinClaudePath() {
  const isExe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (isExe(local)) return local;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && isExe(path.join(dir, 'claude'))) return path.join(dir, 'claude');
  }
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (isExe(p)) return p;
  return 'claude'; // spawn reports ENOENT: the callers treat that as "no claude"
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

module.exports = { claudeVersion, claudeCommand, _parseVersion: parseVersion, _versionChanged: versionChanged };
