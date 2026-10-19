'use strict';
// Smoke tests for the packaged self-update (main/appupdate.cjs), called from
// smoke.cjs with its check(). Runs inside the smoke's throwaway VIBESPACE_HOME.
//   every platform: semver, digests, asset selection, the state file, the
//                   helper scripts' text (quoting), check + ETag + download +
//                   resume + verify against a local feed
//   darwin:         an END-TO-END swap of a fake VibeSpace.app in a temp folder
//                   (zip → ditto → codesign/Info.plist checks → the real helper
//                   script) + the dmg unpack path. Never touches the running app.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const U = require('./util.cjs');
const au = require('./appupdate.cjs');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = async function appUpdateSmoke(check) {
  // 1. versions + digests
  const sv = {
    order: au.cmpSemver('0.7.10', '0.7.9') === 1 && au.cmpSemver('v1.0.0', '0.99.99') === 1
      && au.cmpSemver('0.7.0', 'v0.7.0') === 0 && au.cmpSemver('0.6.51', '0.7.0') === -1,
    junk: Number.isNaN(au.cmpSemver('0.7.1-beta.1', '0.7.0')) && au.parseSemver('0.7') === null
      && au.parseSemver(null) === null && au.parseSemver(' v2.3.4 ').join('.') === '2.3.4',
    digest: au.parseDigest('sha256:' + 'AB'.repeat(32)) === 'ab'.repeat(32) && au.parseDigest('sha512:' + 'a'.repeat(64)) === null
      && au.parseDigest('sha256:abc') === null && au.parseDigest(undefined) === null,
  };
  check('app update: semver compare + sha256 digest parsing', Object.values(sv).every(Boolean), JSON.stringify(sv));

  // 2. asset selection (GitHub's own JSON shape)
  const A = (name, size = 10) => ({ name, browser_download_url: `https://github.com/enerage/vibespace/releases/download/x/${name}`, size, digest: 'sha256:' + 'c'.repeat(64) });
  const macAll = (v) => [A(`VibeSpace-${v}-arm64-mac.zip`), A(`VibeSpace-${v}-arm64-mac.zip.blockmap`), A(`VibeSpace-${v}-arm64.dmg`),
    A(`VibeSpace-${v}-mac.zip`), A(`VibeSpace-${v}.dmg`), A('latest-mac.yml')];
  const gh = [
    // the list is by date, not version: a backport published later comes first,
    // and a release published with latest=false is just another entry
    { tag_name: 'v0.6.60', name: 'backport', draft: false, prerelease: false, html_url: 'https://github.com/enerage/vibespace/releases/tag/v0.6.60', assets: [A('VibeSpace.Setup.0.6.60.exe'), ...macAll('0.6.60')] },
    { tag_name: 'v0.9.0', draft: true, prerelease: false, assets: [A('VibeSpace.Setup.0.9.0.exe'), ...macAll('0.9.0')] },
    { tag_name: 'v0.8.0-beta.1', draft: false, prerelease: false, assets: macAll('0.8.0-beta.1') },
    { tag_name: 'v0.8.0', draft: false, prerelease: true, assets: [A('VibeSpace.Setup.0.8.0.exe'), ...macAll('0.8.0')] },
    { tag_name: 'v0.7.3', name: 'Windows only', draft: false, prerelease: false, assets: [A('VibeSpace.Setup.0.7.3.exe'), A('VibeSpace.Setup.0.7.3.exe.blockmap'), A('latest.yml')] },
    { tag_name: 'v0.7.2', name: 'Mac dmg only (like 0.7.0 shipped)', draft: false, prerelease: false, assets: [A('VibeSpace-0.7.2-arm64.dmg'), A('VibeSpace-0.7.2.dmg')] },
    { tag_name: 'v0.7.1', name: 'zip + dmg', draft: false, prerelease: false, html_url: 'https://github.com/enerage/vibespace/releases/tag/v0.7.1', assets: macAll('0.7.1') },
    { tag_name: 'v0.7.0', draft: false, prerelease: false, assets: [A('VibeSpace-0.7.0-arm64.dmg')] },
    { tag_name: 'nightly', assets: [] }, null, 'junk',
  ];
  const rel = au.compactReleases(gh);
  const show = (u) => (u ? `${u.version}:${u.assets.map(a => a.name).join('+')}` : null);
  const pick = (list, cur, plat, arch) => show(au.pickUpdate(list, cur, plat, arch));
  const no072 = rel.filter(r => r.version !== '0.7.2');
  const sel = {
    compact: rel.map(r => r.version).join(',') === '0.7.3,0.7.2,0.7.1,0.7.0,0.6.60' && rel.every(r => r.assets.every(a => a.sha256 === 'c'.repeat(64))),
    macArm: pick(rel, '0.7.0', 'darwin', 'arm64') === '0.7.2:VibeSpace-0.7.2-arm64.dmg',
    macX64: pick(rel, '0.7.0', 'darwin', 'x64') === '0.7.2:VibeSpace-0.7.2.dmg',
    zipFirst: pick(no072, '0.7.0', 'darwin', 'arm64') === '0.7.1:VibeSpace-0.7.1-arm64-mac.zip+VibeSpace-0.7.1-arm64.dmg'
      && pick(no072, '0.7.0', 'darwin', 'x64') === '0.7.1:VibeSpace-0.7.1-mac.zip+VibeSpace-0.7.1.dmg',
    win: pick(rel, '0.7.0', 'win32', 'x64') === '0.7.3:VibeSpace.Setup.0.7.3.exe',
    winBuilderName: (au.pickAssets([{ name: 'VibeSpace Setup 1.2.3.exe', url: 'https://x/y' }], '1.2.3', 'win32', 'x64')[0] || {}).name === 'VibeSpace Setup 1.2.3.exe',
    winNot10: au.pickAssets([{ name: 'VibeSpace.Setup.0.7.10.exe', url: 'https://x/y' }], '0.7.1', 'win32', 'x64').length === 0,
    upToDate: pick(rel, '0.7.3', 'win32', 'x64') === null && pick(rel, '0.7.2', 'darwin', 'arm64') === null && pick(rel, '1.0.0', 'darwin', 'x64') === null,
    noAsset: pick(rel, '0.7.0', 'linux', 'x64') === null && pick(rel, '0.7.0', 'darwin', 'ia32') === null && pick(rel, '0.6.0', 'win32', 'ia32') === null,
    meta: (() => { const u = au.pickUpdate(no072, '0.7.0', 'darwin', 'arm64'); return u.name === 'zip + dmg' && u.url === 'https://github.com/enerage/vibespace/releases/tag/v0.7.1' && u.asset.kind === 'zip' && u.assets[1].kind === 'dmg'; })(),
  };
  check('app update: asset selection per platform/arch (drafts, prereleases, latest=false, missing assets)', Object.values(sel).every(Boolean), JSON.stringify(sel));

  // 3. the shared state file
  const empty = { v: 1, feed: null, etag: null, checkedAt: null, attemptAt: null, error: null, releases: [], install: null, reopen: null, result: null };
  const kept = au.normalizeState({
    releases: rel,
    install: { id: 'i1', version: '0.7.1', from: '0.7.0', execPath: '/A/VibeSpace.app/Contents/MacOS/VibeSpace', at: 5, by: 9 },
    reopen: { workspaces: ['a', 7, '', 'b'], launcher: 1, from: '0.7.0', to: '0.7.1', execPath: '/x', at: 6 },
    result: { ok: true, version: '0.7.1', from: '0.7.0', at: 7 },
  });
  let disk = null;
  try {
    au.patchState({ checkedAt: 123, etag: '"e0"' });
    au.patchState({ attemptAt: 456 });
    const raw = JSON.parse(fs.readFileSync(au.stateFile(), 'utf8'));
    disk = raw.checkedAt === 123 && raw.attemptAt === 456 && raw.etag === '"e0"' && raw.v === 1 && Array.isArray(raw.releases);
    au.patchState({ checkedAt: null, attemptAt: null, etag: null });
  } catch (e) { disk = e.message; }
  const shape = {
    defaults: JSON.stringify(au.normalizeState(null)) === JSON.stringify(empty),
    junk: JSON.stringify(au.normalizeState({ releases: 'x', install: { id: 'a' }, reopen: [], result: { ok: 1 }, checkedAt: 'now', etag: 5 })) === JSON.stringify(empty),
    kept: kept.releases.length === 5 && kept.install.id === 'i1' && kept.install.by === 9 && kept.reopen.workspaces.join(',') === 'a,b'
      && kept.reopen.launcher === true && kept.result.ok === true && kept.releases[0].assets[0].sha256 === 'c'.repeat(64),
    disk,
  };
  check('app update: app-update.json shape (defaults, junk dropped, records kept, atomic patch)', Object.values(shape).every(v => v === true), JSON.stringify(shape));

  // 4. helper script text: quoting of paths with spaces and apostrophes
  const tgt = "/Users/a b/Apps it's/VibeSpace.app";
  const sh = au.macInstallScript({ target: tgt, source: '/Users/a b/.vibespace/updates/0.7.1/app/VibeSpace.app', version: '0.7.1',
    log: '/Users/a b/.vibespace/updates/install.log', result: '/Users/a b/r', pids: [12, '34', -1, 'x', 12], cleanup: '/Users/a b/.vibespace/updates/0.7.1' });
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  const ps = au.winInstallScript({ installer: "C:\\Users\\O'Brien\\.vibespace\\updates\\0.7.1\\VibeSpace.Setup.0.7.1.exe", sha256: 'c'.repeat(64),
    installDir: 'C:\\Program Files\\VibeSpace\\', version: '0.7.1', log: 'C:\\l.log', result: 'C:\\r', pids: [5], perMachine: true });
  const txt = {
    target: sh.includes(`TARGET='/Users/a b/Apps it'\\''s/VibeSpace.app'`) && sh.includes(`OLD='/Users/a b/Apps it'\\''s/VibeSpace.app.old-0.7.1'`),
    pids: sh.includes("PIDS='12 34'") && sh.includes('RELAUNCH=1'),
    fixedMatch: sh.includes('grep -F -- "$TARGET/Contents/"') && !/pgrep/.test(sh),
    steps: sh.includes('xattr -dr com.apple.quarantine "$TARGET"') && sh.includes('open -n "$TARGET" --args --relaunch-after-update') && sh.includes('/bin/mv "$OLD" "$TARGET"'),
    rejects: throws(() => au.macInstallScript({ target: 'rel/VibeSpace.app', source: '/s', version: '0.7.1', log: '/l', result: '/r' }))
      && throws(() => au.macInstallScript({ target: '/A/VibeSpace.app', source: '/s', version: '0.7', log: '/l', result: '/r' }))
      && throws(() => au.winInstallScript({ installer: 'x.exe', installDir: 'C:\\A', version: '0.7.1', log: 'l', result: 'r' })),
    bundle: au.bundleFromExecPath('/Applications/My Apps/VibeSpace.app/Contents/MacOS/VibeSpace') === '/Applications/My Apps/VibeSpace.app'
      && au.bundleFromExecPath('C:\\Program Files\\VibeSpace\\VibeSpace.exe') === null && au.bundleFromExecPath('/usr/bin/node') === null,
    ps: ps.includes("$Installer = 'C:\\Users\\O''Brien\\.vibespace\\updates\\0.7.1\\VibeSpace.Setup.0.7.1.exe'")
      && ps.includes("$InstallDir = 'C:\\Program Files\\VibeSpace'") && ps.includes("$Mode = '/allusers'") && ps.includes('$Pids = @(5)')
      && ps.includes("'/S ' + $Mode + ' /D=' + $InstallDir") && !/EncodedCommand/i.test(ps) && ps.includes("-ArgumentList '--relaunch-after-update'"),
  };
  // and the text really parses where it runs
  if (process.platform === 'darwin') {
    const r = cp.spawnSync('/bin/sh', ['-n'], { input: sh, encoding: 'utf8', timeout: 10000 });
    txt.shParses = r.status === 0 || (r.stderr || '').trim();
  }
  if (process.platform === 'win32') {
    const acc = require('./accounts.cjs');
    const wf = path.join(U.dataRoot(), 'appupdate-smoke.ps1');
    fs.writeFileSync(wf, '\ufeff' + ps);
    const parsed = await new Promise((resolve) => {
      const cmd = '$t = [IO.File]::ReadAllText($env:VS_SMOKE_PS); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e); '
        + "[Console]::Out.Write([string]$e.Count + '|' + (($e | ForEach-Object { $_.Message }) -join '; '))";
      cp.execFile(acc._psExe(), ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { windowsHide: true, timeout: 20000, env: acc._psEnv({ VS_SMOKE_PS: wf }) }, (err, out) => resolve(String(out || (err && err.message) || '').trim()));
    });
    txt.psParses = parsed === '0|' || parsed;
    try { fs.rmSync(wf, { force: true }); } catch {}
  }
  check('app update: helper scripts (quoting, fixed-string process match, sh -n / PowerShell 5.1 parse)', Object.values(txt).every(v => v === true), JSON.stringify(txt));

  // 5. a local feed: check (ETag / 304), download (resume), verify (sha256,
  //    size only, tampered), https-only unless the feed is overridden
  const files = new Map(); // name -> Buffer
  let releases = [];
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, inm: req.headers['if-none-match'] || null, range: req.headers.range || null });
    if (req.url.startsWith('/releases')) {
      const etag = `"${sha(Buffer.from(JSON.stringify(releases))).slice(0, 12)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
      return res.end(JSON.stringify(releases));
    }
    const name = decodeURIComponent(req.url.replace(/^\/dl\//, ''));
    const buf = files.get(name);
    if (!buf) { res.writeHead(404); return res.end(); }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (m && +m[1] < buf.length) {
      res.writeHead(206, { 'Content-Length': buf.length - m[1], 'Content-Range': `bytes ${m[1]}-${buf.length - 1}/${buf.length}` });
      return res.end(buf.subarray(+m[1]));
    }
    res.writeHead(200, { 'Content-Length': buf.length });
    return res.end(buf);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const asset = (name, buf, { digest = true, size = true } = {}) => ({
    name, browser_download_url: `${base}/dl/${encodeURIComponent(name)}`, size: size ? buf.length : 0, digest: digest ? `sha256:${sha(buf)}` : undefined,
  });
  try {
    const payload = crypto.randomBytes(300 * 1024);
    const ownName = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'VibeSpace-98.0.0-arm64-mac.zip' : 'VibeSpace-98.0.0-mac.zip') : 'VibeSpace.Setup.98.0.0.exe';
    files.set(ownName, payload);
    releases = [{ tag_name: 'v98.0.0', name: 'Feed test', draft: false, prerelease: false, html_url: `${base}/notes`, assets: [asset(ownName, payload)] }];
    const feed = `${base}/releases`;
    const c1 = await au.check({ feed, version: '0.0.1' });
    const c2 = await au.check({ feed, version: '0.0.1' });
    const st = au.readState();
    const upd = au.pickUpdate(st.releases, '0.0.1', process.platform, process.arch);
    const work = path.join(U.dataRoot(), 'updates', 'feedtest');
    // resume: half of the file is already there as .part
    U.ensureDir(work);
    fs.writeFileSync(path.join(work, `${ownName}.part`), payload.subarray(0, 100 * 1024));
    const pcts = [];
    const dl = upd ? await au.download(upd.asset, work, { allowHttp: true, onProgress: (p) => pcts.push(p) }).catch(e => ({ error: e.message })) : { error: 'no update picked' };
    const again = upd ? await au.download(upd.asset, work, { allowHttp: true }).catch(e => ({ error: e.message })) : {};
    // tampered: the digest belongs to other bytes → refused, nothing kept
    const bad = crypto.randomBytes(1000);
    files.set('bad.bin', bad);
    const badAsset = { name: 'bad.bin', url: `${base}/dl/bad.bin`, size: bad.length, sha256: sha(Buffer.from('other')) };
    const badDl = await au.download(badAsset, work, { allowHttp: true }).then(() => 'accepted', e => e.message);
    const sizeOnly = await au.download({ name: 'bad.bin', url: `${base}/dl/bad.bin`, size: bad.length, sha256: null }, path.join(work, 's'), { allowHttp: true }).then(r => r.by, e => e.message);
    const nothing = await au.download({ name: 'bad.bin', url: `${base}/dl/bad.bin`, size: 0, sha256: null }, path.join(work, 'n'), { allowHttp: true }).then(() => 'accepted', () => 'refused');
    const httpRefused = await au.download(badAsset, path.join(work, 'h')).then(() => 'accepted', e => (/refusing/.test(e.message) ? 'refused' : e.message));
    const traversal = await au.download({ ...badAsset, name: '../evil.bin' }, work, { allowHttp: true }).then(() => 'accepted', () => 'refused');
    const feedOk = {
      c1: c1.ok === true && !c1.notModified,
      etag304: c2.ok === true && c2.notModified === true && seen.filter(s => s.url.startsWith('/releases')).pop().inm !== null,
      picked: Boolean(upd && upd.version === '98.0.0' && upd.asset.name === ownName),
      resumed: dl.by === 'sha256' && seen.some(s => s.range === `bytes=${100 * 1024}-`) && sha(fs.readFileSync(dl.file)) === sha(payload) && !fs.existsSync(`${dl.file}.part`),
      progress: pcts.length > 0 && pcts[pcts.length - 1] === 100,
      cached: again.cached === true,
      tampered: /failed verification/.test(badDl) && !fs.existsSync(path.join(work, 'bad.bin')) && !fs.existsSync(path.join(work, 'bad.bin.part')),
      sizeOnly: sizeOnly === 'size',
      nothingToCheck: nothing === 'refused',
      httpRefused: httpRefused === 'refused',
      traversal: traversal === 'refused' && !fs.existsSync(path.join(U.dataRoot(), 'updates', 'evil.bin')),
    };
    check('app update: local feed → check (ETag/304) → download (resume) → verify (sha256 / size only / tampered refused)',
      Object.values(feedOk).every(Boolean), JSON.stringify({ ...feedOk, dl: dl.error || dl.by, badDl }));
    fs.rmSync(work, { recursive: true, force: true });

    // 6. darwin: end-to-end swap of a FAKE app bundle in a temp folder
    if (process.platform === 'darwin') {
      await macEndToEnd({ check, base, files, setReleases: (r) => { releases = r; }, asset, seen });
    }
  } finally {
    await new Promise(r => srv.close(r));
    // the smoke's own windows (packaged smoke = updates enabled) must not offer the test releases
    try { au.patchState({ feed: null, etag: null, releases: [], checkedAt: null, attemptAt: null }); } catch {}
  }
};

async function macEndToEnd({ check, base, files, setReleases, asset }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs update e2e '));
  const run = (cmd, args, timeout = 180000) => cp.spawnSync(cmd, args, { encoding: 'utf8', timeout });
  const plistVer = (app) => (run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).stdout || '').trim();
  const plist = (ver) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>VibeSpace</string>
<key>CFBundleIdentifier</key><string>app.vibespace</string>
<key>CFBundleName</key><string>VibeSpace</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${ver}</string>
<key>CFBundleVersion</key><string>${ver}</string>
</dict></plist>
`;
  // a tiny real bundle: a Mach-O main executable (a copy of /usr/bin/true),
  // an Info.plist, an ad-hoc signature (sealed resources) like our builds
  const mkApp = (dir, ver) => {
    const app = path.join(dir, 'VibeSpace.app');
    const exe = path.join(app, 'Contents', 'MacOS', 'VibeSpace');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'note.txt'), `VibeSpace ${ver}\n`);
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(ver));
    for (const src of ['/usr/bin/true', process.execPath]) {
      fs.copyFileSync(src, exe);
      fs.chmodSync(exe, 0o755);
      const s = run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app]);
      if (s.status === 0) return app;
    }
    throw new Error(`codesign of the fake ${ver} bundle failed`);
  };
  const out = {};
  let detail = '';
  try {
    const appsDir = path.join(tmp, "Apps it's");
    const target = mkApp(appsDir, '0.0.1');
    const newApp = mkApp(path.join(tmp, 'build'), '99.0.0');
    const zipName = process.arch === 'arm64' ? 'VibeSpace-99.0.0-arm64-mac.zip' : 'VibeSpace-99.0.0-mac.zip';
    const zip = path.join(tmp, zipName);
    const z = run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', newApp, zip]);
    if (z.status !== 0) throw new Error(`ditto zip failed: ${z.stderr}`);
    files.set(zipName, fs.readFileSync(zip));
    setReleases([{ tag_name: 'v99.0.0', name: 'E2E', draft: false, prerelease: false, html_url: `${base}/notes`, assets: [asset(zipName, files.get(zipName))] }]);

    const c = await au.check({ feed: `${base}/releases`, version: '0.0.1' });
    const upd = au.pickUpdate(au.readState().releases, '0.0.1', 'darwin', process.arch);
    if (!c.ok || !upd) throw new Error(`check/pick failed: ${JSON.stringify(c)}`);
    const work = path.join(U.dataRoot(), 'updates', '99.0.0');
    const dl = await au.download(upd.asset, work, { allowHttp: true });
    const appPath = await au.prepareMac(dl.file, upd.asset.kind, '99.0.0', work);
    out.unpacked = plistVer(appPath) === '99.0.0';
    // the wrong version is refused before anything runs
    out.wrongVersionRefused = await au.prepareMac(dl.file, 'zip', '99.0.5', path.join(tmp, 'wrong')).then(() => false, e => /expected 99\.0\.5/.test(e.message));

    // a process whose command line holds the bundle path: the helper waits for it
    // ('; :' keeps sh from exec-ing sleep, which would drop the path from argv)
    const holder = cp.spawn('/bin/sh', ['-c', 'sleep 2; :', `${target}/Contents/MacOS/VibeSpace`], { stdio: 'ignore' });
    const logF = path.join(tmp, 'install.log');
    const resF = path.join(tmp, 'install.result');
    const script = au.writeScript(path.join(tmp, 'scripts'), 'install.sh', au.macInstallScript({
      target, source: appPath, version: '99.0.0', log: logF, result: resF, pids: [], relaunch: false, cleanup: work,
    }));
    const t0 = Date.now();
    const r = run('/bin/sh', [script], 120000);
    const took = Date.now() - t0;
    try { holder.kill(); } catch {}
    const logText = fs.existsSync(logF) ? fs.readFileSync(logF, 'utf8') : '';
    out.exit0 = r.status === 0;
    out.waitedForHolder = took >= 1200;
    out.newVersion = plistVer(target) === '99.0.0';
    out.noOldLeft = !fs.readdirSync(appsDir).some(n => n.includes('.old-'));
    out.logOk = /ok: VibeSpace 99\.0\.0 installed/.test(logText) && !/fail:/.test(logText);
    out.result = (fs.existsSync(resF) ? fs.readFileSync(resF, 'utf8').trim() : '') === 'ok 99.0.0';
    out.stillSigned = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]).status === 0;
    out.cleanedUp = !fs.existsSync(work);
    out.notTheRunningApp = target !== au.bundleFromExecPath(process.execPath);
    if (!out.logOk) detail = logText.slice(-400);

    // the dmg path: hdiutil attach (read-only, no Finder window) → ditto → detach
    const dmgSrc = path.join(tmp, 'dmgsrc');
    mkApp(dmgSrc, '99.0.1');
    const dmg = path.join(tmp, 'VibeSpace-99.0.1.dmg');
    const h = run('/usr/bin/hdiutil', ['create', '-volname', 'VibeSpace 99', '-srcfolder', dmgSrc, '-ov', '-format', 'UDZO', dmg]);
    if (h.status !== 0) {
      out.dmg = `hdiutil create failed: ${(h.stderr || '').trim()}`;
    } else {
      const mntBefore = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vs-update-mnt-')).length;
      const app2 = await au.prepareMac(dmg, 'dmg', '99.0.1', path.join(tmp, 'work-dmg')).catch(e => ({ error: e.message }));
      const mntAfter = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vs-update-mnt-')).length;
      out.dmg = typeof app2 === 'string' && plistVer(app2) === '99.0.1' && mntAfter <= mntBefore ? true : JSON.stringify(app2);
    }
  } catch (e) {
    detail = `threw: ${e && e.message ? e.message : e}`;
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const ok = Object.keys(out).length >= 12 && Object.values(out).every(v => v === true);
  check('app update (darwin): END-TO-END swap of a temp VibeSpace.app (feed → zip → verify → helper waits → swap → no .old left) + dmg unpack',
    ok, JSON.stringify(out) + (detail ? ` — ${detail}` : ''));
}
