'use strict';
// Dev hot-reload: watches the source folders and refreshes the app on save.
// - renderer/ or preload/ change  -> windows reload; live ptys SURVIVE and the
//   reloaded renderer re-attaches to them (Layer 2 — agents keep running)
// - main/ change                 -> whole app relaunches with the same args
// Opt-in: only unpackaged runs started with --watch / VIBESPACE_WATCH=1 watch anything.
const fs = require('node:fs');
const path = require('node:path');

function start({ app, BrowserWindow, ptyhost, logger, root }) {
  // opt-in since 0.3.0: previously every unpackaged process watched, so one save
  // reloaded/relaunched every open instance and interrupted all agents
  // (VIBESPACE_NO_WATCH still force-disables)
  if (app.isPackaged || process.env.VIBESPACE_NO_WATCH || !process.env.VIBESPACE_WATCH) return false;

  const dirs = {
    renderer: path.join(root, 'renderer'),
    preload: path.join(root, 'preload'),
    main: path.join(root, 'main'),
  };

  let timer = null;
  let pending = null; // 'renderer' | 'main'
  let waits = 0;

  // Layer 3: while any pty is mid-run (recent output/input), a reload/relaunch would
  // interrupt a working agent — wait for idle instead. Reloads re-attach live ptys
  // (Layer 2), but a main/ relaunch still kills everything, so it especially waits.
  const act = () => {
    const kind = pending;
    if (kind && typeof ptyhost.busyNow === 'function' && ptyhost.busyNow()) {
      waits++;
      if (waits === 1) logger.info(`dev watch: ${kind} change deferred — agents busy; will ${kind === 'main' ? 'relaunch' : 'reload'} when idle`);
      else if (waits % 15 === 0) logger.info(`dev watch: still waiting for idle agents (${waits}s)`);
      timer = setTimeout(act, 1000);
      return;
    }
    if (waits >= 1) logger.info(`dev watch: agents idle after ${waits}s — proceeding with ${kind}`);
    waits = 0;
    pending = null;
    try {
      if (kind === 'main') {
        logger.info('dev watch: main/ changed — relaunching app');
        app.relaunch({ args: process.argv.slice(1) });
        setTimeout(() => app.exit(0), 200);
      } else {
        logger.info('dev watch: renderer/ or preload/ changed — reloading windows (agents survive, renderer re-attaches)');
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.reload();
        }
      }
    } catch (e) {
      logger.error('dev watch action failed: ' + e.message);
    }
  };

  const classify = (file) => {
    const norm = file.replace(/\\/g, '/');
    if (norm.includes('/main/')) return 'main';
    if (norm.includes('/renderer/') || norm.includes('/preload/')) return 'renderer';
    return null;
  };

  for (const [name, dir] of Object.entries(dirs)) {
    try {
      fs.watch(dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const kind = classify(path.join(dir, filename));
        if (!kind) return;
        // main wins if both pend (a relaunch picks up everything anyway)
        pending = pending === 'main' ? 'main' : kind;
        clearTimeout(timer);
        timer = setTimeout(act, 400);
      });
      logger.info(`dev watch: ${name}/`);
    } catch (e) {
      logger.warn(`dev watch unavailable for ${name}: ${e.message}`);
    }
  }
  return true;
}

module.exports = { start };
