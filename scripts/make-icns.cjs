'use strict';
// Builds the macOS bundle icon (assets/app.icns) from a PNG/SVG with sharp:
//   node scripts/make-icns.cjs [src = assets/logo.png] [out = assets/app.icns]
// The ICNS container is written in JS (main/ico.cjs buildIcns), so this runs on
// Windows too; no iconutil needed. The result is committed: packaging only reads
// it (package.json build.mac.icon). Re-run after a logo change.
// macOS 26 draws icons that aren't Apple's own template on a gray plate; the
// art is clipped to a rounded square with Apple's margin, which is as close as
// a flat PNG gets (acceptable for now, see RESEARCH-MAC.md Q1 "Icons").
const path = require('node:path');
const fs = require('node:fs');
const ico = require('../main/ico.cjs');

const root = path.resolve(__dirname, '..');
const src = path.resolve(process.argv[2] || path.join(root, 'assets', 'logo.png'));
const out = path.resolve(process.argv[3] || path.join(root, 'assets', 'app.icns'));

ico.buildIcnsFromImage(src, out, { rounded: true }).then(() => {
  const buf = fs.readFileSync(out);
  console.log(`wrote ${out} (${buf.length} bytes, ${ico.ICNS_TYPES.length} entries)`);
}).catch((e) => {
  console.error('make-icns failed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
