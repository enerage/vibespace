'use strict';
// Fingerprint of the VibeSpace source tree (dev runs only — packaged code lives in
// app.asar and never changes in place). A window computes this at boot and
// re-checks periodically; a mismatch means newer code is on disk and the window
// can offer a one-click restart. Auto-reload is deliberately opt-in (0.3.0), so
// this is the safe default: detect automatically, restart on the user's click.
const fs = require('node:fs');
const path = require('node:path');

function fingerprint(root) {
  let count = 0;
  let size = 0;
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        count++;
        size += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  walk(path.join(root, 'main'), 0);
  walk(path.join(root, 'preload'), 0);
  walk(path.join(root, 'renderer'), 0);
  return `${count}:${size}:${Math.round(newest)}`;
}

module.exports = { fingerprint };
