'use strict';
// Cross-workspace command broadcast: any workspace window can write a command to
// <dataRoot>/broadcast/cmd.txt; EVERY running workspace process watches that file
// and types the command into its own claude tabs. This is how "update all docs"
// reaches all agents in all repos from one click.
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');

let watcher = null;
let timer = null;
let lastStamp = '';
let listener = () => {};

function onData(fn) { listener = fn; }

function cmdFile() {
  return path.join(U.dataRoot(), 'broadcast', 'cmd.txt');
}

// Returns the command string (also written with a fresh stamp so repeated
// identical commands still trigger the file watcher).
function send(command) {
  const file = cmdFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = `${command}|${Date.now()}`;
  fs.writeFileSync(file, content, 'utf8');
  return command;
}

function start() {
  stop();
  fs.mkdirSync(path.dirname(cmdFile()), { recursive: true });
  try {
    watcher = fs.watch(path.dirname(cmdFile()), { persistent: false }, (event, filename) => {
      if (filename !== 'cmd.txt') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const raw = fs.readFileSync(cmdFile(), 'utf8').trim();
          const stamp = raw.slice(raw.lastIndexOf('|') + 1);
          if (!raw || stamp === lastStamp) return; // de-dupe across processes is per-process
          lastStamp = stamp;
          listener(raw.slice(0, raw.lastIndexOf('|')));
        } catch {}
      }, 400);
    });
  } catch {}
}

function stop() {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  clearTimeout(timer);
}

module.exports = { start, stop, send, onData, _cmdFile: cmdFile };
