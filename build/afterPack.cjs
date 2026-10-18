'use strict';
// electron-builder afterPack hook (package.json build.afterPack). macOS only:
//  1. chmod 0755 node-pty's spawn-helper in app.asar.unpacked: the packaged copy
//     keeps the npm tarball's 0644, and every pty spawn would fail.
//  2. Ad-hoc sign the .app (codesign --force --deep -s -). electron-builder
//     26.15.3 dropped its automatic ad-hoc fallback; `mac.identity: "-"` asks it
//     to ad-hoc sign, and this is the safety net if it skips signing (it then
//     also skips afterSign, so the net has to live here, before its own step).
//     Without a sealed signature Apple Silicon refuses to run the app at all.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixSpawnHelpers } = require('../scripts/postinstall.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const ptyDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
  const fixed = fixSpawnHelpers(ptyDir);
  if (!fixed.length) throw new Error(`afterPack: no node-pty spawn-helper under ${ptyDir} (terminals would not start)`);
  console.log(`afterPack: spawn-helper made executable: ${fixed.map(f => path.relative(appPath, f)).join(', ')}`);

  if (process.platform !== 'darwin') {
    console.warn('afterPack: not on macOS, the .app is NOT signed (codesign needs a Mac)');
    return;
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`afterPack: ad-hoc signed ${appPath}`);
};
