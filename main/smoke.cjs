'use strict';
// Self-test mode: electron . --smoke   (uses a throwaway VIBESPACE_HOME)
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util.cjs');
const ico = require('./ico.cjs');
const workspaces = require('./workspaces.cjs');
const ptyhost = require('./ptyhost.cjs');
const sessions = require('./sessions.cjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function ptyEchoTest() {
  return new Promise((resolve) => {
    if (!ptyhost.available()) return resolve({ ok: false, detail: 'node-pty unavailable' });
    let buf = '';
    const marker = `__VIBESPACE_OK_${Date.now()}__`;
    const termId = 'smoke';
    const timer = setTimeout(() => {
      ptyhost.onData(() => {});
      ptyhost.kill(termId);
      resolve({ ok: false, detail: `timeout; got: ${JSON.stringify(buf.slice(0, 200))}` });
    }, 15000);
    ptyhost.onData((id, chunk) => {
      if (id !== termId) return;
      buf += chunk;
      if (buf.includes(marker)) {
        clearTimeout(timer);
        ptyhost.onData(() => {});
        ptyhost.kill(termId);
        resolve({ ok: true, detail: `received echo after ${buf.length} chars` });
      }
    });
    try {
      ptyhost.create(termId, U.BIN_ROOT, 120, 30); // BIN_ROOT: real dir even when packaged (asar cwd = error 267)
    } catch (e) {
      clearTimeout(timer);
      ptyhost.onData(() => {});
      resolve({ ok: false, detail: 'spawn threw: ' + (e && e.message ? e.message : e) });
      return;
    }
    setTimeout(() => ptyhost.write(termId, `echo ${marker}\r`), 700);
  });
}

// Layer 2: output ring buffer must capture pty output (so a reloaded renderer can
// restore scrollback) and list() must reflect the pty lifecycle.
function ptyBufferTest() {
  return new Promise((resolve) => {
    if (!ptyhost.available()) return resolve({ ok: false, detail: 'node-pty unavailable' });
    let buf = '';
    const marker = `__VIBESPACE_BUF_${Date.now()}__`;
    const termId = 'smokebuf';
    const done = (ok, detail, busy = {}) => {
      clearTimeout(timer);
      ptyhost.onData(() => {});
      ptyhost.kill(termId);
      resolve({ ok, detail, ...busy });
    };
    const timer = setTimeout(() => done(false, `timeout; got: ${JSON.stringify(buf.slice(0, 200))}`), 15000);
    ptyhost.onData((id, chunk) => {
      if (id !== termId) return;
      buf += chunk;
      if (!buf.includes(marker)) return;
      const entry = ptyhost.list().find(p => p.termId === termId);
      const hasMarker = Boolean(entry && entry.buffer.includes(marker));
      const listed = ptyhost.list().some(p => p.termId === termId);
      const busyNow = ptyhost.busyNow(); // echo just arrived — must read as busy
      const busyFuture = ptyhost.busyNow({ now: Date.now() + 6000 }); // far future — idle
      ptyhost.kill(termId);
      const goneAfterKill = !ptyhost.list().some(p => p.termId === termId);
      const busyAfterKill = ptyhost.busyNow(); // activity map cleaned with the pty
      done(hasMarker && listed && goneAfterKill,
        `buffer ${hasMarker ? 'captured marker' : 'MISSING marker'}; listed=${listed}; gone-after-kill=${goneAfterKill}`,
        { busyNow, busyFuture, busyAfterKill });
    });
    try {
      ptyhost.create(termId, U.BIN_ROOT, 120, 30);
    } catch (e) {
      done(false, 'spawn threw: ' + (e && e.message ? e.message : e));
      return;
    }
    setTimeout(() => ptyhost.write(termId, `echo ${marker}\r`), 700);
  });
}

async function runSmoke() {
  U.ensureDir(U.dataRoot());
  U.ensureDir(path.join(U.dataRoot(), 'icons'));

  // 1. munge
  const munged = U.mungeClaudeDir('D:\\Repositories\\PlacementFlow');
  check('claude dir munge', munged === 'D--Repositories-PlacementFlow', munged);

  // 2. real session store discovery (read-only, against the live ~/.claude)
  const dir = U.resolveClaudeProjectDir('D:\\Repositories\\PlacementFlow');
  const jsonl = dir ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).length : 0;
  check('placementflow session dir found', Boolean(dir), dir || 'not found');
  check('placementflow has sessions', jsonl > 0, `${jsonl} sessions`);

  // 3. ico build (default + from generated png)
  const sharp = require('sharp');
  const tmpPng = path.join(U.dataRoot(), 'smoke-logo.png');
  await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 110, g: 80, b: 255, alpha: 1 } } }).png().toFile(tmpPng);
  const outIco = path.join(U.dataRoot(), 'smoke.ico');
  await ico.buildIcoFromImage(tmpPng, outIco);
  const buf = fs.readFileSync(outIco);
  const headerOk = buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0;
  check('ico build', headerOk && buf.length > 1000, `${buf.length} bytes, count=${buf.readUInt16LE(4)}`);

  // 4. registry CRUD
  const ws = await workspaces.create({ name: 'Smoke Repo', repoPath: 'D:\\Repositories', logoPath: tmpPng });
  check('workspace create', Boolean(workspaces.get(ws.id)) && ws.iconPath && fs.existsSync(ws.iconPath), ws.id);
  check('workspace remove', workspaces.remove(ws.id) && !workspaces.get(ws.id));

  // 5. session tracker assign logic (simulated on real dir)
  if (dir) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => { const st = fs.statSync(path.join(dir, f)); return { id: f.slice(0, -6), born: st.birthtimeMs }; })
      .sort((a, b) => b.born - a.born);
    const newest = files[0];
    sessions.start('smoke-ws', 'D:\\Repositories\\PlacementFlow');
    sessions.pinSession('smoke-ws', 't1', newest.id);
    check('session pin + lookup', sessions.getSession('smoke-ws', 't1') === newest.id, newest.id);
    check('session exists check', sessions.sessionExists('smoke-ws', newest.id) === true && sessions.sessionExists('smoke-ws', 'deadbeef-0000-0000-0000-000000000000') === false, newest.id);
    sessions.stop('smoke-ws');
  }

  // 6. fresh-repo session tracking: dir appears only AFTER claude's first message
  {
    const sessions = require('./sessions.cjs');
    const BS = String.fromCharCode(92); const fakeRepo = 'D:' + BS + 'Repositories' + BS + 'vibespace-smoke-fresh-' + U.randId(6);
    sessions.start('smoke-fresh', fakeRepo); // no dir exists yet
    sessions.trackClaudeStart('smoke-fresh', 't1');
    const mungedDir = path.join(U.claudeProjectsDir(), U.mungeClaudeDir(fakeRepo));
    fs.mkdirSync(mungedDir, { recursive: true });
    fs.writeFileSync(path.join(mungedDir, '11111111-2222-3333-4444-555555555555.jsonl'), '{}');
    sessions._scan('smoke-fresh');
    const got = sessions.getSession('smoke-fresh', 't1');
    check('fresh-repo session capture (late dir)', got === '11111111-2222-3333-4444-555555555555', `got=${got}`);
    sessions.stop('smoke-fresh');
    try { fs.rmSync(mungedDir, { recursive: true, force: true }); } catch {}
  }

  // 7. devwatch gate: hot reload must be opt-in
  {
    const dw = require('./devwatch.cjs');
    const dwArgs = {
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] },
      ptyhost: { killAll: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      root: U.ROOT,
    };
    const hadWatch = process.env.VIBESPACE_WATCH;
    delete process.env.VIBESPACE_WATCH;
    check('devwatch off by default', dw.start(dwArgs) === false);
    process.env.VIBESPACE_WATCH = '1';
    let started = false;
    try { started = dw.start(dwArgs); } catch { started = false; }
    check('devwatch on with VIBESPACE_WATCH=1', started === true);
    if (hadWatch) process.env.VIBESPACE_WATCH = hadWatch; else delete process.env.VIBESPACE_WATCH;
  }

  // 11. git porcelain parsing (tree colors)
  {
    const gs = require('./gitstatus.cjs');
    const sample = ' M foo.txt\0?? bar/baz.ts\0A  staged.py\0D  gone.md\0R  renamed-new.ts\0renamed-old.ts\0';
    const parsed = gs._parsePorcelain(sample);
    const okParsed = parsed.get('foo.txt') === 'M' && parsed.get('bar/baz.ts') === 'U'
      && parsed.get('staged.py') === 'A' && parsed.get('gone.md') === 'D'
      && parsed.get('renamed-new.ts') === 'M' && !parsed.has('renamed-old.ts');
    check('git porcelain parse (M/A/U/D/rename)', okParsed, JSON.stringify([...parsed.entries()]));
  }

  // 10. status file watcher (supervision signal from injected claude hooks)
  {
    const statusMod = require('./status.cjs');
    const dir = path.join(U.dataRoot(), 'status-smoke');
    let got = null;
    statusMod.onData((wsId, termId, st) => { got = { wsId, termId, st }; });
    statusMod.start('smoke-ws', dir);
    fs.writeFileSync(path.join(dir, 't9.status'), 'idle-noise\nworking\n'); // last line wins
    await new Promise(r => setTimeout(r, 900));
    check('status watcher emits last status line', got && got.wsId === 'smoke-ws' && got.termId === 't9' && got.st === 'working', JSON.stringify(got));
    statusMod.stop('smoke-ws');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // 12. claude version parse/compare (⟳ button visibility logic)
  {
    const up = require('./updater.cjs');
    check('claude version parse', JSON.stringify(up._parseVersion('2.1.283 (Claude Code)')) === '[2,1,283]', JSON.stringify(up._parseVersion('2.1.283 (Claude Code)')));
    check('claude version changed compare', up._versionChanged('2.1.283 (x)', '2.2.0 (y)') === true && up._versionChanged('2.1.283 (x)', '2.1.283 (y)') === false && up._versionChanged(null, '2.2.0') === false, 'major/minor/patch + null-safety');
  }

  // 13. source fingerprint (↻ restart-button detection)
  {
    const ss = require('./srcstate.cjs');
    check('source fingerprint of repo', typeof ss.fingerprint(U.ROOT) === 'string', ss.fingerprint(U.ROOT));
    const fpRoot = path.join(U.dataRoot(), 'fp-test', 'main');
    fs.mkdirSync(fpRoot, { recursive: true });
    fs.writeFileSync(path.join(fpRoot, 'a.cjs'), '1');
    const before = ss.fingerprint(path.join(U.dataRoot(), 'fp-test'));
    fs.writeFileSync(path.join(fpRoot, 'a.cjs'), 'longer content changes size+mtime');
    const after = ss.fingerprint(path.join(U.dataRoot(), 'fp-test'));
    check('source fingerprint detects change', before !== after, `${before} -> ${after}`);
    try { fs.rmSync(path.join(U.dataRoot(), 'fp-test'), { recursive: true, force: true }); } catch {}
  }

  // 14. tree watcher (live file-tree refresh) + ignore-path filter
  {
    const tw = require('./treewatch.cjs');
    const dir = path.join(U.dataRoot(), 'treewatch-smoke', 'src');
    fs.mkdirSync(dir, { recursive: true });
    let fired = 0;
    let ignoredFired = false;
    tw.onData((wsId) => { if (wsId === 'tw-ws') fired++; if (wsId === 'tw-bad') ignoredFired = true; });
    tw.start('tw-ws', path.join(U.dataRoot(), 'treewatch-smoke'));
    fs.writeFileSync(path.join(dir, 'new-file.ts'), 'x');
    const deadline = Date.now() + 4000;
    while (!fired && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));
    check('tree watcher fires on new file', fired > 0, `fired=${fired}`);
    check('ignore-path filter', U.isIgnoredPath('src/node_modules/pkg/x.js') === true && U.isIgnoredPath('a/b.tsbuildinfo') === true && U.isIgnoredPath('src/new-file.ts') === false, '');
    tw.stop('tw-ws');
    try { fs.rmSync(path.join(U.dataRoot(), 'treewatch-smoke'), { recursive: true, force: true }); } catch {}
    void ignoredFired;
  }

  // 15. drag-drop copy (collision-safe)
  {
    const srcDir = path.join(U.dataRoot(), 'copyin-smoke');
    fs.mkdirSync(srcDir, { recursive: true });
    const src = path.join(srcDir, 'logo.png');
    fs.writeFileSync(src, 'pngdata');
    const dest = path.join(srcDir, 'dest');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'logo.png'), 'existing');
    const n1 = U.copyIn(src, dest);
    const n2 = U.copyIn(src, dest);
    check('copyIn collision-safe rename', n1 === 'logo (2).png' && n2 === 'logo (3).png' && fs.readFileSync(path.join(dest, 'logo.png'), 'utf8') === 'existing', `${n1}, ${n2}`);
    try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch {}
  }

  // 16. tree file operations: jail guard + fsops create/mkdir/rename/remove
  {
    const os = require('node:os');
    const fsops = require('./fsops.cjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-fsops-'));
    const nested = path.join(root, 'sub');
    fs.mkdirSync(nested);

    // jail guard
    const inside = path.join(root, 'sub', 'x.txt');
    check('jailed accepts nested path', U.jailed(root, inside) === path.resolve(inside), U.jailed(root, inside) || 'null');
    check('jailed rejects .. escape', U.jailed(root, path.join(root, '..', 'escape.txt')) === null);
    const sibling = path.join(path.dirname(root), path.basename(root) + 'suffix'); // D:\a vs D:\ab
    check('jailed rejects sibling-prefix path', U.jailed(root, sibling) === null, sibling);
    const otherDrive = (root[0].toUpperCase() === 'Q' ? 'Z' : 'Q') + ':\\elsewhere\\file.txt';
    check('jailed rejects other-drive path', U.jailed(root, otherDrive) === null, otherDrive);

    // create + guards
    const made = fsops.create(root, nested, 'newfile.ts');
    check('fsops.create makes empty file', made.path === path.join(nested, 'newfile.ts') && fs.existsSync(made.path) && fs.statSync(made.path).size === 0, made.path);
    let threw = false; try { fsops.create(root, nested, 'newfile.ts'); } catch { threw = true; }
    check('fsops.create refuses existing target', threw);
    threw = false; try { fsops.create(root, nested, 'a/b.ts'); } catch { threw = true; }
    check('fsops.create refuses name with separator', threw);
    threw = false; try { fsops.create(root, path.dirname(root), 'x.ts'); } catch { threw = true; }
    check('fsops.create refuses dir outside root', threw);

    // mkdir
    const md = fsops.mkdir(root, nested, 'newdir');
    check('fsops.mkdir makes dir', fs.existsSync(md.path) && fs.statSync(md.path).isDirectory(), md.path);

    // rename + guard
    const renamed = path.join(nested, 'renamed.ts');
    check('fsops.rename moves inside jail', fsops.rename(root, made.path, renamed) === true && fs.existsSync(renamed) && !fs.existsSync(made.path));
    threw = false; try { fsops.rename(root, renamed, path.join(path.dirname(root), 'stolen.ts')); } catch { threw = true; }
    check('fsops.rename refuses destination outside root', threw);

    // remove: real Recycle-Bin move (smoke runs inside app whenReady, so
    // shell.trashItem is available); guards are sync throws.
    let gone = null;
    try { gone = await fsops.remove(root, renamed); } catch (err) { gone = err; }
    check('fsops.remove trashes via shell.trashItem', gone === true && !fs.existsSync(renamed), gone instanceof Error ? gone.message : 'ok');
    threw = false; try { await fsops.remove(root, path.join(path.dirname(root), 'other.txt')); } catch { threw = true; }
    check('fsops.remove refuses outside root', threw);
    threw = false; try { await fsops.remove(root, path.join(root, 'nope.txt')); } catch { threw = true; }
    check('fsops.remove refuses nonexistent', threw);

    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }

  // 17. gitdiff: CRLF normalization + end-to-end pairs on a temp git repo
  {
    const os = require('node:os');
    const gitdiff = require('./gitdiff.cjs');
    check('gitdiff _normalize strips CRLF', gitdiff._normalize('a\r\nb\r\n') === 'a\nb\n' && gitdiff._normalize('a\nb') === 'a\nb');
    const gitOk = await new Promise((res) => {
      const p = require('node:child_process').spawn('git', ['--version'], { windowsHide: true });
      p.on('error', () => res(false));
      p.on('close', (c) => res(c === 0));
    });
    if (!gitOk) {
      check('gitdiff end-to-end (git on PATH)', true, 'skipped — git not on PATH');
    } else {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-gitdiff-'));
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-nogit-'));
      const exec = (args) => new Promise((res) => {
        const p = require('node:child_process').spawn('git', args, { cwd: root, windowsHide: true });
        p.on('error', () => res(false));
        p.on('close', (c) => res(c === 0));
      });
      await exec(['init']);
      await exec(['config', 'user.email', 'smoke@vibespace.local']);
      await exec(['config', 'user.name', 'VibeSpace Smoke']);
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\r\ntwo\r\n');
      fs.writeFileSync(path.join(root, 'del.txt'), 'bye');
      await exec(['add', 'a.txt', 'del.txt']);
      await exec(['commit', '-m', 'init']);
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\r\nTWO\r\n'); // modify
      const d1 = await gitdiff.diff(root);
      const by1 = Object.fromEntries((d1?.files || []).map(f => [f.rel, f]));
      check('gitdiff modified pair (normalized)', by1['a.txt'] && by1['a.txt'].status === 'M'
        && by1['a.txt'].original.includes('two') && by1['a.txt'].modified.includes('TWO')
        && !by1['a.txt'].original.includes('\r'), JSON.stringify(by1['a.txt'] || null).slice(0, 80));
      fs.writeFileSync(path.join(root, 'untracked.txt'), 'fresh');
      fs.rmSync(path.join(root, 'del.txt')); // delete
      const d2 = await gitdiff.diff(root, { refresh: true });
      const by2 = Object.fromEntries((d2?.files || []).map(f => [f.rel, f]));
      check('gitdiff deleted file empty modified', by2['del.txt'] && by2['del.txt'].status === 'D' && by2['del.txt'].modified === '', JSON.stringify(by2['del.txt'] || null));
      check('gitdiff untracked counts as added', by2['untracked.txt'] && by2['untracked.txt'].status === 'U' && by2['untracked.txt'].original === '' && by2['untracked.txt'].modified === 'fresh', JSON.stringify(by2['untracked.txt'] || null));
      check('gitdiff non-repo resolves null', (await gitdiff.diff(empty)) === null);
      try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }); } catch {}
    }
  }

  // 16. cross-workspace broadcast (the /sync-docs transport)
  {
    const bc = require('./broadcast.cjs');
    let got = null;
    bc.onData((cmd) => { got = cmd; });
    bc.start();
    bc.send('/sync-docs');
    const deadline = Date.now() + 3000;
    while (!got && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    check('broadcast send/receive round-trip', got === '/sync-docs', `got=${got}`);
    bc.stop();
    try { fs.rmSync(path.dirname(bc._cmdFile()), { recursive: true, force: true }); } catch {}
  }

  // 17. PATH rebuild from registry (the stripped/mangled-PATH class of bugs)
  {
    const rebuilt = U.rebuildPath('C:\\Windows;C:\\Windows;junk;C:Windows');
    const parts = rebuilt.split(';');
    const dupes = parts.length !== new Set(parts.map(p => p.toLowerCase())).size;
    check('PATH rebuild: registry entries + dedupe', rebuilt.toLowerCase().includes('windows\\system32') && !dupes && !parts.includes('junk'), `${parts.length} entries`);
    // the real-world case: rebuild must work FROM a mangled PATH (reg.exe unreachable by name)
    const saved = process.env.PATH;
    process.env.PATH = 'C:Windows;C:WindowsSystem32';
    let fromMangled = '';
    try { fromMangled = U.rebuildPath(); } finally { process.env.PATH = saved; }
    check('PATH rebuild works from a mangled PATH', fromMangled.toLowerCase().includes('windows\\system32') && fromMangled.split(';').length > 3 && !fromMangled.split(';').includes('C:Windows'), `${fromMangled.split(';').length} entries`);
  }

  // 18. picker resume pinning (right-click + Claude → claude --resume)
  {
    const now = Date.now();
    const files = [
      { id: 'fresh', born: now - 1000, mtime: now - 500 },              // born after launch — not it
      { id: 'old-idle', born: now - 900000, mtime: now - 800000 },      // old but never touched — not it
      { id: 'old-picked', born: now - 900000, mtime: now - 1000 },      // old, appends since launch — IT
      { id: 'taken', born: now - 900000, mtime: now - 10 },             // newer appends but owned by another tab
    ];
    const picked = sessions._pickResumed(files, now - 60000, new Set(['taken']));
    check('picker resume picks the revived old conversation', picked && picked.id === 'old-picked', `picked=${picked && picked.id}`);
    const none = sessions._pickResumed([{ id: 'x', born: now - 5000, mtime: now - 4000 }], now - 60000, new Set());
    check('picker resume ignores fresh sessions', none === null, `got=${none && none.id}`);
  }

  // 19. junk "Electron.lnk" cleanup (pinned-before-shortcut taskbar bug)
  {
    const { shell } = require('electron');
    const shortcutsMod = require('./shortcuts.cjs');
    const realAppData = process.env.APPDATA;
    const fakeAppData = path.join(U.dataRoot(), 'fake-appdata');
    const progs = path.join(fakeAppData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(progs, { recursive: true });
    process.env.APPDATA = fakeAppData;
    try {
      shell.writeShortcutLink(path.join(progs, 'Electron.lnk'), { target: process.execPath });           // junk: our exe, no args
      shell.writeShortcutLink(path.join(progs, 'Electron (2).lnk'), { target: process.execPath, args: '--workspace=x' }); // has args: keep
      shell.writeShortcutLink(path.join(progs, 'Other.lnk'), { target: process.execPath });              // not Electron*: keep
      const removed = shortcutsMod.removeJunkElectronLinks(process.execPath);
      const kept = fs.readdirSync(progs).sort().join(',');
      check('junk Electron.lnk cleanup (only bare strays)', removed.join(',') === 'Electron.lnk' && kept === 'Electron (2).lnk,Other.lnk', `removed=${removed} kept=${kept}`);
    } finally {
      process.env.APPDATA = realAppData;
      try { fs.rmSync(fakeAppData, { recursive: true, force: true }); } catch {}
    }
  }

  // 8. pty echo (powershell)
  const echo = await ptyEchoTest();
  check('pty spawn + echo (powershell)', echo.ok, echo.detail);

  // 9. pty ring buffer + list (Layer 2: reloads must not kill agents)
  const ring = await ptyBufferTest();
  check('pty ring buffer + list lifecycle', ring.ok, ring.detail);
  check('pty busyNow guard signal (Layer 3)', ring.busyNow === true && ring.busyFuture === false && ring.busyAfterKill === false,
    `now=${ring.busyNow} future=${ring.busyFuture} afterKill=${ring.busyAfterKill}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0;
}

module.exports = runSmoke;
