'use strict';
// Per-instance log files under ~/.vibespace/logs/ (launcher.log, <workspace-id>.log).
// Everything the main process prints is teed here, crashes are captured, and
// diagnostics() bundles versions + state + log tails into one pasteable report.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const U = require('./util.cjs');

const MAX_BYTES = 1024 * 1024; // rotate at 1 MB
let stream = null;
let currentFile = null;
let instance = 'app';

function logsDir() {
  return path.join(U.dataRoot(), 'logs');
}

function init(instanceName) {
  instance = instanceName || 'app';
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    currentFile = path.join(logsDir(), `${instance}.log`);
    try {
      const st = fs.statSync(currentFile);
      if (st.size > MAX_BYTES) {
        try { fs.unlinkSync(currentFile + '.old'); } catch {}
        fs.renameSync(currentFile, currentFile + '.old');
      }
    } catch {}
    stream = fs.createWriteStream(currentFile, { flags: 'a' });
  } catch (e) {
    stream = null;
  }

  const version = getPackageVersion();
  info(`boot — VibeSpace ${version} | instance=${instance} | electron=${process.versions.electron} | node=${process.versions.node} | ${process.platform} ${process.arch}`);

  process.on('uncaughtException', (e) => error('uncaughtException: ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (r) => error('unhandledRejection: ' + ((r && r.stack) || r)));
  return module.exports;
}

function getPackageVersion() {
  try { return require(path.join(U.ROOT, 'package.json')).version; } catch { return '?'; }
}

function write(level, msg) {
  if (!stream) return;
  try {
    const flat = String(msg).replace(/\r?\n/g, ' ⏎ ');
    stream.write(`[${new Date().toISOString()}] [${level}] ${flat}\n`);
  } catch {}
}

const info = (m) => write('info', m);
const warn = (m) => write('warn', m);
const error = (m) => write('error', m);

// mirror everything the main process prints into the log file
function teeConsole() {
  const wrap = (method, level) => {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      write(level, args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 3, maxArrayLength: 20 }))).join(' '));
      orig(...args);
    };
  };
  wrap('log', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}

function tail(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(log not found)';
  }
}

// One pasteable report: versions, workspace info, saved state, recent log lines
function diagnostics(ws) {
  const parts = [];
  parts.push(`=== VibeSpace diagnostics === ${new Date().toISOString()}`);
  parts.push(`version: ${getPackageVersion()}`);
  parts.push(`electron: ${process.versions.electron} | node: ${process.versions.node} | ${process.platform} ${process.arch}`);
  parts.push(`instance: ${instance}`);
  if (ws) {
    parts.push(`workspace: ${ws.name} (${ws.id})`);
    parts.push(`repo: ${ws.repoPath}`);
    parts.push(`icon: ${ws.iconPath}`);
  }
  try {
    if (ws) {
      const state = fs.readFileSync(path.join(U.dataRoot(), 'instances', ws.id, 'state.json'), 'utf8');
      parts.push(`state.json: ${state.replace(/\r?\n/g, ' ')}`);
    }
  } catch {}
  parts.push(`\n--- last 150 lines of ${instance}.log ---\n${tail(currentFile, 150)}`);
  if (instance !== 'launcher') {
    parts.push(`\n--- last 40 lines of launcher.log ---\n${tail(path.join(logsDir(), 'launcher.log'), 40)}`);
  }
  return parts.join('\n');
}

module.exports = { init, teeConsole, info, warn, error, logsDir, diagnostics };
