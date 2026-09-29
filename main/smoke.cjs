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

      // 17b. githistory (History tab): log, agent trailer, rename-aware commit
      // files, before/after pair, branch chip data, non-repo → null
      const gh = require('./githistory.cjs');
      await exec(['add', '-A']);
      await exec(['commit', '-m', 'second']);
      await exec(['mv', 'a.txt', 'b.txt']);
      await exec(['commit', '-m', 'rename a\n\nCo-Authored-By: Claude <noreply@anthropic.com>']);
      const lg = await gh.log(root, { limit: 2 });
      check('githistory log pages + agent trailer', lg && lg.commits.length === 2 && lg.more === true
        && lg.commits[0].subject === 'rename a' && lg.commits[0].agent === true && lg.commits[1].agent === false,
      JSON.stringify(lg && lg.commits.map(c => [c.subject, c.agent])));
      const cm = lg && await gh.commit(root, lg.commits[0].sha);
      const ren = cm && cm.files.find(f => f.status === 'R');
      check('githistory commit detects rename', ren && ren.from === 'a.txt' && ren.rel === 'b.txt', JSON.stringify(cm && cm.files));
      const second = lg && await gh.commit(root, lg.commits[1].sha);
      const mod = second && second.files.find(f => f.rel === 'a.txt');
      const pair = mod && await gh.commitFileDiff(root, second.sha, mod);
      check('githistory before/after pair', pair && pair.original === 'one\ntwo\n' && pair.modified === 'one\nTWO\n', JSON.stringify(pair));
      const fh = await gh.log(root, { path: 'b.txt', follow: true });
      check('githistory file history follows renames', fh && fh.commits.length === 3, String(fh && fh.commits.length));
      const br = await gh.branch(root);
      check('githistory branch info', br && br.head && br.oid === lg.commits[0].sha && br.upstream === null && br.operation === null, JSON.stringify(br));
      check('githistory non-repo resolves null', (await gh.log(empty)) === null && (await gh.branch(empty)) === null);
      check('githistory rejects bad sha', (await gh.commit(root, '--output=x')) === null);
      try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }); } catch {}
    }
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

  // 20. default workspace icon = per-name letter mark (never the app logo)
  {
    const icoMod = require('./ico.cjs');
    const a = path.join(U.dataRoot(), 'mark-a.ico');
    const b = path.join(U.dataRoot(), 'mark-b.ico');
    await icoMod.buildDefaultIco(a, 'Recruitica');
    await icoMod.buildDefaultIco(b, 'FlexIQ');
    const ha = require('node:crypto').createHash('sha1').update(fs.readFileSync(a)).digest('hex');
    const hb = require('node:crypto').createHash('sha1').update(fs.readFileSync(b)).digest('hex');
    const appIco = path.join(U.ROOT, 'assets', 'app.ico');
    const happ = fs.existsSync(appIco) ? require('node:crypto').createHash('sha1').update(fs.readFileSync(appIco)).digest('hex') : '';
    check('default icons are per-workspace letter marks', ha !== hb && ha !== happ && fs.statSync(a).size > 1000, `${ha.slice(0, 8)} vs ${hb.slice(0, 8)}`);
  }

  // 21. terminal env has ONE path key and resolves user-PATH tools by name
  //     (the Path/PATH duplicate-key bug that broke node/python/MCP servers)
  {
    const e = ptyhost._withSinglePath({ Path: 'full', PATH: 'stripped', path: 'x', Other: '1' }, 'final');
    const pathKeys = Object.keys(e).filter(k => k.toUpperCase() === 'PATH');
    check('pty env collapses to a single Path key', pathKeys.length === 1 && e.Path === 'final' && e.Other === '1', pathKeys.join(','));
    const r = await new Promise((resolve) => {
      let buf = '';
      const termId = 'smokeenv';
      const marker = `__ENV_${Date.now()}__`;
      const timer = setTimeout(() => { ptyhost.onData(() => {}); ptyhost.kill(termId); resolve({ ok: false, detail: 'timeout: ' + buf.slice(-200) }); }, 20000);
      ptyhost.onData((id, chunk) => {
        if (id !== termId) return;
        buf += chunk;
        const flat = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '');
        // the typed command echoes the marker too; the OUTPUT is "NODE=<path>|…"
        // with no quote after "=" — wait for that form specifically
        const m = flat.match(new RegExp(marker + 'NODE=([^"|]*)\\|NPMDIR=(\\d+)\\|' + marker + 'END'));
        if (!m) return;
        clearTimeout(timer);
        ptyhost.onData(() => {});
        ptyhost.kill(termId);
        resolve({ ok: /node\.exe$/i.test(m[1].trim()) && Number(m[2]) > 0, detail: `node=${m[1].trim() || 'NOT FOUND'} npmDirsOnPath=${m[2]}` });
      });
      try { ptyhost.create(termId, U.BIN_ROOT, 200, 30); } catch (err) { clearTimeout(timer); resolve({ ok: false, detail: 'spawn: ' + err.message }); return; }
      setTimeout(() => ptyhost.write(termId, `Write-Output ("${marker}NODE=" + (Get-Command node -ErrorAction SilentlyContinue).Source + "|NPMDIR=" + (($env:Path -split ';') -match 'Roaming\\\\npm').Count + "|${marker}END")\r`), 900);
    });
    check('terminal resolves node by name (full user PATH reaches ptys)', r.ok, r.detail);
  }

  // 22. claude data feed (claudefeed.cjs): reducer on real probe payloads (claude
  //     2.1.284 statusLine + hook bodies, trimmed) + server round-trip
  {
    const feed = require('./claudefeed.cjs');
    const slFirst = { session_id: 'sess-1', model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5 (1M context)' },
      cost: { total_cost_usd: 0, total_lines_added: 0, total_lines_removed: 0 },
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1000000, current_usage: null, used_percentage: null, remaining_percentage: null },
      rate_limits: { five_hour: { used_percentage: 11, resets_at: 1790693400 }, seven_day: { used_percentage: 7, resets_at: 1791205200 } } };
    const slLater = { ...slFirst, session_name: 'Bash probe and task creation',
      cost: { total_cost_usd: 0.2978514, total_duration_ms: 22634, total_api_duration_ms: 7722, total_lines_added: 3, total_lines_removed: 1 },
      context_window: { total_input_tokens: 54422, total_output_tokens: 389, context_window_size: 1000000,
        current_usage: { input_tokens: 2, output_tokens: 389, cache_creation_input_tokens: 35663, cache_read_input_tokens: 18757 }, used_percentage: 5, remaining_percentage: 95 },
      prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: 1790682660, hit_ratio: 0.34 } };
    let s = feed.reduce(null, 'sl', null, slFirst);
    const firstOk = s.context === null && s.model.name === 'Opus 5.5 (1M context)' && s.rateLimits.fiveHour.pct === 11 && s.rateLimits.fiveHour.resetsAt === 1790693400;
    s = feed.reduce(s, 'sl', null, slLater);
    const laterOk = s.context && s.context.pct === 5 && s.context.used === 54422 && s.context.size === 1000000
      && s.cost === 0.2978514 && s.linesAdded === 3 && s.linesRemoved === 1 && s.sessionName === 'Bash probe and task creation'
      && s.promptCache.expiresAt === 1790682660;
    s = feed.reduce(s, 'hook', 'PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo probe', description: 'Print probe' }, tool_use_id: 'toolu_1' });
    const doingOk = s.nowDoing && s.nowDoing.tool === 'Bash' && s.nowDoing.detail === 'echo probe';
    s = feed.reduce(s, 'hook', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'echo probe' } });
    const permOk = s.attention === 'permission';
    s = feed.reduce(s, 'hook', 'Stop', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done', background_tasks: [] }, 12345);
    const stopOk = s.nowDoing === null && s.attention === null && s.lastMessage === 'done' && s.turnEndedAt === 12345;
    s = feed.reduce(s, 'hook', 'TaskCreated', { task_id: '1', task_subject: 'alpha', task_description: 'Task alpha' });
    s = feed.reduce(s, 'hook', 'TaskCompleted', { task_id: '1', task_subject: 'alpha' });
    const taskOk = s.tasks.length === 1 && s.tasks[0].subject === 'alpha' && s.tasks[0].status === 'completed';
    const same = feed.reduce(s, 'hook', 'InstructionsLoaded', { file_path: 'x' }) === s; // unmodeled → no push
    check('claude feed reducer (statusLine + hooks)', firstOk && laterOk && doingOk && permOk && stopOk && taskOk && same,
      JSON.stringify({ firstOk, laterOk, doingOk, permOk, stopOk, taskOk, same }));

    // phase 2: TaskCreate/TaskUpdate tool calls, StopFailure, question attention,
    // idle_prompt ignored, subagent counting, turnStartedAt
    let p = feed.reduce(null, 'hook', 'UserPromptSubmit', { prompt: 'x' }, 1000);
    const turnOk = p.turnStartedAt === 1000;
    p = feed.reduce(p, 'hook', 'PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'alpha', description: 'Task alpha' }, tool_response: { task: { id: '1', subject: 'alpha' } } });
    p = feed.reduce(p, 'hook', 'TaskCreated', { task_id: '1', task_subject: 'alpha', task_description: 'Task alpha' }); // no duplicate
    p = feed.reduce(p, 'hook', 'PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'beta' }, tool_response: { task: { id: '2', subject: 'beta' } } });
    p = feed.reduce(p, 'hook', 'PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress', activeForm: 'Doing alpha' }, tool_response: { success: true } });
    p = feed.reduce(p, 'hook', 'PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'completed' } });
    const tasksOk = p.tasks.length === 2 && p.tasks[0].status === 'in_progress' && p.tasks[0].activeForm === 'Doing alpha' && p.tasks[1].status === 'completed';
    p = feed.reduce(p, 'hook', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    const askOk = p.attention === 'question' && feed.attentionText(p) === 'is asking you a question';
    p = feed.reduce(p, 'hook', 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {} });
    const askClearOk = p.attention === null;
    const idle = feed.reduce(p, 'hook', 'Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    const idleOk = idle === p && idle.attention === null;
    p = feed.reduce(p, 'hook', 'SubagentStart', { agent_id: 'a' });
    p = feed.reduce(p, 'hook', 'SubagentStart', { agent_id: 'b' });
    p = feed.reduce(p, 'hook', 'SubagentStop', { agent_id: 'a' });
    const subOk = p.subagents === 1;
    p = feed.reduce(p, 'hook', 'StopFailure', { error: 'rate_limit', error_details: 'Too many requests' }, 2000);
    const failOk = p.failure && p.failure.reason === 'rate limit: Too many requests' && p.failure.at === 2000 && p.subagents === 0
      && feed.attentionText(p) === 'turn failed: rate limit: Too many requests';
    p = feed.reduce(p, 'hook', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    p = feed.reduce(p, 'hook', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const failStays = Boolean(p.failure); // only the next prompt clears it
    p = feed.reduce(p, 'hook', 'UserPromptSubmit', { prompt: 'retry' }, 3000);
    const failCleared = p.failure === null && p.attention === null && p.turnStartedAt === 3000;
    p = feed.reduce(p, 'hook', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const permText = feed.attentionText(p) === 'needs permission: Bash — npm test';
    const sub0 = feed.reduce(p, 'hook', 'SubagentStop', {}); // floor at 0
    check('claude feed reducer phase 2 (tasks, failure, question, idle, subagents)',
      turnOk && tasksOk && askOk && askClearOk && idleOk && subOk && failOk && failStays && failCleared && permText && sub0 === p,
      JSON.stringify({ turnOk, tasksOk, askOk, askClearOk, idleOk, subOk, failOk, failStays, failCleared, permText, sub0: sub0 === p }));

    // round-trip: POST /sl with x-vs-term → listener fires with the parsed context %
    const { port } = await feed.start({ resolveTerm: (id) => (id === 'smoke-t1' ? 'smoke-ws' : null) });
    const post = (p, term, body) => new Promise((resolve) => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(term ? { 'x-vs-term': term } : {}) } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', (e) => resolve({ status: 0, body: e.message }));
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    let got = null;
    let limitsGot = null;
    feed.onData((wsId, termId, st) => { got = { wsId, termId, pct: st.context && st.context.pct }; });
    feed.onLimits((l) => { limitsGot = l; });
    const r1 = await post('/sl', 'smoke-t1', slLater);
    const r2 = await post('/hook/Stop', 'nobody', { last_assistant_message: 'x' }); // unknown term: 200 + drop
    const r3 = await post('/sl', 'smoke-t1', '{not json'); // bad JSON: 200 + ignore
    const deadline = Date.now() + 2000;
    while (!got && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    const snap = feed.snapshot('smoke-ws');
    check('claude feed server round-trip (/sl → listener)', Boolean(port) && r1.status === 200 && r1.body === '{}' && r2.status === 200 && r3.status === 200
      && got && got.wsId === 'smoke-ws' && got.termId === 'smoke-t1' && got.pct === 5
      && limitsGot && limitsGot.sevenDay.pct === 7 && snap.terms['smoke-t1'] && !snap.terms.nobody,
    `port=${port} got=${JSON.stringify(got)} limits=${Boolean(limitsGot)}`);
    // settings injection: command hooks kept first, http hooks appended, statusLine
    // without refreshInterval; the user's statusLine is handed its stdin
    const cmdHook = { hooks: [{ type: 'command', command: 'echo done >> "$VIBESPACE_TERM_STATUS"', timeout: 10 }] };
    const st = feed.addSettings({ hooks: { Stop: [cmdHook] } }, { port: 4242, userCommand: null });
    const handed = feed.addSettings({ hooks: {} }, { port: 4242, userCommand: "node 'my sl.js'" });
    const noPort = feed.addSettings({ hooks: {} }, { port: null });
    check('claude feed settings injection (keeps command hooks, hand-off)', st.hooks.Stop[0] === cmdHook
      && st.hooks.Stop[1].hooks[0].url === 'http://127.0.0.1:4242/hook/Stop' && st.hooks.Stop[1].hooks[0].headers['x-vs-term'] === '$VIBESPACE_TERM_ID'
      && !st.hooks.SessionStart && st.statusLine.refreshInterval === undefined && /\/sl >\/dev\/null 2>&1; exit 0$/.test(st.statusLine.command)
      && handed.statusLine.command.includes(`vs_user='node '\\''my sl.js'\\'''`) && !noPort.statusLine && !noPort.hooks.Stop,
    st.statusLine.command.slice(0, 60));
    // account limits shared across processes via <dataRoot>/limits.json: written on
    // change; a newer file (another process) is adopted; > 6 h old is ignored
    const lf = path.join(U.dataRoot(), 'limits.json');
    const written = U.readJson(lf, null);
    const other = { fiveHour: { pct: 55, resetsAt: 1790693400 }, sevenDay: { pct: 20, resetsAt: 1791205200 } };
    U.writeJsonAtomic(lf, { at: Date.now() - 7 * 3600 * 1000, limits: { fiveHour: { pct: 99, resetsAt: 1 }, sevenDay: null } });
    const ignoredOld = feed.snapshot('smoke-ws').limits.sevenDay.pct === 7;
    U.writeJsonAtomic(lf, { at: Date.now() + 1000, limits: other });
    const adopted = feed.snapshot('smoke-ws').limits.fiveHour.pct === 55;
    check('claude feed limits.json share (write, adopt newer, ignore > 6 h)',
      Boolean(written && written.limits && written.limits.fiveHour.pct === 11 && typeof written.at === 'number') && ignoredOld && adopted,
      JSON.stringify({ written: Boolean(written), ignoredOld, adopted }));
    feed.forget('smoke-t1');
    feed.onData(() => {});
    feed.onLimits(() => {});
    feed.stop();
  }

  // 24. phase 5: prompt-cache countdown + compaction (reducer), instant attention
  //     arbitration (attention.cjs), exact session pin from the feed, bg filter
  {
    const feed = require('./claudefeed.cjs');
    // A — cache countdown math lives in the renderer module (pure export)
    const fu = await import(require('node:url').pathToFileURL(path.join(U.ROOT, 'renderer', 'workspace', 'ui', 'feedui.js')).href);
    const nowMs = 1790679068000;
    const warm = fu.cacheInfo({ warm: true, expiresAt: 1790679068 + 192 }, nowMs);
    const amber = fu.cacheInfo({ warm: true, expiresAt: 1790679068 + 45 }, nowMs);
    const hour = fu.cacheInfo({ warm: true, expiresAt: 1790679068 + 3592 }, nowMs);
    const cold = fu.cacheInfo({ warm: true, expiresAt: 1790679068 - 1 }, nowMs);
    const none = fu.cacheInfo(null, nowMs);
    const cacheOk = warm.text === 'cache warm · 3:12' && !warm.amber && amber.amber && amber.text === 'cache warm · 0:45'
      && hour.text === 'cache warm · 59:52' && cold.state === 'cold' && cold.text === 'cache cold' && none === null;
    let c = feed.reduce(null, 'sl', null, { context_window: { used_percentage: 88 }, prompt_cache: { warm: true, ttl: '1h', expires_at: 1790682660 } });
    c = feed.reduce(c, 'hook', 'PreCompact', { trigger: 'auto' }, 7);
    const compOn = c.compacting && c.compacting.trigger === 'auto' && c.compacting.at === 7 && c.promptCache.expiresAt === 1790682660;
    const c2 = feed.reduce(c, 'hook', 'PostCompact', {});
    const c3 = feed.reduce(c, 'sl', null, { context_window: { used_percentage: 12 } }); // context % back = done
    const c4 = feed.reduce(c, 'hook', 'PreCompact', null); // missing body: no crash, no change
    check('prompt-cache countdown + compaction state', cacheOk && compOn && c2.compacting === null && c3.compacting === null && c4 === c,
      JSON.stringify({ cacheOk, warm: warm.text, hour: hour.text, compOn }));

    // B — instant attention: feed flips to waiting, the stale PreToolUse `working`
    // line is ignored, the late Notification `waiting` doesn't toast twice, the
    // approved tool hands back `working`, a Stop is never clobbered
    const at = require('./attention.cjs');
    const t = at.newTerm();
    const steps = [];
    steps.push(at.fileStatus(t, 'working'));                                             // PreToolUse hook
    steps.push(at.feedState(t, { attention: 'permission', turnEndedAt: null }));         // PermissionRequest
    steps.push(at.fileStatus(t, 'working'));                                             // slow hook line lands late
    steps.push(at.fileStatus(t, 'waiting'));                                             // permission_prompt ~6 s later
    steps.push(at.feedState(t, { attention: null, turnEndedAt: null }));                 // PostToolUse: approved, runs
    const bOk = steps[0].apply === 'working' && steps[1].apply === 'waiting' && steps[1].notify === true
      && steps[2].apply === null && steps[3].apply === 'waiting' && steps[3].notify === false
      && steps[4].apply === 'working' && steps[4].notify === false; // the approved tool runs
    const t2 = at.newTerm();
    at.fileStatus(t2, 'working');
    const q1 = at.feedState(t2, { attention: 'question', turnEndedAt: 1 });
    const q2 = at.feedState(t2, { attention: null, turnEndedAt: 1 });                     // answered → working
    const t3 = at.newTerm();
    at.fileStatus(t3, 'working');
    at.feedState(t3, { attention: 'permission', turnEndedAt: 1 });
    const s3 = at.feedState(t3, { attention: null, turnEndedAt: 2 });                     // turn ended: leave it to Stop's `done`
    const d3 = at.fileStatus(t3, 'done');
    const t4 = at.newTerm();
    at.fileStatus(t4, 'done');
    const f4 = at.feedState(t4, { attention: null, failure: { reason: 'x' }, turnEndedAt: 3 }); // failure is not an ask
    check('instant attention override + one toast per episode', bOk && q1.apply === 'waiting' && q2.apply === 'working' && q2.notify === false
      && s3.apply === null && d3.apply === 'done' && d3.notify === true && f4.apply === null,
    JSON.stringify(steps.map(r => r.apply + (r.notify ? '!' : ''))));

    // C — exact session pin from the feed (only once the transcript exists; the
    // timing heuristic never overrides it afterwards)
    const BS = String.fromCharCode(92);
    const repo = 'D:' + BS + 'Repositories' + BS + 'vibespace-smoke-feedsess-' + U.randId(6);
    const dir = path.join(U.claudeProjectsDir(), U.mungeClaudeDir(repo));
    fs.mkdirSync(dir, { recursive: true });
    sessions.start('smoke-fs', repo);
    sessions.trackClaudeStart('smoke-fs', 't1');
    const idA = 'aaaaaaaa-0000-4000-8000-000000000001';
    const idB = 'bbbbbbbb-0000-4000-8000-000000000002';
    const early = sessions.pinFromFeed('smoke-fs', 't1', idA);                            // no transcript yet
    fs.writeFileSync(path.join(dir, idA + '.jsonl'), '{}');
    const pinA = sessions.pinFromFeed('smoke-fs', 't1', idA) && sessions.getSession('smoke-fs', 't1') === idA;
    fs.writeFileSync(path.join(dir, idB + '.jsonl'), '{}');                               // /clear → new session
    const s = feed.reduce(feed.reduce(null, 'sl', null, { session_id: idA }), 'hook', 'UserPromptSubmit', { session_id: idB });
    const pinB = s.sessionId === idB && sessions.pinFromFeed('smoke-fs', 't1', s.sessionId) && sessions.getSession('smoke-fs', 't1') === idB;
    sessions.trackClaudeStart('smoke-fs', 't1');                                           // relaunch in the same tab
    fs.writeFileSync(path.join(dir, 'cccccccc-0000-4000-8000-000000000003.jsonl'), '{}');
    sessions._scan('smoke-fs');
    const kept = sessions.getSession('smoke-fs', 't1') === idB && sessions.pinFromFeed('smoke-fs', 't1', idB) === false;
    sessions.stop('smoke-fs');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    check('session pinned from feed session_id (/clear re-pins, heuristic never overrides)', early === false && pinA && pinB && kept,
      JSON.stringify({ early, pinA, pinB, kept }));

    // D — background agents: only kind=background under the repo, newest first
    const bg = require('./bgagents.cjs');
    const list = [
      { id: '6ce06036', kind: 'background', cwd: repo + BS + 'sub', startedAt: 2, name: 'fix it', status: 'busy', state: 'working' },
      { id: 'aa11bb22', kind: 'background', cwd: repo, startedAt: 3, name: 'newer', status: 'idle', state: 'done' },
      { sessionId: 'x', kind: 'interactive', cwd: repo, startedAt: 4, name: 'tab' },
      { id: 'dd33ee44', kind: 'background', cwd: repo + 'suffix', startedAt: 5 },        // sibling prefix: not ours
      { id: 'bad id!', kind: 'background', cwd: repo, startedAt: 6 },
    ];
    const got = bg.filterBg(list, repo).map(a => a.id);
    check('background agents filter (kind, cwd under repo, id check)', JSON.stringify(got) === '["aa11bb22","6ce06036"]', JSON.stringify(got));
  }

  // 23. agent board summary (main/board.cjs): shape, write, other-workspace read
  //     with freshness filter, delete on close
  {
    const board = require('./board.cjs');
    const feed = require('./claudefeed.cjs');
    let fs1 = feed.reduce(null, 'hook', 'UserPromptSubmit', {}, 1);
    fs1 = feed.reduce(fs1, 'hook', 'PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'a' }, tool_response: { task: { id: '1' } } });
    fs1 = feed.reduce(fs1, 'hook', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    fs1 = feed.reduce(fs1, 'hook', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const terminals = [{ termId: 'a1', name: 'agent-1', isClaude: true }, { termId: 's1', name: 'term-1', isClaude: false }];
    const make = () => board.buildSummary({ wsId: 'smoke-board', name: 'Smoke', terminals,
      statusOf: (id) => (id === 'a1' ? 'waiting' : undefined), feedOf: (id) => (id === 'a1' ? fs1 : null), reasonOf: feed.attentionText, now: 5 });
    const sum = make();
    const a = sum.agents[0];
    const shapeOk = sum.name === 'Smoke' && sum.updatedAt === 5 && sum.agents.length === 1 && a.name === 'agent-1' && a.status === 'waiting'
      && a.reason === 'needs permission: Bash — npm test' && a.nowDoing === 'Bash npm test' && a.tasks.done === 0 && a.tasks.total === 1 && a.failed === false;
    board.start('smoke-board', () => ({ ...make(), updatedAt: Date.now() }));
    await new Promise(r => setTimeout(r, 300));
    const file = board._file('smoke-board');
    const written = U.readJson(file, null);
    // another (fresh) workspace + a stale one; readOthers from a third id sees only the fresh
    U.writeJsonAtomic(board._file('smoke-stale'), { ...sum, wsId: 'smoke-stale', name: 'Stale', updatedAt: Date.now() - 3 * 60 * 1000 });
    const seen = board.readOthers('someone-else').map(w => w.wsId);
    const selfHidden = !board.readOthers('smoke-board').some(w => w.wsId === 'smoke-board');
    board.stop('smoke-board');
    const deleted = !fs.existsSync(file);
    try { fs.rmSync(board._file('smoke-stale'), { force: true }); } catch {}
    check('agent board summary (shape, write, fresh-only read, delete on close)',
      shapeOk && written && written.agents.length === 1 && seen.includes('smoke-board') && !seen.includes('smoke-stale') && selfHidden && deleted,
      JSON.stringify({ shapeOk, written: Boolean(written), seen, selfHidden, deleted }));
  }

  // 23. away mode (presence.cjs): pure transitions + marker path + pty env. Never
  //     start()/set() here — that would touch the shared presence state
  {
    const presence = require('./presence.cjs');
    const d = presence.decide;
    const eq = (r, mode, armed) => r.mode === mode && r.armed === armed;
    const rules = {
      presentToIdle: eq(d('present', 600, false), 'idle', false) && eq(d('present', 599, false), 'present', false),
      awayStaysUnarmed: eq(d('away', 0, false), 'away', false),
      awayArms: eq(d('away', 120, false), 'away', true),
      armedStaysAway: eq(d('away', 60, true), 'away', true),
      armedReturns: eq(d('away', 29, true), 'present', false),
      idleReturns: eq(d('idle', 29, false), 'present', false) && eq(d('idle', 30, false), 'idle', false),
    };
    check('presence.decide transitions', Object.values(rules).every(Boolean), JSON.stringify(rules));
    const marker = presence.markerPath();
    check('presence marker lives under dataRoot', marker === path.join(U.dataRoot(), 'presence', 'at-pc'), marker);
    const r = await new Promise((resolve) => {
      let buf = '';
      const termId = 'smokepres';
      const tag = `__PRES_${Date.now()}__`;
      const timer = setTimeout(() => { ptyhost.onData(() => {}); ptyhost.kill(termId); resolve({ ok: false, detail: 'timeout: ' + buf.slice(-200) }); }, 20000);
      ptyhost.onData((id, chunk) => {
        if (id !== termId) return;
        buf += chunk;
        const flat = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '');
        // the echoed command has a quote right after "P="; the OUTPUT does not
        const m = flat.match(new RegExp(tag + 'P=([^"|]*)\\|' + tag + 'END'));
        if (!m) return;
        clearTimeout(timer);
        ptyhost.onData(() => {});
        ptyhost.kill(termId);
        resolve({ ok: m[1].trim().toLowerCase() === marker.toLowerCase(), detail: m[1].trim() || 'NOT SET' });
      });
      try { ptyhost.create(termId, U.BIN_ROOT, 200, 30); } catch (err) { clearTimeout(timer); resolve({ ok: false, detail: 'spawn: ' + err.message }); return; }
      setTimeout(() => ptyhost.write(termId, `Write-Output ("${tag}P=" + $env:CLAUDE_CLIENT_PRESENCE_FILE + "|${tag}END")\r`), 900);
    });
    check('pty env carries CLAUDE_CLIENT_PRESENCE_FILE', r.ok, r.detail);
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
