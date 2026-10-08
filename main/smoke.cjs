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

// Orphaned MCP servers (2026-09-29: 124 mcp-postgres node processes): claude
// starts MCP stdio servers HIDDEN through `cmd /c`, so they are not attached to
// the pseudoconsole and survived the pty close. Mirror that without claude: a
// "fake claude" in the pty spawns `cmd /c <node> leaf.js` with windowsHide, and
// the leaf ignores stdin EOF. kill() must take the leaf down with the tab and
// leave other tabs' trees alone; killAll() (window close / quit) takes the rest.
async function ptyTreeKillTest() {
  if (!ptyhost.available()) return { ok: false, detail: 'node-pty unavailable' };
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-smoke-tree-'));
  const leafJs = path.join(dir, 'leaf.js');
  const fakeJs = path.join(dir, 'fakeclaude.js');
  fs.writeFileSync(leafJs, [
    "require('fs').writeFileSync(process.argv[2], String(process.pid));",
    "process.stdin.on('data', () => {}); process.stdin.on('end', () => {}); process.stdin.on('error', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.writeFileSync(fakeJs, [
    "const { spawn } = require('child_process');",
    'const c = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" "${process.argv[2]}" "${process.argv[3]}""`],',
    "  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true });",
    "c.stdout.on('data', () => {}); c.stderr.on('data', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200); } return fn(); };
  const ids = ['smoketree1', 'smoketree2'];
  const leafPid = {};
  try {
    for (const id of ids) {
      ptyhost.create(id, U.BIN_ROOT, 160, 30);
      const pidFile = path.join(dir, `${id}.pid`);
      await sleep(1200);
      // ELECTRON_RUN_AS_NODE: the Electron binary runs the scripts as plain node
      // (packaged too); the hidden cmd and the leaf inherit it
      ptyhost.write(id, `$env:ELECTRON_RUN_AS_NODE='1'; & "${process.execPath}" "${fakeJs}" "${leafJs}" "${pidFile}"\r`);
      leafPid[id] = await waitFor(() => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch { return 0; } }, 15000);
      if (!leafPid[id]) return { ok: false, detail: `${id}: hidden leaf never started` };
    }
    const [a, b] = ids.map(id => leafPid[id]);
    if (!alive(a) || !alive(b)) return { ok: false, detail: `leaves not alive before kill: ${a}=${alive(a)} ${b}=${alive(b)}` };
    ptyhost.kill(ids[0]);
    const goneA = await waitFor(() => !alive(a), 8000);
    const keptB = alive(b) && ptyhost.alive(ids[1]);
    ptyhost.killAll(); // synchronous tree kill
    const goneB = await waitFor(() => !alive(b), 3000);
    const ok = goneA && keptB && goneB;
    for (const pid of [a, b]) { if (alive(pid)) { try { process.kill(pid); } catch {} } }
    return { ok, detail: `kill(): leaf ${a} gone=${goneA}, other tab's leaf ${b} kept=${keptB}; killAll(): leaf ${b} gone=${goneB}` };
  } catch (err) {
    return { ok: false, detail: 'threw: ' + (err && err.message ? err.message : err) };
  } finally {
    for (const id of ids) ptyhost.kill(id);
    for (const pid of Object.values(leafPid)) { if (pid && alive(pid)) { try { process.kill(pid); } catch {} } }
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 2000);
  }
}

// create() on a live termId: the old pty's exit (it closes only after its tree
// kill, ~1 s) must not clean up or report the NEW pty as exited
async function ptyRecreateTest() {
  if (!ptyhost.available()) return { ok: false, detail: 'node-pty unavailable' };
  const id = 'smokerecreate';
  try {
    ptyhost.create(id, U.BIN_ROOT, 120, 30);
    await new Promise(r => setTimeout(r, 1200));
    ptyhost.create(id, U.BIN_ROOT, 120, 30); // kills the first
    await new Promise(r => setTimeout(r, 4000));
    const ok = ptyhost.alive(id) && ptyhost.list().some(p => p.termId === id);
    return { ok, detail: `alive after old pty exit: ${ok}` };
  } catch (err) {
    return { ok: false, detail: 'threw: ' + (err && err.message ? err.message : err) };
  } finally {
    ptyhost.kill(id);
  }
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
  {
    // a logo change must land at a NEW icon path (Windows caches taskbar icons by
    // path); the first icon stays, older versioned ones are pruned
    const first = ws.iconPath;
    const a = await workspaces.updateLogo(ws.id, tmpPng, 1_000_000);
    const pathA = a.iconPath;
    const b = await workspaces.updateLogo(ws.id, tmpPng, 2_000_000);
    const pathB = b.iconPath;
    const c = await workspaces.updateLogo(ws.id, tmpPng, 3_000_000);
    const versioned = (p) => path.basename(p).startsWith(ws.id + '.v') && p.endsWith('.ico');
    check('logo change gets a new icon path each time; old versions pruned',
      pathA !== first && pathB !== pathA && c.iconPath !== pathB && versioned(pathA) && versioned(c.iconPath)
      && fs.existsSync(c.iconPath) && fs.existsSync(pathB) && !fs.existsSync(pathA) && fs.existsSync(first)
      && workspaces.get(ws.id).iconPath === c.iconPath,
      JSON.stringify([first, pathA, pathB, c.iconPath].map(p => path.basename(p))));
  }
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
    // crash-safe JSON: a reboot-damaged file (NUL bytes) restores the last good
    // copy from .bak, is kept for diagnosis, and is reported — never silent
    {
      const os = require('node:os');
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-json-'));
      const f = path.join(d, 'state.json');
      const seen = [];
      U.onCorruptJson((m) => seen.push(m));
      U.writeJsonAtomic(f, { v: 1 });
      U.writeJsonAtomic(f, { v: 2 });
      fs.writeFileSync(f, Buffer.alloc(256)); // what a hard reboot can leave behind
      const back = U.readJson(f, {});
      const kept = fs.readdirSync(d).some((n) => n.startsWith('state.json.corrupt-'));
      U.writeJsonAtomic(f, { v: 3 });
      const after = U.readJson(f, {});
      U.onCorruptJson(null);
      check('json survives reboot damage (.bak restore, kept, reported)', back.v === 1 && kept && seen.length === 1 && after.v === 3,
        JSON.stringify({ back, kept, seen: seen.length, after }));
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    // notification prefs: defaults toast only when you're needed; junk ignored
    {
      const np = require('./notifyprefs.cjs');
      const d = np._normalize(null);
      const mixed = np._normalize({ done: true, waiting: 'yes', failed: false, extra: 1 });
      check('notify prefs defaults + normalize', d.waiting === true && d.failed === true && d.done === false
        && mixed.done === true && mixed.waiting === true && mixed.failed === false && !('extra' in mixed), JSON.stringify({ d, mixed }));
    }
    const statusMod = require('./status.cjs');
    // tab ↔ conversation audit trail (tablog): open snapshot, session change,
    // close, and the one-time "looks like an agent but untracked" warning
    {
      const tl = require('./tablog.cjs');
      const t0 = 1_000_000;
      const open = tl.diff('smk', [{ termId: 'a', name: 'A', isClaude: true, claudeSessionId: null }, { termId: 'b', name: 'B', isClaude: false }], t0);
      const pin = tl.diff('smk', [{ termId: 'a', name: 'A', isClaude: true, claudeSessionId: 's1' }, { termId: 'b', name: 'B', isClaude: false }], t0 + 1000);
      const gone = tl.diff('smk', [{ termId: 'b', name: 'B', isClaude: false }], t0 + 2000);
      const late = t0 + tl.UNTRACKED_AFTER_MS + 5000;
      const w1 = tl.audit('smk', null, { hasFeed: (id) => id === 'b' }, late);
      const w2 = tl.audit('smk', null, { hasFeed: (id) => id === 'b' }, late + 1000);
      tl.forget('smk');
      check('tab log: open/session/close + untracked warning once',
        open[0] === 'open: 2 tabs' && pin.some(l => l.includes('session — → s1')) && gone.some(l => l.startsWith('- "A"'))
        && w1.length === 1 && w1[0].includes('"B"') && w1[0].includes('live claude feed') && w2.length === 0,
        JSON.stringify({ open, pin, gone, w1, w2 }));
    }
    // parked agents: tablog shelf lines, main's state merge + the .bak round
    // trip keep `parked`, restore never turns a parked entry into a tab
    {
      const tl = require('./tablog.cjs');
      const P = (id, name, sid) => ({ id, name, claudeSessionId: sid, parkedAt: 1 });
      const o = tl.diff('smkp', [{ termId: 'a', name: 'A', isClaude: true, claudeSessionId: 's1' }], 0, [P('p0', 'old', 's0')]);
      const pk = tl.diff('smkp', [], 1, [P('p0', 'old', 's0'), P('p1', 'A', 's1')]);
      const un = tl.diff('smkp', [{ termId: 'b', name: 'A', isClaude: true, claudeSessionId: 's1' }], 2, [P('p0', 'old', 's0')]);
      const fg = tl.diff('smkp', [{ termId: 'b', name: 'A', isClaude: true, claudeSessionId: 's1' }], 3, []);
      tl.forget('smkp');
      check('tab log: parked / unparked / forgot lines + parked in the open snapshot',
        o[0] === 'open: 1 tab, 1 parked' && o.includes('  parked "old" session=s0')
        && pk.includes('parked "A" session=s1') && pk.some(l => l.startsWith('- "A"'))
        && un.includes('unparked "A" session=s1') && fg.includes('forgot "old" session=s0'),
        JSON.stringify({ o, pk, un, fg }));

      const os = require('node:os');
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-park-'));
      sessions.start('smk-park', d);
      sessions.pinSession('smk-park', 't1', 'live-sid');
      const shelf = [{ id: 'p1', name: 'agent-3', cwd: d, isClaude: true, claudeSessionId: 'parked-sid', worktree: null, account: null, parkedAt: 5, lastMessage: 'hi', model: 'Haiku' }];
      const merged = sessions.enrichState('smk-park', { terminals: [{ termId: 't1', name: 'a1', claudeSessionId: null }], parked: shelf });
      const kept = sessions.enrichState('smk-park', { terminals: [] }, shelf); // a snapshot without the key
      const fresh = sessions.enrichState('smk-park', { terminals: [] }, null);
      sessions.stop('smk-park');
      const f = path.join(d, 'state.json');
      U.writeJsonAtomic(f, merged);
      U.writeJsonAtomic(f, { ...merged, terminals: [] });
      fs.writeFileSync(f, Buffer.alloc(128)); // reboot damage → .bak
      U.onCorruptJson(() => {});
      const back = U.readJson(f, {});
      U.onCorruptJson(null);
      check('parked survives main\'s state merge + writeJsonAtomic/.bak round trip',
        merged.terminals[0].claudeSessionId === 'live-sid' && JSON.stringify(merged.parked) === JSON.stringify(shelf)
        && JSON.stringify(kept.parked) === JSON.stringify(shelf) && Array.isArray(fresh.parked) && fresh.parked.length === 0
        && back.parked && back.parked[0].claudeSessionId === 'parked-sid' && back.parked[0].lastMessage === 'hi',
        JSON.stringify({ merged: merged.parked, kept: kept.parked, back: back.parked }));

      // the last reply of a transcript with no feed: last assistant TEXT, tail only
      const tx = path.join(d, 'tx.jsonl');
      fs.writeFileSync(tx, [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'first reply' }] } }),
        JSON.stringify({ type: 'user', message: { content: 'go on' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'PONG\nline two' }] } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
        JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error' }] } }),
        '',
      ].join('\n'));
      const lr = sessions.lastReplyOf(tx);
      check('parked: last reply from the transcript tail (skips tool-only + API error lines)',
        lr && lr.text === 'PONG\nline two' && lr.model === 'claude-haiku-4-5', JSON.stringify(lr));

      const pkm = await import(require('node:url').pathToFileURL(path.join(U.ROOT, 'renderer', 'workspace', 'ui', 'parked.js')).href);
      const saved = [
        { termId: 'a', name: 'agent-1', claudeSessionId: 'live' },
        { termId: 'b', name: 'agent-3', claudeSessionId: 'parked-sid' }, // crash between save and kill
        { termId: 'c', name: 'term-1', claudeSessionId: null },
      ];
      const plan = pkm.restorable(saved, [...shelf, { name: 'junk' }]).map(t => t.termId).join(',');
      const norm = pkm.normalizeParked([{ id: 'x', name: 'old', claudeSessionId: 'o', parkedAt: 1 }, ...shelf, { claudeSessionId: 'o', parkedAt: 9 }, null, { name: 'no-sid' }]);
      const names = [pkm.uniqueName('agent-3', ['agent-1']), pkm.uniqueName('agent-3', ['agent-3', 'agent-3-2'])];
      const entry = pkm.makeEntry({ name: 'n', cwd: 'C:\\r', sessionId: 's', worktree: null, account: 'login' }, { lastMessage: 'x'.repeat(3000), model: 'Haiku', now: 7 });
      check('parked: restore skips the shelf (never auto-resumed), normalize, -2 names, entry shape',
        plan === 'a,c' && norm.map(e => e.name).join(',') === 'agent-3,old' && names.join(',') === 'agent-3,agent-3-3'
        && entry.claudeSessionId === 's' && entry.parkedAt === 7 && entry.lastMessage.length === 2000 && entry.isClaude === true,
        JSON.stringify({ plan, norm: norm.map(e => e.name), names, len: entry.lastMessage.length }));
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    // tab auto-name: claude's title / the /rename name from a transcript →
    // a short, unique tab name; a default-looking /rename name is ignored
    {
      const os = require('node:os');
      const ss = require('./sessions.cjs');
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-title-'));
      const f = path.join(d, 't.jsonl');
      const line = (o) => JSON.stringify(o) + '\n';
      fs.writeFileSync(f, line({ type: 'user', message: { content: 'hi' } })
        + line({ type: 'ai-title', aiTitle: 'Tab rename focus loss', sessionId: 's' })
        + line({ type: 'assistant', message: { content: 'x'.repeat(400) } })
        + line({ type: 'ai-title', aiTitle: 'Tab rename focus loss', sessionId: 's' }));
      const onlyAi = ss.titlesOf(f);
      fs.appendFileSync(f, line({ type: 'custom-title', customTitle: 'My Repo · agent-3', sessionId: 's' }));
      const defaultCustom = ss.tabNameFrom(ss.titlesOf(f), 'My Repo', []);
      fs.appendFileSync(f, line({ type: 'custom-title', customTitle: 'My Repo · MULTISUB', sessionId: 's' }));
      const custom = ss.tabNameFrom(ss.titlesOf(f), 'My Repo', []);
      const long = ss.tabNameFrom({ ai: 'Click and add spacing availability issue in the calendar' }, '', []);
      const dup = ss.tabNameFrom({ ai: 'Login page timeout' }, '', ['login page timeout', 'Login page timeout 2']);
      const other = ss.tabNameFrom({ custom: 'Someone · Else' }, 'My Repo', []);
      check('tab auto-name from transcript titles (ai, /rename, shorten, unique)',
        onlyAi.ai === 'Tab rename focus loss' && onlyAi.custom === null
        && defaultCustom.name === 'Tab rename focus loss' && defaultCustom.from === 'ai'
        && custom.name === 'MULTISUB' && custom.from === 'custom'
        && long.name.length <= 30 && long.name.endsWith('…') && long.name.startsWith('Click and add spacing')
        && dup.name === 'Login page timeout 3' && other.name === 'Someone · Else'
        && ss.tabNameFrom({ ai: null, custom: null }, 'x', []) === null && ss.tabNameFrom(ss.titlesOf(path.join(d, 'missing.jsonl')), 'x', []) === null,
        JSON.stringify({ onlyAi, defaultCustom, custom, long, dup, other }));
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    // logo picker scan (logoscan): ranks the logo first, never looks in
    // node_modules / build output / dot-folders, drops unreadable images
    {
      const os = require('node:os');
      const ls = require('./logoscan.cjs');
      const sharp = require('sharp');
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-logo-'));
      const png = async (w, h) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 90, g: 120, b: 255, alpha: 1 } } }).png().toBuffer();
      const put = (rel, buf) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
      const sq = await png(128, 128);
      put('public/logo.png', sq);
      put('public/favicon-32.png', await png(32, 32));
      put('docs/screenshot.png', await png(800, 500));
      put('src/assets/banner-logo.png', await png(900, 120));
      put('node_modules/pkg/logo.png', sq);
      put('.next/static/logo.png', sq);
      put('dist/logo.png', sq);
      put('.claude/worktrees/x/public/logo.png', sq);
      put('public/broken-logo.png', Buffer.from('this is not an image, but it is long enough to pass the size floor. '.repeat(3)));
      const found = await ls.scan(d);
      const rels = found.map(c => c.rel);
      check('logo scan: logo first, node_modules/build/dot-folders skipped, broken image dropped',
        rels[0] === 'public/logo.png' && rels.includes('public/favicon-32.png') && rels.includes('docs/screenshot.png')
        && rels.indexOf('docs/screenshot.png') > rels.indexOf('public/favicon-32.png')
        && !rels.some(r => /node_modules|\.next|^dist\/|\.claude|broken/.test(r))
        && found[0].w === 128 && found[0].thumb.startsWith('data:image/png;base64,')
        && ls.score('public/logo.svg') > ls.score('src/components/hero-banner.png'),
        JSON.stringify(rels));
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    // typing-lag log (lagmon): echo timer, threshold, throttle, key filter
    {
      const lm = require('./lagmon.cjs');
      const t0 = 2_000_000;
      lm.noteInput('lagT', 'x', t0);
      lm.noteInput('lagT', 'y', t0 + 100); // still pending: first key wins
      lm.noteOutput('lagT', t0 + 1300);
      const fast = lm.report({ kind: 'typing', termId: 'lagT', name: 'A', ms: 120 }, t0 + 1400);
      const slow = lm.report({ kind: 'typing', termId: 'lagT', name: 'A', ms: 1400 }, t0 + 1400);
      const again = lm.report({ kind: 'typing', termId: 'lagT', name: 'A', ms: 900 }, t0 + 5000);
      const later = lm.report({ kind: 'typing', termId: 'lagT', name: 'A', ms: 900 }, t0 + 20000);
      lm.forget('lagT');
      check('typing-lag log: echo time, threshold, throttle',
        fast === null && /typing "A" \(lagT\) key→screen 1400ms · claude\/pty echo 1300ms/.test(slow || '') && again === null
        && /\(\+1 more since last line\)/.test(later || '') && lm._isKey('a') && lm._isKey('\x7f') && !lm._isKey('\x1b[A') && !lm._isKey('paste'),
        JSON.stringify({ fast, slow, again, later }));
    }
    // HTTP-hook → status word (replaces the blocking Git Bash echo hooks)
    const w = statusMod.wordForHook;
    check('status word from HTTP hooks', w('UserPromptSubmit', {}) === 'working' && w('PreToolUse', { tool_name: 'Bash' }) === 'working'
      && w('Stop', {}) === 'done' && w('Notification', { message: 'Claude needs your permission to use Bash' }) === 'waiting'
      && w('Notification', { message: 'Claude is waiting for your input' }) === null && w('PostToolUse', {}) === null);
    // background work: a turn that ends with subagents / shells still running.
    // The event shapes are the ones captured from claude 2.1.289 (2026-10-06).
    {
      const cf = require('./claudefeed.cjs');
      const at = require('./attention.cjs');
      const sub = { id: 'a03c', type: 'subagent', status: 'running', description: 'Sleep 20 then reply', agent_type: 'general-purpose' };
      const sh = { id: 'bdue', type: 'shell', status: 'running', description: 'Sleep in background', command: 'sleep 40' };
      let s = cf.reduce(undefined, 'hook', 'UserPromptSubmit', {});
      s = cf.reduce(s, 'hook', 'PreToolUse', { tool_name: 'Agent', tool_input: {} });
      s = cf.reduce(s, 'hook', 'SubagentStart', { agent_id: 'a03c' });
      const during = cf.reduce(s, 'hook', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, agent_id: 'a03c' }); // foreground: still the turn's "now"
      s = cf.reduce(s, 'hook', 'Stop', { last_assistant_message: 'started', background_tasks: [sub, sh] });
      const ended = s;
      s = cf.reduce(s, 'hook', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 20' }, agent_id: 'a03c' });
      const subTool = s;
      s = cf.reduce(s, 'hook', 'SubagentStop', { agent_id: 'a03c', background_tasks: [sub, sh] }); // still lists itself
      const subDone = s;
      s = cf.reduce(s, 'hook', 'UserPromptSubmit', { prompt: '<task-notification>' });
      const woke = s;
      s = cf.reduce(s, 'hook', 'Stop', { background_tasks: [{ ...sh, status: 'completed' }] });
      const old = cf.reduce(cf.reduce(undefined, 'hook', 'UserPromptSubmit', {}), 'hook', 'Stop', {}); // older claude: no list
      // a background subagent asks for permission AFTER the turn ended: answered → back to done, not working
      const t = at.newTerm();
      at.fileStatus(t, 'done');
      const ask = at.feedState(t, { attention: 'permission', turnEndedAt: 5 });
      const back = at.feedState(t, { attention: null, turnEndedAt: 5 });
      const t2 = at.newTerm();
      at.fileStatus(t2, 'working');
      at.feedState(t2, { attention: 'permission', turnEndedAt: null });
      const back2 = at.feedState(t2, { attention: null, turnEndedAt: null });
      check('background work: Stop keeps running tasks, subagent tools never flip the turn',
        during.nowDoing && during.nowDoing.tool === 'Bash' && !during.bgNow
        && ended.background.length === 2 && ended.background[1].command === 'sleep 40' && ended.subagents === 1 && !ended.nowDoing
        && subTool.bgNow && subTool.bgNow.tool === 'Bash' && !subTool.nowDoing
        && subDone.background.length === 1 && subDone.background[0].type === 'shell' && !subDone.bgNow
        && woke.background.length === 1 && woke.turnOpen === true
        && s.background.length === 0 && old.background.length === 0
        && w('PreToolUse', { tool_name: 'Bash', agent_id: 'a03c' }) === null && w('PreToolUse', { tool_name: 'Bash' }) === 'working'
        && ask.apply === 'waiting' && back.apply === 'done' && back2.apply === 'working',
        JSON.stringify({ ended: ended.background.map(x => x.type), subDone: subDone.background.map(x => x.type), back: back.apply, back2: back2.apply }));
    }
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
    check('ignore-path filter', U.isIgnoredPath('src/node_modules/pkg/x.js') === true && U.isIgnoredPath('a/b.tsbuildinfo') === true && U.isIgnoredPath('src/new-file.ts') === false
      && U.isIgnoredPath('.claude/worktrees/agent-5/src/a.js') === true && U.isIgnoredPath('.claude/settings.json') === false
      && U.isIgnoredPath('src/worktrees/a.js') === false, '');
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

      // 17c. worktree tabs (main/worktrees.cjs) on a dirty main tree
      {
        const wt = require('./worktrees.cjs');
        fs.writeFileSync(path.join(root, 'b.txt'), 'main tree edit'); // dirty main tree
        const a = await wt.create(root, 'Agent 5');
        const b = await wt.create(root, 'agent-5'); // folder + branch taken → -2
        const excl = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/).filter(l => l === '/.claude/worktrees/').length;
        const st = await new Promise((res) => {
          let out = '';
          const p = require('node:child_process').spawn('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, windowsHide: true });
          p.stdout.on('data', (d) => { out += d; });
          p.on('close', () => res(out));
        });
        check('worktrees.create: path/branch/base, unique -2, exclude line once, main status clean of it',
          a.ok && a.name === 'agent-5' && a.branch === 'vs/agent-5' && a.path === path.join(root, '.claude', 'worktrees', 'agent-5') && fs.existsSync(path.join(a.path, 'a.txt')) === false
          && fs.existsSync(path.join(a.path, 'b.txt')) && fs.readFileSync(path.join(a.path, 'b.txt'), 'utf8') !== 'main tree edit'
          && b.ok && b.name === 'agent-5-2' && b.base === a.base && excl === 1 && !st.includes('.claude'),
          JSON.stringify({ a: a.ok && [a.name, a.branch, a.base], b: b.ok && b.name, excl, st }));
        // work in b: one commit + one uncommitted file
        const inB = (args) => new Promise((res) => {
          const p = require('node:child_process').spawn('git', args, { cwd: b.path, windowsHide: true });
          p.on('close', (c) => res(c === 0));
        });
        fs.writeFileSync(path.join(b.path, 'new.txt'), 'x');
        await inB(['add', 'new.txt']);
        await inB(['commit', '-m', 'wt work']);
        fs.writeFileSync(path.join(b.path, 'loose.txt'), 'y');
        const ls = await wt.list(root);
        const la = ls && ls.find(w => w.name === 'agent-5');
        const lb = ls && ls.find(w => w.name === 'agent-5-2');
        check('worktrees.list: dirty/ahead/merged/exists', la && la.dirty === 0 && la.ahead === 0 && la.merged && la.exists
          && lb && lb.dirty === 1 && lb.ahead === 1 && !lb.merged && lb.loss === '1 commit not merged · 1 uncommitted file',
          JSON.stringify(ls && ls.map(w => [w.name, w.dirty, w.ahead, w.merged, w.loss])));
        // an unknown count (git failed / base branch gone) must read as a loss, never as "safe to delete"
        const closed = [wt.lossText({ ahead: null, dirty: 0 }), wt.lossText({ ahead: 0, dirty: null }), wt.lossText({ ahead: 0, merged: true, dirty: 0 })];
        check('worktrees.lossText fails closed on unknown counts', closed[0] !== '' && closed[1] !== '' && closed[2] === '', JSON.stringify(closed));
        const refused = await wt.remove(root, 'agent-5-2');
        const safe = await wt.remove(root, 'agent-5');
        const discarded = await wt.remove(root, 'agent-5-2', { discard: true });
        const branches = await new Promise((res) => {
          let out = '';
          const p = require('node:child_process').spawn('git', ['branch', '--list', 'vs/*'], { cwd: root, windowsHide: true });
          p.stdout.on('data', (d) => { out += d; });
          p.on('close', () => res(out.trim()));
        });
        const left = await wt.list(root);
        check('worktrees.remove: safe refuses work, removes clean, discard forces, branches deleted',
          refused.ok === false && refused.kept === true && /1 commit not merged/.test(refused.reason)
          && safe.ok && !fs.existsSync(a.path) && discarded.ok && !fs.existsSync(b.path) && branches === '' && left && left.length === 0,
          JSON.stringify({ refused, safe, discarded, branches, left: left && left.length }));
        check('worktrees on a non-repo: create refuses, list null', (await wt.create(empty, 'x')).ok === false && (await wt.list(empty)) === null);
        // copyEnv: untracked .env* from the repo root, a tracked one never overwritten
        const inRoot = (args) => new Promise((res) => {
          const p = require('node:child_process').spawn('git', args, { cwd: root, windowsHide: true });
          p.on('close', (c) => res(c === 0));
        });
        fs.writeFileSync(path.join(root, '.env.example'), 'tracked');
        await inRoot(['add', '.env.example']);
        await inRoot(['commit', '-m', 'env example']);
        fs.writeFileSync(path.join(root, '.env.example'), 'local edit');
        fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
        const c = await wt.create(root, 'env-agent', { copyEnv: true });
        const plain = await wt.create(root, 'env-plain');
        const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
        check('worktrees.create copyEnv: untracked .env* copied, tracked kept, off by default',
          c.ok && JSON.stringify(c.copied) === '[".env"]' && rd(path.join(c.path, '.env')) === 'SECRET=1'
          && rd(path.join(c.path, '.env.example')) === 'tracked'
          && plain.ok && plain.copied.length === 0 && rd(path.join(plain.path, '.env')) === null,
          JSON.stringify({ c: c.ok && c.copied, plain: plain.ok && plain.copied }));
        if (c.ok) await wt.remove(root, c.name, { discard: true });
        if (plain.ok) await wt.remove(root, plain.name, { discard: true });
      }
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

    // C2 — worktree tabs: the transcript lives in munged(<worktree>), outside
    // the repo's dir. The feed's transcript_path pins it; sessionExists finds
    // it with the tab's cwd; the timing heuristic never hands an offRepo term a
    // repo-dir file.
    {
      const wtCwd = repo + BS + '.claude' + BS + 'worktrees' + BS + 'agent-1';
      const repoDir = path.join(U.claudeProjectsDir(), U.mungeClaudeDir(repo));
      const wtDir = path.join(U.claudeProjectsDir(), U.mungeClaudeDir(wtCwd));
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(wtDir, { recursive: true });
      const idW = 'dddddddd-0000-4000-8000-000000000004';
      const tp = path.join(wtDir, idW + '.jsonl');
      sessions.start('smoke-wt', repo);
      sessions.trackClaudeStart('smoke-wt', 'tw', { offRepo: true });
      fs.writeFileSync(path.join(repoDir, 'eeeeeeee-0000-4000-8000-000000000005.jsonl'), '{}'); // a repo-root agent's file
      sessions._scan('smoke-wt');
      const notStolen = sessions.getSession('smoke-wt', 'tw') === null;
      const st = feed.reduce(null, 'hook', 'UserPromptSubmit', { session_id: idW, transcript_path: tp });
      const tooEarly = sessions.pinFromFeed('smoke-wt', 'tw', st.sessionId, st.transcriptPath); // not written yet
      fs.writeFileSync(tp, '{}');
      const wrongName = sessions.pinFromFeed('smoke-wt', 'tw', 'ffffffff-0000-4000-8000-000000000006', tp); // stale path
      const pinned = sessions.pinFromFeed('smoke-wt', 'tw', st.sessionId, st.transcriptPath) && sessions.getSession('smoke-wt', 'tw') === idW;
      const slTp = feed.reduce(null, 'sl', null, { session_id: idW, transcript_path: tp }).transcriptPath === tp;
      check('worktree tab: pin from transcript_path outside the repo dir (offRepo skips heuristic)',
        st.transcriptPath === tp && slTp && notStolen && tooEarly === false && wrongName === false && pinned,
        JSON.stringify({ slTp, notStolen, tooEarly, wrongName, pinned }));
      const withCwd = sessions.sessionExists('smoke-wt', idW, wtCwd);
      const repoOnly = sessions.sessionExists('smoke-wt', idW);
      const lowerCwd = sessions.sessionExists('smoke-wt', idW, wtCwd.toLowerCase());
      check('worktree tab: sessionExists checks the worktree cwd\'s project dir', withCwd === true && repoOnly === false && lowerCwd === true,
        JSON.stringify({ withCwd, repoOnly, lowerCwd }));
      sessions.stop('smoke-wt');
      for (const d of [repoDir, wtDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    }

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

  // 23b. the shell's `claude` wrapper (ptyhost CLAUDE_WRAPPER): a hand-typed claude
  //      gets --remote-control + --settings; subcommands / -p / flags already given
  //      pass through untouched. Dry-run prints the final args instead of launching.
  {
    const cases = [
      ['claude --resume abc', '--resume|abc|--remote-control|WS · t1|--settings|S.json'],
      ['claude', '--remote-control|WS · t1|--settings|S.json'],
      ['claude update', 'update'],
      ['claude -p hi', '-p|hi'],
      ['claude --settings X.json --remote-control N', '--settings|X.json|--remote-control|N'],
    ];
    const r = await new Promise((resolve) => {
      let buf = '';
      const termId = 'smokewrap';
      const done = (ok, detail) => { clearTimeout(timer); ptyhost.onData(() => {}); ptyhost.kill(termId); resolve({ ok, detail }); };
      const timer = setTimeout(() => done(false, 'timeout: ' + buf.slice(-300)), 20000);
      ptyhost.onData((id, chunk) => {
        if (id !== termId) return;
        buf += chunk;
        const flat = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '');
        // outputs only: the echoed command lines never contain "VSCLAUDE["
        const got = [...flat.matchAll(/VSCLAUDE\[([^\]]*)\]/g)].map(m => m[1]);
        if (got.length < cases.length) return;
        const bad = cases.filter((c, i) => got[i] !== c[1]).map(c => c[0]);
        done(bad.length === 0, bad.length ? 'wrong: ' + bad.join('; ') + ' got=' + JSON.stringify(got) : got.length + ' cases');
      });
      try { ptyhost.create(termId, U.BIN_ROOT, 200, 30, null, { settingsPath: 'S.json', rcLabel: 'WS · t1' }); } catch (err) { done(false, 'spawn: ' + err.message); return; }
      setTimeout(() => ptyhost.write(termId, '$env:VIBESPACE_CLAUDE_DRYRUN=1; ' + cases.map(c => c[0]).join('; ') + '\r'), 900);
    });
    check('pty `claude` wrapper adds tracking flags (hand-typed claude)', r.ok, r.detail);
  }

  // 25. accounts (main/accounts.cjs): reset parsing, usage-limit classification,
  //     store order/exhaustion/pick, DPAPI token blob, wrapper account dry-run,
  //     transcript fallback, claude-exit wait. Fake tokens only; never printed.
  {
    const acc = require('./accounts.cjs');
    const L = (y, mo, d, h, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();
    const now = L(2026, 9, 1, 12); // Oct 1 2026, 12:00 local
    const pr = {
      dateComma: acc.parseReset('You\'ve hit your weekly limit · resets Oct 5, 3pm (Europe/Berlin)', now) === L(2026, 9, 5, 15),
      dateAt: acc.parseReset('resets Oct 5 at 3:30pm', now) === L(2026, 9, 5, 15, 30),
      timeTz: acc.parseReset('hit your session limit · resets 3pm (Europe/Berlin)', now) === L(2026, 9, 1, 15),
      time24: acc.parseReset('resets 15:00', now) === L(2026, 9, 1, 15),
      tomorrow: acc.parseReset('resets 9am', now) === L(2026, 9, 2, 9),
      nextYear: acc.parseReset('resets Jan 3, 3pm', now) === L(2027, 0, 3, 15),
      recentPast: acc.parseReset('resets Sep 30, 3pm', now) === L(2026, 8, 30, 15),
      none: acc.parseReset('resets soon', now) === null && acc.parseReset('', now) === null,
    };
    check('accounts.parseReset (4 forms + day/year rollover)', Object.values(pr).every(Boolean), JSON.stringify(pr));

    const weekly = acc.classifyFailure({ type: 'rate_limit', message: 'You\'ve hit your weekly limit · resets Oct 5, 3pm (Europe/Berlin)' }, null, null, now);
    const viaTranscript = acc.classifyFailure({ type: 'rate_limit', message: null }, null, 'You\'ve hit your 5-hour limit · resets 3:30pm', now);
    const credits = acc.classifyFailure({ type: 'rate_limit', message: 'You\'re out of usage credits · usage limit for this model' }, null, null, now);
    const overloaded = acc.classifyFailure({ type: 'server_error', message: '529 Overloaded' }, null, null, now);
    const plainRate = acc.classifyFailure({ type: 'rate_limit', message: 'Too many requests' }, null, null, now);
    const in3h = Math.floor(now / 1000) + 3 * 3600;
    const full = acc.classifyFailure({ type: 'unknown', message: '' }, { five_hour: { used_percentage: 100, resets_at: in3h }, seven_day: { used_percentage: 40, resets_at: 1 } }, null, now);
    // a 100 % window whose reset already passed is stale: not a limit (529 must not switch)
    const stale = acc.classifyFailure({ type: 'server_error', message: '529 Overloaded' }, { five_hour: { used_percentage: 100, resets_at: Math.floor(now / 1000) - 60 } }, null, now);
    const shortRate = acc.classifyFailure({ type: 'rate_limit', message: 'Rate limit reached for requests' }, null, null, now);
    const fullReduced = acc.classifyFailure({ type: null, message: '' }, { fiveHour: { pct: 30, resetsAt: 1 }, sevenDay: { pct: 100, resetsAt: 1791205200 } }, null, now);
    const quota = acc.classifyFailure({ type: 'rate_limit', message: null }, null, 'You\'ve hit your weekly limit · resets Oct 5, 3pm (Europe/Berlin)', now, { status: 'rejected', resetsAt: 1791205260, type: 'seven_day' });
    const quotaCredits = acc.classifyFailure({ type: 'rate_limit', message: 'You\'re out of usage credits' }, null, null, now, { status: 'rejected', resetsAt: 1791205260 });
    const cf = {
      quota: quota.usageLimit && quota.until === 1791205260 * 1000,
      quotaCredits: quotaCredits.usageLimit === false,
      weekly: weekly.usageLimit && weekly.until === L(2026, 9, 5, 15) && weekly.reason === 'weekly limit',
      viaTranscript: viaTranscript.usageLimit && viaTranscript.until === L(2026, 9, 1, 15, 30) && viaTranscript.reason === '5-hour limit',
      credits: credits.usageLimit === false,
      overloaded: overloaded.usageLimit === false,
      plainRate: plainRate.usageLimit === false,
      full: full.usageLimit && full.until === in3h * 1000,
      stale: stale.usageLimit === false,
      shortRate: shortRate.usageLimit === false,
      fullReduced: fullReduced.usageLimit && fullReduced.until === 1791205200 * 1000,
    };
    check('accounts.classifyFailure (weekly limit, credits, 529, rate_limits 100 %)', Object.values(cf).every(Boolean), JSON.stringify(cf));

    // store + DPAPI: add → blob → PowerShell decrypt gives the same token back
    const fakeToken = 'sk-ant-oat01-' + 'SmokeFakeToken_' + U.randId(24) + '-x';
    const s0 = acc.state();
    const bad = await acc.add('Nope', 'not-a-token');
    const added = await acc.add('Second Max', '  ' + fakeToken + '\n');
    const id2 = added.ok ? added.state.accounts[1].id : null;
    const blob = id2 ? acc.blobPath(id2) : null;
    const blobText = blob && fs.existsSync(blob) ? fs.readFileSync(blob, 'utf8') : '';
    const decrypted = await new Promise((resolve) => {
      if (!blob) { resolve(''); return; }
      // the exact snippet the pty wrapper runs
      const ps = `$blob = $env:VS_SMOKE_BLOB; ${acc.DECRYPT_PS}; [Console]::Out.Write($tok)`;
      require('node:child_process').execFile(acc._psExe(), ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 20000, env: acc._psEnv({ VS_SMOKE_BLOB: blob }) }, (err, out) => resolve(String(out || '').trim()));
    });
    const dp = {
      loginFirst: s0.accounts.length === 1 && s0.accounts[0].id === 'login' && s0.accounts[0].kind === 'login' && s0.pick === 'login',
      badRejected: bad.ok === false && typeof bad.error === 'string',
      added: Boolean(added.ok && id2 && id2 !== 'login' && added.state.accounts[1].kind === 'token' && added.state.accounts[1].label === 'Second Max'),
      blobOpaque: blobText.length > 100 && !blobText.includes(fakeToken) && !JSON.stringify(acc.state()).includes(fakeToken),
      roundtrip: decrypted === fakeToken,
    };
    check('accounts DPAPI token blob (add → blob → decrypt round-trip, never in state)', Object.values(dp).every(Boolean),
      JSON.stringify({ ...dp, roundtrip: dp.roundtrip ? 'ok' : 'MISMATCH' }));

    if (id2) {
      const t0 = Date.now();
      const st = {};
      st.pickLogin = acc.pick() === 'login' && acc.pick('login') === id2;
      acc.markExhausted('login', t0 + 3600e3, 'weekly limit');
      const sx = acc.state();
      st.exhausted = sx.pick === id2 && sx.accounts[0].exhaustedUntil === t0 + 3600e3 && sx.accounts[0].reason === 'weekly limit';
      st.onlyExtends = acc.markExhausted('login', t0 + 60e3, 'shorter') === false && acc.state().accounts[0].exhaustedUntil === t0 + 3600e3;
      st.expiry = acc.pick(null, t0 + 2 * 3600e3) === 'login' && acc.state(t0 + 2 * 3600e3).accounts[0].exhaustedUntil === null;
      acc.markExhausted(id2, t0 + 7200e3, 'session limit');
      st.allOut = acc.pick() === null && acc.state().pick === null;
      acc.clear(id2);
      st.cleared = acc.pick() === id2;
      acc.clear('login');
      // early recovery (claude.ai "reset limits"): only a turn that STARTED after
      // the limit evidence clears the mark
      acc.markExhausted('login', t0 + 3600e3, 'weekly limit');
      const eAt = acc.exhaustedAt('login');
      st.proofOld = eAt >= t0 && acc.clearIfProven('login', eAt - 1) === false && acc.pick() === id2;
      st.proofNew = acc.clearIfProven('login', eAt + 1) === true && acc.pick() === 'login' && acc.exhaustedAt('login') === null;
      // a tab repeating its old 100 % reading must not re-mark the account
      const bf = require('./claudefeed.cjs')._becameFull;
      const w100 = { five_hour: { used_percentage: 40, resets_at: 1 }, seven_day: { used_percentage: 100, resets_at: 1791417600 } };
      st.tickFresh = bf(null, w100).length === 1 && bf({ seven_day: { used_percentage: 97 } }, w100)[0].resets_at === 1791417600;
      st.tickStale = bf(w100, w100).length === 0 && bf(w100, { seven_day: { used_percentage: 4 } }).length === 0;
      acc.move(id2, -1);
      st.moved = acc.state().accounts.map(a => a.id).join(',') === `${id2},login` && acc.pick() === id2;
      acc.move(id2, -1); // already first: no-op
      acc.move('login', -1);
      st.movedBack = acc.state().accounts.map(a => a.id).join(',') === `login,${id2}`;
      // "move all agents here": first in the order + a standing request; refused
      // for an account that is out
      const sw = acc.switchAll(id2);
      st.switchAll = sw.accounts[0].id === id2 && sw.switchAll && sw.switchAll.to === id2 && sw.switchAll.at >= t0 && sw.pick === id2;
      acc.markExhausted('login', Date.now() + 3600e3, 'weekly limit');
      let refused = false;
      try { acc.switchAll('login'); } catch { refused = true; }
      st.switchAllRefused = refused && acc.state().switchAll.to === id2;
      acc.clear('login');
      // retired when its account runs out, and by a manual reorder
      acc.markExhausted(id2, Date.now() + 3600e3, 'weekly limit');
      st.switchAllRetired = acc.state().switchAll === null;
      acc.clear(id2);
      acc.switchAll(id2);
      acc.move('login', -1);
      st.switchAllReorder = acc.state().switchAll === null && acc.state().accounts[0].id === 'login';
      st.switchAllTtl = (acc.switchAll(id2), acc.state(Date.now() + 13 * 3600e3).switchAll === null);
      acc.move('login', -1);
      acc.rename(id2, 'Work Max');
      acc.remove('login'); // cannot be removed
      st.renamed = acc.labelOf(id2) === 'Work Max' && acc.has('login');
      acc.setLimits(id2, { five_hour: { used_percentage: 42, resets_at: 1790693400 } });
      st.limits = acc.state().accounts[1].limits && acc.state().accounts[1].limits.five_hour.used_percentage === 42;
      check('accounts store (pick, exhaustion only extends, expiry, order/move, rename, limits)', Object.values(st).every(Boolean), JSON.stringify(st));

      // wrapper dry-run with an account file: login keeps --remote-control, a token
      // account gets none, a missing blob says so. The pty start clears a stale file.
      const r = await new Promise((resolve) => {
        let buf = '';
        const termId = 'smokeacct';
        const stale = ptyhost.accountFileFor('smoke-acct', termId);
        fs.mkdirSync(path.dirname(stale), { recursive: true });
        fs.writeFileSync(stale, id2);
        const done = (ok, detail) => { clearTimeout(timer); ptyhost.onData(() => {}); ptyhost.kill(termId); resolve({ ok, detail }); };
        const timer = setTimeout(() => done(false, 'timeout: ' + buf.slice(-300)), 20000);
        const want = [`VSACCT[login]`, 'VSCLAUDE[--remote-control|WS · t1|--settings|S.json]',
          `VSACCT[${id2}|token]`, 'VSCLAUDE[--resume|abc|--settings|S.json]',
          'VSACCT[ghost-zz99|missing]', 'VSCLAUDE[--settings|S.json]'];
        ptyhost.onData((id, chunk) => {
          if (id !== termId) return;
          buf += chunk;
          const flat = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '');
          const got = [...flat.matchAll(/VS(?:ACCT|CLAUDE)\[[^\]]*\]/g)].map(m => m[0]);
          if (got.length < want.length) return;
          const ok = want.every((w, i) => got[i] === w);
          done(ok, ok ? `${got.length} lines` : 'got=' + JSON.stringify(got));
        });
        try { ptyhost.create(termId, U.BIN_ROOT, 220, 30, 'smoke-acct', { settingsPath: 'S.json', rcLabel: 'WS · t1' }); } catch (err) { done(false, 'spawn: ' + err.message); return; }
        const clearedOnCreate = !fs.existsSync(stale);
        if (!clearedOnCreate) { done(false, 'stale account file survived pty create'); return; }
        const setFile = ptyhost.setAccount(termId, 'login');
        const setOk = fs.readFileSync(setFile, 'utf8') === 'login' && setFile === stale;
        if (!setOk) { done(false, 'setAccount wrote ' + setFile); return; }
        const setTo = (v) => `Set-Content -NoNewline -LiteralPath $env:VIBESPACE_ACCOUNT_FILE -Value '${v}'`;
        setTimeout(() => ptyhost.write(termId, `$env:VIBESPACE_CLAUDE_DRYRUN=1; claude; ${setTo(id2)}; claude --resume abc; ${setTo('ghost-zz99')}; claude\r`), 900);
      });
      check('pty `claude` wrapper per-account dry-run (login → RC, token → no RC, missing blob)', r.ok, r.detail);

      acc.remove(id2);
      check('accounts remove deletes the token blob', !acc.has(id2) && !fs.existsSync(blob));
    }

    // 25b. API endpoint accounts (z.ai GLM, …): lenient env parser, the whole env
    //      as one DPAPI blob, provider families + family-bound pick, no secret in
    //      state/log, login unusable without credentials, and the wrapper setting
    //      the vars for ONE call (a fake claude.cmd reports what it saw). Fake key.
    {
      const fakeKey = 'fake-' + 'SmokeEndpointKey_' + U.randId(16);
      const block = '{\n'
        + `  "ANTHROPIC_AUTH_TOKEN": "${fakeKey}",\r\n`
        + '  "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",\n'
        + '  "ANCHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash[1m]",\n'
        + '  "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3-flash[1m]",\n'
        + '  "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3[1m]",\n'
        + '  "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "900000", // compact late\n'
        + '  "API_TIMEOUT_MS": 3000000,\n'
        + '  "CLAUDE_CODE_EFFORT_LEVEL": "max",\n'
        + '}';
      const p = acc._parseEndpointEnv(block);
      const kv = acc._parseEndpointEnv(`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic\r\nANTHROPIC_API_KEY=${fakeKey}=x\n# comment\nAPI_TIMEOUT_MS="5"`);
      const noBase = acc._parseEndpointEnv(`{ "ANTHROPIC_AUTH_TOKEN": "${fakeKey}" }`);
      const pathKey = acc._parseEndpointEnv('ANTHROPIC_BASE_URL=https://x.io\nANTHROPIC_AUTH_TOKEN=k\nPATH=C:\\evil');
      const oauth = acc._parseEndpointEnv('"ANTHROPIC_BASE_URL": "https://x.io", "ANTHROPIC_AUTH_TOKEN": "k", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-x"');
      const pe = {
        block: Boolean(p.ok && Object.keys(p.env).length === 8 && p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'glm-5.3-flash[1m]'
          && !('ANCHROPIC_DEFAULT_HAIKU_MODEL' in p.env) && p.env.API_TIMEOUT_MS === '3000000' && p.env.ANTHROPIC_AUTH_TOKEN === fakeKey),
        typoNote: Boolean(p.ok && p.notes.length === 1 && p.notes[0] === 'ANCHROPIC_DEFAULT_HAIKU_MODEL → ANTHROPIC_DEFAULT_HAIKU_MODEL'),
        keyValue: Boolean(kv.ok && kv.env.ANTHROPIC_API_KEY === fakeKey + '=x' && kv.env.API_TIMEOUT_MS === '5' && Object.keys(kv.env).length === 3),
        noBase: !noBase.ok && /ANTHROPIC_BASE_URL is missing/.test(noBase.error) && !noBase.error.includes(fakeKey),
        pathRejected: !pathKey.ok && /^PATH is not allowed/.test(pathKey.error),
        oauthRejected: !oauth.ok && /^CLAUDE_CODE_OAUTH_TOKEN is not allowed/.test(oauth.error),
      };
      check('accounts endpoint env parser (settings block + typo + trailing comma, KEY=VALUE, errors)', Object.values(pe).every(Boolean), JSON.stringify(pe));

      const decrypt = (blobFile) => new Promise((resolve) => {
        const ps = `$blob = $env:VS_SMOKE_BLOB; ${acc.DECRYPT_PS}; [Console]::Out.Write($tok)`;
        require('node:child_process').execFile(acc._psExe(), ['-NoProfile', '-NonInteractive', '-Command', ps],
          { windowsHide: true, timeout: 20000, env: acc._psEnv({ VS_SMOKE_BLOB: blobFile }) }, (err, out) => resolve(String(out || '')));
      });
      const tokAdd = await acc.add('Smoke Max', 'sk-ant-oat01-' + 'SmokeFakeToken_' + U.randId(24) + '-y');
      const epAdd = await acc.addEndpoint('Smoke GLM', block);
      const tokId = tokAdd.ok ? (tokAdd.state.accounts.find(a => a.label === 'Smoke Max') || {}).id : null;
      const epId = epAdd.ok ? (epAdd.state.accounts.find(a => a.kind === 'endpoint') || {}).id : null;
      const epBlob = epId ? acc.blobPath(epId) : null;
      const epText = epBlob && fs.existsSync(epBlob) ? fs.readFileSync(epBlob, 'utf8') : '';
      const dec = epBlob ? await decrypt(epBlob) : '';
      const logger = require('./logger.cjs');
      const logText = (() => {
        try { return fs.readdirSync(logger.logsDir()).map(f => fs.readFileSync(path.join(logger.logsDir(), f), 'utf8')).join('\n'); } catch { return ''; }
      })();
      const row = (acc.state().accounts.find(a => a.id === epId)) || {};
      const nz = acc._normalize({ accounts: { e1: { label: 'E', kind: 'endpoint', baseUrl: 'https://api.z.ai/api/anthropic', models: { opus: 'glm-5.3' } }, t1: { label: 'T', kind: 'odd' } } });
      const ep = {
        added: Boolean(tokId && epId && epAdd.notes && epAdd.notes.length === 1),
        roundtrip: dec === acc._envText(p.env) && dec.includes('ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic\n'),
        blobOpaque: epText.length > 100 && !epText.includes(fakeKey),
        noSecret: !JSON.stringify(acc.state()).includes(fakeKey) && !JSON.stringify(epAdd).includes(fakeKey)
          && !fs.readFileSync(path.join(U.dataRoot(), 'accounts.json'), 'utf8').includes(fakeKey) && !logText.includes(fakeKey),
        row: row.kind === 'endpoint' && row.family === 'endpoint:api.z.ai' && row.host === 'api.z.ai'
          && Boolean(row.models && row.models.opus === 'glm-5.3[1m]' && row.models.haiku === 'glm-5.3-flash[1m]') && row.available === true,
        families: acc.familyOf('login') === 'anthropic' && acc.familyOf(tokId) === 'anthropic' && acc.familyOf('ghost-zz99') === 'anthropic'
          && acc.familyOf(epId) === 'endpoint:api.z.ai',
        normalize: nz.accounts.e1.kind === 'endpoint' && nz.accounts.e1.baseUrl === 'https://api.z.ai/api/anthropic'
          && nz.accounts.e1.models.opus === 'glm-5.3' && nz.accounts.t1.kind === 'token',
      };
      check('accounts endpoint add (DPAPI env blob round-trip, family, models, never the key in state/json/log)', Object.values(ep).every(Boolean),
        JSON.stringify({ ...ep, roundtrip: ep.roundtrip ? 'ok' : 'MISMATCH' }));

      // provider presets: pick z.ai, paste only the key. Same store path as a
      // pasted block; label de-duplicated; model overrides applied. Fake keys.
      {
        const list = acc.presets();
        const z = list.find(x => x.id === 'zai') || {};
        const pr = {
          zai: z.name === 'z.ai (GLM)' && z.label === 'z.ai GLM' && typeof z.keyHint === 'string'
            && Boolean(z.models && z.models.opus === 'glm-5.3[1m]' && z.models.sonnet === 'glm-5.3-flash[1m]' && z.models.haiku === 'glm-5.3-flash[1m]'),
          noSecrets: !/AUTH_TOKEN|API_KEY|"env"|api\.z\.ai/.test(JSON.stringify(list)),
        };
        check('accounts presets() lists z.ai without env or secrets', Object.values(pr).every(Boolean), JSON.stringify(pr));

        const zKey = 'fake-' + 'SmokePresetKey_' + U.randId(20);
        const errOf = async (...args) => { const r = await acc.addPreset(...args); return r.ok ? null : r.error; };
        const pa = {};
        const sk = await errOf('zai', '', 'sk-ant-oat01-' + U.randId(30));
        pa.claudeTokenRejected = sk === "That's a Claude token: add it under Claude subscription";
        pa.emptyRejected = Boolean(await errOf('zai', '', '   '));
        pa.shortRejected = Boolean(await errOf('zai', '', 'abc123'));
        pa.spaceRejected = Boolean(await errOf('zai', '', zKey + ' x'));
        pa.badModelRejected = Boolean(await errOf('zai', '', zKey, { models: { opus: 'glm 5' } }));
        pa.unknownPreset = Boolean(await errOf('nope', '', zKey));
        const a1 = await acc.addPreset('zai', '', '  ' + zKey + '\n');
        const a2 = await acc.addPreset('zai', '  ', zKey, { models: { sonnet: 'glm-smoke-x', haiku: '' } });
        const r1 = a1.ok ? (acc.state().accounts.find(x => x.id === a1.id) || {}) : {};
        const r2 = a2.ok ? (acc.state().accounts.find(x => x.id === a2.id) || {}) : {};
        pa.added = Boolean(a1.ok && a2.ok);
        pa.labels = r1.label === 'z.ai GLM' && r2.label === 'z.ai GLM 2' && a2.label === 'z.ai GLM 2';
        pa.row = r1.kind === 'endpoint' && r1.family === 'endpoint:api.z.ai' && r1.baseUrl === 'https://api.z.ai/api/anthropic' && r1.preset === 'zai'
          && Boolean(r1.models && r1.models.opus === 'glm-5.3[1m]' && r1.models.sonnet === 'glm-5.3-flash[1m]' && r1.models.haiku === 'glm-5.3-flash[1m]');
        pa.override = Boolean(r2.models && r2.models.sonnet === 'glm-smoke-x' && r2.models.opus === 'glm-5.3[1m]' && r2.models.haiku === 'glm-5.3-flash[1m]');
        pa.pastedZaiIsPreset = (acc.state().accounts.find(x => x.id === epId) || {}).preset === 'zai'; // a pasted z.ai block is z.ai too
        const b2 = a2.ok ? acc.blobPath(a2.id) : null;
        const dec2 = b2 ? await decrypt(b2) : '';
        pa.blob = dec2.includes(`ANTHROPIC_AUTH_TOKEN=${zKey}`) && dec2.includes('ANTHROPIC_DEFAULT_SONNET_MODEL=glm-smoke-x')
          && dec2.includes('ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic') && dec2.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000')
          && dec2.includes('API_TIMEOUT_MS=3000000') && !fs.readFileSync(b2, 'utf8').includes(zKey);
        const files = acc._files();
        const logNow = (() => {
          try { return fs.readdirSync(logger.logsDir()).map(f => fs.readFileSync(path.join(logger.logsDir(), f), 'utf8')).join('\n'); } catch { return ''; }
        })();
        pa.noKey = !JSON.stringify(acc.state()).includes(zKey) && !JSON.stringify([a1, a2]).includes(zKey)
          && !fs.readFileSync(files.accounts, 'utf8').includes(zKey) && !fs.readFileSync(files.endpoints, 'utf8').includes(zKey) && !logNow.includes(zKey);
        if (a1.ok) acc.remove(a1.id);
        if (a2.ok) acc.remove(a2.id);
        pa.removed = !(a1.ok && acc.has(a1.id)) && !(a2.ok && acc.has(a2.id));
        check('accounts addPreset z.ai (key only, preset models + override, " 2" label, Claude/empty key rejected, key never stored in clear)',
          Object.values(pa).every(Boolean), JSON.stringify(pa));
      }

      if (tokId && epId) {
        const now = Date.now();
        const zai = 'endpoint:api.z.ai';
        const fp = {};
        fp.order = acc.state().accounts.map(a => a.id).join(',') === `login,${tokId},${epId}`;
        fp.anyFamily = acc.pick() === 'login' && acc.pick('login') === tokId;
        fp.endpointOnly = acc.pick(null, now, { family: zai }) === epId && acc.pick(epId, now, { family: zai }) === null;
        acc.markExhausted(tokId, now + 3600e3, 'weekly limit');
        // a Claude conversation never lands on the endpoint, even with every Claude account out
        fp.claudeOnly = acc.pick('login', Date.now(), { family: 'anthropic' }) === null && acc.pick('login') === epId;
        acc.clear(tokId);
        // only an endpoint, no Claude login on this PC: new agents start on the endpoint
        acc._setCredentialsPath(path.join(U.dataRoot(), 'no-such-home', '.credentials.json'));
        const sNo = acc.state();
        const loginRow = sNo.accounts.find(a => a.id === 'login');
        fp.notLoggedIn = loginRow.available === false && loginRow.note === 'not logged in' && acc.pick() === tokId;
        acc.markExhausted(tokId, Date.now() + 3600e3, 'weekly limit');
        fp.friendCase = acc.pick() === epId && acc.state().pick === epId;
        let refused = false;
        try { acc.switchAll('login'); } catch { refused = true; }
        fp.switchAllRefused = refused;
        acc.clear(tokId);
        acc._setCredentialsPath(null);
        fp.loggedInAgain = acc.pick() === 'login' && acc.state().accounts.find(a => a.id === 'login').available === true;
        check('accounts provider families (family-bound pick, no /login without credentials)', Object.values(fp).every(Boolean), JSON.stringify(fp));
        // a conversation's provider comes from its transcript's model when it has
        // replies: an old Claude conversation picked in an endpoint tab stays Claude's
        const tdir2 = path.join(U.dataRoot(), 'fam-tx');
        fs.mkdirSync(tdir2, { recursive: true });
        const txC = path.join(tdir2, 'c.jsonl');
        const txG = path.join(tdir2, 'g.jsonl');
        const txN = path.join(tdir2, 'n.jsonl');
        fs.writeFileSync(txC, ['{"type":"user","message":{}}', '{"type":"assistant","message":{"model":"<synthetic>"}}', '{"type":"assistant","message":{"model":"claude-opus-5-5"}}'].join('\n'));
        fs.writeFileSync(txG, ['{"type":"user"}', '{"type":"assistant","message":{"model":"glm-5.3"}}'].join('\n'));
        fs.writeFileSync(txN, '{"type":"user"}\n');
        const zf = 'endpoint:api.z.ai';
        const tf = {
          claudeInEndpointTab: acc.familyForNewSession(txC, zf) === 'anthropic',
          glmInClaudeTab: ['endpoint:unknown', zf].includes(acc.familyForNewSession(txG, 'anthropic')), // zf when a z.ai account with that model exists
          glmInEndpointTab: acc.familyForNewSession(txG, zf) === zf,
          freshTakesTab: acc.familyForNewSession(txN, zf) === zf && acc.familyForNewSession(null, 'anthropic') === 'anthropic',
        };
        // the registry survives a damaged file (.bak)
        acc.noteSessionFamily('famsmoke-1', zf);
        acc.noteSessionFamily('famsmoke-2', 'anthropic');
        fs.writeFileSync(acc._files().families, '\0\0\0');
        tf.registryBak = acc.sessionFamily('famsmoke-1') === zf || acc.sessionFamily('famsmoke-2') === 'anthropic';
        check('conversation provider from the transcript model; registry restored from .bak', Object.values(tf).every(Boolean), JSON.stringify(tf));
        try { fs.rmSync(tdir2, { recursive: true, force: true }); } catch {}

        // endpoint accounts live in their own file + blob name: a window on OLDER
        // main code (every non-login account → kind 'token', blob <id>.dpapi
        // read as an OAuth token) never sees one. An entry left in accounts.json
        // by the first 0.6.49 build is moved on read.
        {
          const files = acc._files();
          const oldNormalize = (raw) => { // the pre-0.6.49 rule, copied
            const out = {};
            for (const [id, a] of Object.entries((raw && raw.accounts) || {})) {
              if (!a || typeof a !== 'object' || id === 'login') continue;
              out[id] = { label: String(a.label || id), kind: 'token' };
            }
            return out;
          };
          const rawAcc = JSON.parse(fs.readFileSync(files.accounts, 'utf8'));
          const rawEps = JSON.parse(fs.readFileSync(files.endpoints, 'utf8'));
          const old = oldNormalize(rawAcc);
          const own = {
            notInAccountsJson: !(epId in rawAcc.accounts) && rawAcc.order.includes(epId),
            oldCodeBlind: !(epId in old) && (tokId in old),
            ownFile: Boolean(rawEps[epId] && rawEps[epId].baseUrl === 'https://api.z.ai/api/anthropic' && rawEps[epId].models.opus === 'glm-5.3[1m]')
              && !JSON.stringify(rawEps).includes(fakeKey) && !(tokId in rawEps),
            blobName: epBlob === files.endpointBlob(epId) && fs.existsSync(epBlob) && !fs.existsSync(files.tokenBlob(epId)),
          };
          const legacy = JSON.parse(fs.readFileSync(files.accounts, 'utf8'));
          legacy.accounts.mig1 = { label: 'Mig', kind: 'endpoint', baseUrl: 'https://mig.example/api', models: { opus: 'm1' } };
          legacy.order.push('mig1');
          fs.writeFileSync(files.accounts, JSON.stringify(legacy, null, 2) + '\n');
          fs.writeFileSync(files.tokenBlob('mig1'), 'ab'.repeat(60));
          const migRow = acc.state().accounts.find(a => a.id === 'mig1') || {};
          const afterAcc = JSON.parse(fs.readFileSync(files.accounts, 'utf8'));
          const afterEps = JSON.parse(fs.readFileSync(files.endpoints, 'utf8'));
          own.migrated = migRow.kind === 'endpoint' && migRow.family === 'endpoint:mig.example' && migRow.available === true
            && !('mig1' in afterAcc.accounts) && afterAcc.order.includes('mig1') && Boolean(afterEps.mig1) && Boolean(afterEps[epId])
            && fs.existsSync(files.endpointBlob('mig1')) && !fs.existsSync(files.tokenBlob('mig1'));
          acc.remove('mig1');
          own.migRemoved = !acc.has('mig1') && !fs.existsSync(files.endpointBlob('mig1')) && !('mig1' in JSON.parse(fs.readFileSync(files.endpoints, 'utf8')));
          check('endpoint accounts in their own file + blob name, invisible to older main code (+ migration)', Object.values(own).every(Boolean), JSON.stringify(own));
        }

        // the endpoint path: MAIN decrypts the env (endpointEnv) and writes the
        // tab's own claude settings (hooks + env); the wrapper only swaps its
        // --settings for that file and adds no --remote-control. It never
        // decrypts endpoint settings itself (Defender flagged that, 2026-10-07).
        const env2 = await acc.endpointEnv(epId).catch(() => null);
        const baseS = path.join(U.dataRoot(), 'smoke-hooks.json');
        fs.writeFileSync(baseS, JSON.stringify({ hooks: { Stop: [] }, statusLine: { type: 'command', command: 'x' } }));
        const epsFile = ptyhost.endpointSettingsFor('smoke-acct', 'smokeendpoint');
        let keptAtKill = null; // was the tab's settings file there just before kill()?
        const refuse = 'start claude without --settings';
        const r = await new Promise((resolve) => {
          let buf = '';
          const termId = 'smokeendpoint';
          const done = (ok, detail) => { clearTimeout(timer); ptyhost.onData(() => {}); keptAtKill = fs.existsSync(epsFile); ptyhost.kill(termId); resolve({ ok, detail }); };
          const timer = setTimeout(() => done(false, 'timeout: ' + buf.slice(-300).split(fakeKey).join('<key>')), 25000);
          if (!env2 || env2.ANTHROPIC_AUTH_TOKEN !== fakeKey) { done(false, 'endpointEnv did not decrypt'); return; }
          try { ptyhost.create(termId, U.BIN_ROOT, 400, 30, 'smoke-acct', { settingsPath: baseS, rcLabel: 'WS · t1' }); } catch (err) { done(false, 'spawn: ' + err.message); return; }
          ptyhost.setAccount(termId, epId);
          const eps = ptyhost.writeEndpointSettings(termId, 'smoke-acct', baseS, env2);
          let written = null;
          try { written = JSON.parse(fs.readFileSync(eps, 'utf8')); } catch {}
          const fileOk = Boolean(written && written.env && written.env.ANTHROPIC_BASE_URL === 'https://api.z.ai/api/anthropic'
            && written.env.ANTHROPIC_AUTH_TOKEN === fakeKey && written.hooks && written.statusLine);
          const want = [`VSACCT[${epId}|endpoint]`, `VSCLAUDE[--settings|${eps}]`, `VSACCT[${epId}|endpoint]`, `VSCLAUDE[--resume|abc|--settings|${eps}]`];
          ptyhost.onData((id, chunk) => {
            if (id !== termId) return;
            buf += chunk;
            const flat = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '');
            const got = [...flat.matchAll(/VS(?:ACCT|CLAUDE)\[[^\]]*\]/g)].map(m => m[0]);
            if (got.length < want.length || !flat.includes(refuse)) return;
            // the third claude brought its own --settings: refused, nothing run
            const refused = flat.includes(`endpoint account '${epId}': ${refuse}`) && got.length === want.length;
            const ok = fileOk && refused && want.every((w, i) => got[i] === w) && !flat.includes(fakeKey);
            done(ok, ok ? `${got.length} lines + refusal` : 'fileOk=' + fileOk + ' refused=' + refused + ' got=' + JSON.stringify(got).split(fakeKey).join('<key>'));
          });
          // plain `claude`, the way claudeCommand types it (explicit hook
          // --settings), then one with someone else's --settings
          setTimeout(() => ptyhost.write(termId, `$env:VIBESPACE_CLAUDE_DRYRUN=1; claude; claude --resume abc --settings '${baseS}'; claude --settings 'C:\\other.json'\r`), 900);
        });
        check('endpoint account: main writes the tab settings, wrapper swaps --settings, refuses a foreign --settings, no RC, no key in output', r.ok, r.detail);
        // kill() itself deletes the tab's settings file (it holds the key); its
        // onExit no longer knows the workspace. Main start clears an instance's
        // leftovers (no pty survives a restart), account files stay.
        const cdir = path.join(U.dataRoot(), 'instances', 'smoke-clean', 'accounts');
        fs.mkdirSync(cdir, { recursive: true });
        for (const f of ['t1.settings.json', 't2.settings.json.123.tmp', 't1.account']) fs.writeFileSync(path.join(cdir, f), 'x');
        const cleared = ptyhost.clearInstanceEndpointSettings('smoke-clean');
        const left = fs.readdirSync(cdir).join(',');
        check('pty kill removes the endpoint settings file; main start clears stale ones',
          keptAtKill === true && !fs.existsSync(epsFile) && cleared === 2 && left === 't1.account', JSON.stringify({ keptAtKill, gone: !fs.existsSync(epsFile), cleared, left }));
        // leaving the account deletes the file (it holds the key)
        const epsPath = ptyhost.endpointSettingsFor('smoke-acct', 'smokeendpoint');
        ptyhost.writeEndpointSettings('smokeendpoint', 'smoke-acct', null, { ANTHROPIC_BASE_URL: 'x' });
        ptyhost.clearEndpointSettings('smokeendpoint', 'smoke-acct');
        check('endpoint settings file removed when the tab leaves the account', !fs.existsSync(epsPath));
        try { fs.rmSync(baseS, { force: true }); } catch {}

        // accounts:setTerm's helper: never a silent /login fallback. Unknown ids
        // and endpoints whose settings can't be decrypted THROW; concurrent
        // callers share one decrypt.
        {
          const ft = {};
          const lg = await acc.forTerm('login');
          ft.login = lg.id === 'login' && lg.env === null && (await acc.forTerm(null)).id === 'login';
          ft.token = (await acc.forTerm(tokId)).env === null;
          let unk = null;
          try { await acc.forTerm('ghost-zz99'); } catch (e) { unk = e.message; }
          ft.unknownThrows = unk === 'that account no longer exists';
          acc._forgetEnv(epId);
          const sp0 = acc._decryptSpawns();
          const all = await Promise.all([acc.forTerm(epId), acc.forTerm(epId), acc.endpointEnv(epId)]).catch(() => null);
          ft.oneDecrypt = Boolean(all) && acc._decryptSpawns() - sp0 === 1 && all[0].env.ANTHROPIC_AUTH_TOKEN === fakeKey
            && all[2].ANTHROPIC_AUTH_TOKEN === fakeKey && all[0].env !== all[1].env;
          const goodBlob = fs.readFileSync(epBlob, 'utf8');
          fs.writeFileSync(epBlob, 'ab'.repeat(64)); // damaged blob
          acc._forgetEnv(epId);
          let bad = null;
          try { await acc.forTerm(epId); } catch (e) { bad = e.message; }
          ft.undecryptableThrows = Boolean(bad && bad.startsWith('Smoke GLM: ') && /could not be decrypted/.test(bad));
          const sp1 = acc._decryptSpawns();
          try { await acc.forTerm(epId); } catch {}
          ft.failureNotCached = acc._decryptSpawns() - sp1 === 1;
          fs.rmSync(epBlob, { force: true });
          let gone = null;
          try { await acc.forTerm(epId); } catch (e) { gone = e.message; }
          ft.missingThrows = Boolean(gone && /missing/.test(gone));
          fs.writeFileSync(epBlob, goodBlob); // the remove check below needs it back
          check('accounts.forTerm (setTerm): unknown or undecryptable endpoint throws, one decrypt per id', Object.values(ft).every(Boolean),
            JSON.stringify(ft).split(fakeKey).join('<key>'));
        }
      }

      // conversation families: the first family a conversation ran on wins;
      // the file keeps the newest N
      {
        const files = acc._files();
        const sidA = 'aaaaaaaa-0000-4000-8000-000000000001';
        const reg = {};
        reg.firstWins = acc.noteSessionFamily(sidA, 'endpoint:api.z.ai') === 'endpoint:api.z.ai'
          && acc.noteSessionFamily(sidA, 'anthropic') === 'endpoint:api.z.ai' && acc.sessionFamily(sidA) === 'endpoint:api.z.ai';
        reg.unknown = acc.sessionFamily('bbbbbbbb-0000') === null && acc.sessionFamily('..\\x') === null
          && acc.sessionFamily('__proto__') === null && acc.noteSessionFamily('', 'anthropic') === null;
        acc._setFamiliesMax(5);
        for (let i = 0; i < 6; i++) acc.noteSessionFamily(`s-${i}`, 'anthropic');
        acc._setFamiliesMax(null);
        let onDisk = {};
        try { onDisk = JSON.parse(fs.readFileSync(files.families, 'utf8')); } catch {}
        reg.pruned = Object.keys(onDisk).join(',') === 's-1,s-2,s-3,s-4,s-5' && acc.sessionFamily(sidA) === null && acc.sessionFamily('s-5') === 'anthropic';
        check('conversation family registry (first family wins, oldest pruned)', Object.values(reg).every(Boolean), JSON.stringify(reg));
      }

      // the expanded wrapper must stay valid Windows PowerShell 5.1
      const wf = path.join(U.dataRoot(), 'wrapper-smoke.ps1');
      fs.writeFileSync(wf, ptyhost._wrapper);
      const parsed = await new Promise((resolve) => {
        const ps = '$t = [IO.File]::ReadAllText($env:VS_SMOKE_PS); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e); '
          + "[Console]::Out.Write([string]$e.Count + '|' + (($e | ForEach-Object { $_.Message }) -join '; '))";
        require('node:child_process').execFile(acc._psExe(), ['-NoProfile', '-NonInteractive', '-Command', ps],
          { windowsHide: true, timeout: 20000, env: acc._psEnv({ VS_SMOKE_PS: wf }) }, (err, out) => resolve(String(out || (err && err.message) || '').trim()));
      });
      check('pty `claude` wrapper parses in Windows PowerShell 5.1', parsed === '0|', parsed);
      try { fs.rmSync(wf, { force: true }); } catch {}

      if (tokId) acc.remove(tokId);
      if (epId) acc.remove(epId);
      check('accounts remove deletes the endpoint blob', !acc.has(epId) && !(epBlob && fs.existsSync(epBlob)));
    }

    // transcript fallback: the LAST api-error line, read from the tail only
    {
      const tdir = path.join(U.dataRoot(), 'tx-smoke');
      fs.mkdirSync(tdir, { recursive: true });
      const line = (o) => JSON.stringify(o) + '\n';
      const apiErr = (text, ts) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] }, error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429 });
      const tf = path.join(tdir, 'a.jsonl');
      fs.writeFileSync(tf, line({ type: 'user', pad: 'x'.repeat(300 * 1024) })
        + apiErr('older error', '2026-10-01T09:00:00.000Z')
        + line({ type: 'user', message: { content: 'hi' } })
        + apiErr('You\'ve hit your weekly limit · resets Oct 5, 3pm (Europe/Berlin)', '2026-10-01T10:00:00.000Z')
        + line({ type: 'system', subtype: 'x' }));
      const nf = path.join(tdir, 'b.jsonl');
      fs.writeFileSync(nf, line({ type: 'user' }));
      const got = acc.lastApiErrorText(tf);
      const ok = got && got.error === 'rate_limit' && got.text.startsWith('You\'ve hit your weekly limit') && got.timestamp === Date.parse('2026-10-01T10:00:00.000Z')
        && acc.lastApiErrorText(nf) === null && acc.lastApiErrorText(path.join(tdir, 'missing.jsonl')) === null;
      check('accounts.lastApiErrorText (last api-error line, tail read)', Boolean(ok), JSON.stringify(got));
      try { fs.rmSync(tdir, { recursive: true, force: true }); } catch {}
    }

    // claude-exit wait: a PowerShell prompt after the call resolves 'prompt'; no
    // output and no claude under the shell resolves 'timeout'
    {
      const termId = 'smokewait';
      let w1 = null;
      let w2 = null;
      try {
        ptyhost.create(termId, U.BIN_ROOT, 120, 30);
        await new Promise(r => setTimeout(r, 1500));
        const p1 = ptyhost.waitClaudeExit(termId, 8000);
        ptyhost.write(termId, 'echo waited\r');
        w1 = await p1;
        // let the prompt finish redrawing: a late chunk would end the next wait as
        // 'prompt' instead of exercising the process scan (seen once under load)
        await new Promise(r => setTimeout(r, 2500));
        w2 = await ptyhost.waitClaudeExit(termId, 600);
      } catch (err) {
        w1 = w1 || { how: 'error: ' + err.message };
      }
      ptyhost.kill(termId);
      check('pty waitClaudeExit (prompt seen → prompt; idle, no claude → gone)', w1 && w1.how === 'prompt' && w2 && w2.how === 'gone',
        JSON.stringify({ w1, w2 }));
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

  // 9b. tab close kills hidden grandchildren (orphaned MCP servers) + id reuse
  const tree = await ptyTreeKillTest();
  check('pty kill takes hidden grandchildren (MCP servers) down, per tab', tree.ok, tree.detail);
  const recreate = await ptyRecreateTest();
  check('pty re-create on a live id survives the old pty exit', recreate.ok, recreate.detail);

  const failed = results.filter(r => !r.ok);
  console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0;
}

module.exports = runSmoke;
