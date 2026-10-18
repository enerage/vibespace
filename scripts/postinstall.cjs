'use strict';
// npm postinstall. macOS only (a no-op everywhere else): node-pty 1.1.0 ships its
// darwin `spawn-helper` binaries as mode 0644, and every pty spawn then fails
// with an opaque "posix_spawnp failed." (node-pty #850). Make them executable.
// build/afterPack.cjs runs the same fix on the packaged copy.
const fs = require('node:fs');
const path = require('node:path');

// chmod 0755 every file named spawn-helper under dir; returns the paths fixed
function fixSpawnHelpers(dir) {
  const fixed = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name === 'spawn-helper') {
        fs.chmodSync(full, 0o755);
        fixed.push(full);
      }
    }
  };
  walk(dir, 0);
  return fixed;
}

if (require.main === module) {
  if (process.platform === 'darwin') {
    try {
      const fixed = fixSpawnHelpers(path.join(__dirname, '..', 'node_modules', 'node-pty'));
      console.log(`postinstall: spawn-helper made executable (${fixed.length}): ${fixed.join(', ') || 'none found'}`);
    } catch (e) {
      // never fail the install over it; the smoke's pty test would show it
      console.warn('postinstall: spawn-helper chmod failed: ' + (e && e.message ? e.message : e));
    }
  }
}

module.exports = { fixSpawnHelpers };
