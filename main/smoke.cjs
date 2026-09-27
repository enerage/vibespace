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
