'use strict';
// One-click self-update of the PACKAGED app (macOS + Windows).
//
// Why custom: the Mac build is ad-hoc signed (no Apple Developer ID), so
// Squirrel.Mac / electron-updater can't update it (the designated requirement
// changes with every build). The flow:
//   check    GitHub Releases of enerage/vibespace: the LIST, not /latest (a
//            release can be published with latest=false), drafts and
//            prereleases skipped. Once machine-wide (a lock file): ~30 s after
//            a process starts (if nobody checked in the last 15 min) and every
//            6 h. The compact list lands in <dataRoot>/app-update.json; every
//            process picks its own update from it (its platform, arch and
//            version), so a dev run never sees a packaged run's update.
//   ui       the ↻ Restart button turns into "↻ Update to <v>" (+ one toast
//            per version per window); the launcher has its own button.
//   install  download to <dataRoot>/updates/<v>/ (resumable .part), verify the
//            sha256 against the API's `digest` (size only when absent, logged),
//            macOS: unpack + codesign/Info.plist checks. Then a DETACHED helper
//            (/bin/sh on macOS, PowerShell -File on Windows) waits until every
//            process of THIS install has exited, swaps the bundle / runs the
//            NSIS installer silently into the same folder, and relaunches with
//            --relaunch-after-update.
//   quit     the clicking process writes `install` into app-update.json; every
//            other process of the same executable polls the file (3 s) and
//            quits through the normal path (before-quit saves its state).
//   reopen   the relaunched launcher reads `reopen` (the workspaces that were
//            open), spawns them like the launcher's Open button (their agents
//            resume exactly like after ↻ Restart) and clears the record.
// Testing overrides: VIBESPACE_UPDATE_FEED (a releases-JSON URL; http allowed),
// VIBESPACE_UPDATE_FORCE=1 (unpackaged runs too; install = dry run unless
// VIBESPACE_UPDATE_TARGET names a .app / an install folder to update instead).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const U = require('./util.cjs');

const REPO = 'enerage/vibespace';
const DEFAULT_FEED = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const BUNDLE_ID = 'app.vibespace';
const RELAUNCH_FLAG = '--relaunch-after-update';
const START_DELAY = 30 * 1000;
const START_MIN_GAP = 15 * 60 * 1000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const TICK = 10 * 60 * 1000;
const POLL = 3000;
const CHECK_TIMEOUT = 10 * 1000;
const STALL_TIMEOUT = 30 * 1000; // download: no byte for this long = give up (the .part stays)
const LOCK_STALE = 2 * 60 * 1000;
const INSTALL_LOCK_STALE = 15 * 60 * 1000;
const INSTALL_FRESH = 3 * 60 * 1000; // a request without a result after this = the helper died
const RESULT_SHOW = 10 * 60 * 1000;
const REOPEN_FRESH = 30 * 60 * 1000;
const WAIT_EXIT_SECS = 60;
const MAX_RELEASES = 30;

const stateFile = () => path.join(U.dataRoot(), 'app-update.json');
const updatesDir = () => path.join(U.dataRoot(), 'updates');
const procsDir = () => path.join(updatesDir(), 'procs');
const installLogFile = () => path.join(updatesDir(), 'install.log');
const resultFile = (id) => path.join(updatesDir(), `install-${id}.result`);

// ---------- pure: versions, digests, releases, assets ----------
// strict x.y.z (a leading v is fine); anything else (x.y.z-beta, junk) = null
function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s == null ? '' : s).trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// -1 / 0 / 1, NaN when either side isn't a version
function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

// the API's asset `digest`: "sha256:<64 hex>" → lowercase hex, else null
function parseDigest(d) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(d == null ? '' : d).trim());
  return m ? m[1].toLowerCase() : null;
}

// GitHub's releases JSON → what we keep: published, non-prerelease, x.y.z tags
function compactReleases(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const r of json) {
    if (!r || typeof r !== 'object' || r.draft || r.prerelease) continue;
    const p = parseSemver(r.tag_name);
    if (!p) continue;
    const assets = [];
    for (const a of Array.isArray(r.assets) ? r.assets : []) {
      if (!a || typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
      assets.push({ name: a.name, url: a.browser_download_url, size: Number(a.size) > 0 ? Number(a.size) : 0, sha256: parseDigest(a.digest) });
    }
    out.push({
      version: p.join('.'),
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `VibeSpace ${p.join('.')}`,
      url: typeof r.html_url === 'string' ? r.html_url : null,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
      assets,
    });
  }
  out.sort((a, b) => cmpSemver(b.version, a.version));
  return out.slice(0, MAX_RELEASES);
}

// asset names electron-builder produces, best first:
//   macOS arm64  VibeSpace-<v>-arm64-mac.zip, VibeSpace-<v>-arm64.dmg
//   macOS x64    VibeSpace-<v>-mac.zip,       VibeSpace-<v>.dmg
//   Windows      "VibeSpace Setup <v>.exe" (GitHub turns the spaces into dots)
function assetMatchers(version, platform, arch) {
  if (!parseSemver(version)) return [];
  const v = String(version).replace(/^v/, '').replace(/\./g, '\\.');
  const re = (s, f) => new RegExp(`^${s}$`, f);
  if (platform === 'darwin') {
    const tag = arch === 'arm64' ? '-arm64' : arch === 'x64' ? '' : null;
    if (tag === null) return [];
    return [
      { kind: 'zip', re: re(`VibeSpace-${v}${tag}-mac\\.zip`) },
      { kind: 'dmg', re: re(`VibeSpace-${v}${tag}\\.dmg`) },
    ];
  }
  if (platform === 'win32') {
    const sep = '[ ._-]';
    const plain = { kind: 'exe', re: re(`VibeSpace${sep}Setup${sep}${v}\\.exe`, 'i') };
    const tagged = (a) => ({ kind: 'exe', re: re(`VibeSpace${sep}Setup${sep}${v}${sep}${a}\\.exe`, 'i') });
    if (arch === 'x64') return [plain, tagged('x64')];
    if (arch === 'arm64') return [tagged('arm64'), plain]; // x64 runs emulated
    return [];
  }
  return [];
}

// every usable asset of a release for this platform/arch, best first
function pickAssets(assets, version, platform, arch) {
  const list = (Array.isArray(assets) ? assets : []).filter(a => a && typeof a.name === 'string' && typeof a.url === 'string' && a.url);
  const out = [];
  for (const m of assetMatchers(version, platform, arch)) {
    const a = list.find(x => m.re.test(x.name));
    if (a && !out.some(o => o.name === a.name)) out.push({ name: a.name, url: a.url, size: Number(a.size) || 0, sha256: a.sha256 || null, kind: m.kind });
  }
  return out;
}

// the highest version above `current` that has an asset for this machine
function pickUpdate(releases, current, platform, arch) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || !(cmpSemver(r.version, current) > 0)) continue;
    const assets = pickAssets(r.assets, r.version, platform, arch);
    if (!assets.length) continue;
    if (!best || cmpSemver(r.version, best.version) > 0) {
      best = { version: r.version, name: r.name || `VibeSpace ${r.version}`, url: r.url || null, publishedAt: r.publishedAt || null, asset: assets[0], assets };
    }
  }
  return best;
}

// ---------- pure: the shared state file ----------
//   { v: 1, feed, etag, checkedAt, attemptAt, error,
//     releases: [{ version, name, url, publishedAt, assets: [{ name, url, size, sha256 }] }],
//     install: { id, version, from, execPath, at, by } | null   (quit request)
//     reopen:  { workspaces: [id], launcher, from, to, execPath, at } | null
//     result:  { ok, version, from, reason, at } | null }
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const releases = (Array.isArray(s.releases) ? s.releases : [])
    .filter(r => obj(r) && parseSemver(r.version) && Array.isArray(r.assets))
    .map(r => ({
      version: r.version,
      name: str(r.name),
      url: str(r.url),
      publishedAt: str(r.publishedAt),
      assets: r.assets.filter(a => obj(a) && str(a.name) && str(a.url))
        .map(a => ({ name: a.name, url: a.url, size: num(a.size) || 0, sha256: parseDigest(`sha256:${a.sha256}`) })),
    }));
  const i = obj(s.install);
  const install = i && str(i.id) && parseSemver(i.version) && str(i.execPath) && num(i.at)
    ? { id: i.id, version: i.version, from: str(i.from), execPath: i.execPath, at: i.at, by: num(i.by) } : null;
  const r = obj(s.reopen);
  const reopen = r && str(r.execPath) && num(r.at)
    ? { workspaces: (Array.isArray(r.workspaces) ? r.workspaces : []).filter(x => typeof x === 'string' && x), launcher: Boolean(r.launcher), from: str(r.from), to: str(r.to), execPath: r.execPath, at: r.at } : null;
  const x = obj(s.result);
  const result = x && str(x.version) && num(x.at)
    ? { ok: Boolean(x.ok), version: x.version, from: str(x.from), reason: str(x.reason), at: x.at } : null;
  return {
    v: 1,
    feed: str(s.feed),
    etag: str(s.etag),
    checkedAt: num(s.checkedAt),
    attemptAt: num(s.attemptAt),
    error: str(s.error),
    releases,
    install,
    reopen,
    result,
  };
}

// ---------- pure: helper scripts ----------
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// .../VibeSpace.app/Contents/MacOS/VibeSpace → .../VibeSpace.app (else null)
function bundleFromExecPath(execPath) {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  return m ? m[1] : null;
}

function cleanPids(pids) {
  return [...new Set((Array.isArray(pids) ? pids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

// macOS: wait for every process of the bundle to exit → move the old bundle
// aside → ditto the new one in → drop quarantine → check its version → delete
// the old one (or put it back) → relaunch. Processes are matched by a FIXED
// string (`grep -F`, `case`), never a regex: a path may hold ( ) . + etc.
function macInstallScript({ target, source, version, log, result, pids = [], relaunch = true, cleanup = null, waitSecs = WAIT_EXIT_SECS }) {
  if (!target || !path.posix.isAbsolute(target) || !/\.app$/.test(target)) throw new Error(`bad target app: ${target}`);
  if (!source || !path.posix.isAbsolute(source)) throw new Error(`bad source app: ${source}`);
  if (!parseSemver(version)) throw new Error(`bad version: ${version}`);
  if (!log || !result) throw new Error('log and result files are required');
  const steps = Math.max(1, Math.round(waitSecs * 2));
  return [
    '#!/bin/sh',
    '# VibeSpace self-update helper, written by main/appupdate.cjs. Runs detached:',
    '# waits for every process of this app bundle to exit, swaps the bundle and',
    '# relaunches it. Log: the file in LOG.',
    `TARGET=${shQuote(target)}`,
    `NEW=${shQuote(source)}`,
    `OLD=${shQuote(`${target}.old-${version}`)}`,
    `VERSION=${shQuote(version)}`,
    `LOG=${shQuote(log)}`,
    `RESULT=${shQuote(result)}`,
    `CLEANUP=${shQuote(cleanup || '')}`,
    `PIDS=${shQuote(cleanPids(pids).join(' '))}`,
    `RELAUNCH=${relaunch ? 1 : 0}`,
    `STEPS=${steps}`,
    '',
    'log() { printf \'%s %s\\n\' "$(/bin/date -u \'+%Y-%m-%dT%H:%M:%SZ\')" "$*" >> "$LOG"; }',
    'finish() { printf \'%s\\n\' "$1" > "$RESULT"; }',
    '# pids of this bundle still alive: the handed-over list + a full process scan',
    'running() {',
    '  for p in $PIDS; do',
    '    a=$(/bin/ps -p "$p" -o args= 2>/dev/null) || continue',
    '    case "$a" in *"$TARGET/Contents/"*) printf \' %s\' "$p" ;; esac',
    '  done',
    '  snap=$(/bin/ps -axww -o pid= -o args= 2>/dev/null)',
    '  printf \'%s\\n\' "$snap" | /usr/bin/grep -F -- "$TARGET/Contents/" | /usr/bin/awk \'{ printf " %s", $1 }\'',
    '}',
    'relaunch() {',
    '  [ "$RELAUNCH" = 1 ] || return 0',
    '  if /usr/bin/open -n "$TARGET" --args --relaunch-after-update >> "$LOG" 2>&1; then log "relaunched"; else log "relaunch failed"; fi',
    '}',
    'restore() {',
    '  /bin/rm -rf "$TARGET"',
    '  if /bin/mv "$OLD" "$TARGET"; then log "fail: $1 (the old app is back)"; finish "fail $1"',
    '  else log "fail: $1, and putting the old app back failed: it is at $OLD"; finish "fail $1 (old app left at $OLD)"; fi',
    '}',
    '',
    'log "install $VERSION: waiting for VibeSpace to quit ($TARGET)"',
    'n=0',
    'while :; do',
    '  left=$(running)',
    '  [ -z "$left" ] && break',
    '  n=$((n + 1))',
    '  if [ "$n" -gt "$STEPS" ]; then',
    `    log "fail: VibeSpace is still running after ${waitSecs} s:$left (nothing changed)"`,
    '    finish "fail still running"',
    '    exit 1',
    '  fi',
    '  /bin/sleep 0.5',
    'done',
    '/bin/rm -rf "$OLD"',
    'if ! /bin/mv "$TARGET" "$OLD"; then',
    '  log "fail: could not move the old app aside (nothing changed)"',
    '  finish "fail move"',
    '  relaunch',
    '  exit 1',
    'fi',
    'if /usr/bin/ditto "$NEW" "$TARGET"; then',
    '  /usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true',
    '  got=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$TARGET/Contents/Info.plist" 2>/dev/null)',
    '  if [ "$got" = "$VERSION" ]; then',
    '    /bin/rm -rf "$OLD"',
    '    [ -n "$CLEANUP" ] && /bin/rm -rf "$CLEANUP"',
    '    log "ok: VibeSpace $VERSION installed"',
    '    finish "ok $VERSION"',
    '  else',
    '    restore "the copied app reads version \'$got\'"',
    '  fi',
    'else',
    '  restore "copying the new app failed"',
    'fi',
    'relaunch',
    'exit 0',
    '',
  ].join('\n');
}

// Windows: wait for every VibeSpace.exe of the install folder to exit →
// re-check the installer's sha256 → run it silently into the SAME folder
// (electron-builder NSIS: /S, /currentuser|/allusers, /D= last and unquoted)
// → if that fails, run it normally so the user can finish → relaunch.
function winInstallScript({ installer, sha256 = null, installDir, version, log, result, pids = [], perMachine = false, relaunch = true, cleanup = null, waitSecs = WAIT_EXIT_SECS }) {
  if (!installer || !path.win32.isAbsolute(installer)) throw new Error(`bad installer path: ${installer}`);
  if (!installDir || !path.win32.isAbsolute(installDir)) throw new Error(`bad install folder: ${installDir}`);
  if (!parseSemver(version)) throw new Error(`bad version: ${version}`);
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('bad sha256');
  if (!log || !result) throw new Error('log and result files are required');
  const steps = Math.max(1, Math.round(waitSecs * 2));
  const list = cleanPids(pids);
  return [
    '# VibeSpace self-update helper, written by main/appupdate.cjs. Runs hidden and',
    '# detached: waits for every VibeSpace process of this install to exit, runs the',
    '# verified installer silently into the same folder and relaunches VibeSpace.',
    "$ErrorActionPreference = 'Continue'",
    `$Installer = ${psQuote(installer)}`,
    `$Sha256 = ${psQuote(sha256 || '')}`,
    `$InstallDir = ${psQuote(installDir.replace(/[\\/]+$/, ''))}`,
    `$Version = ${psQuote(version)}`,
    `$LogFile = ${psQuote(log)}`,
    `$ResultFile = ${psQuote(result)}`,
    `$Cleanup = ${psQuote(cleanup || '')}`,
    `$Pids = @(${list.join(', ')})`,
    `$Mode = ${psQuote(perMachine ? '/allusers' : '/currentuser')}`,
    `$Relaunch = $${relaunch ? 'true' : 'false'}`,
    `$Steps = ${steps}`,
    '',
    "function Log([string]$m) { try { Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' ' + $m) } catch {} }",
    'function Finish([string]$m) { try { Set-Content -LiteralPath $ResultFile -Value $m } catch {} }',
    "$Prefix = $InstallDir + '\\'",
    'function Get-Running {',
    '  $ids = @()',
    '  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {',
    '    $exe = $null',
    '    try { $exe = $p.Path } catch {}',
    '    if ($exe -and $exe.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { $ids += $p.Id }',
    '  }',
    '  foreach ($id in $Pids) {',
    '    if ($ids -contains $id) { continue }',
    '    $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '    if (-not $p) { continue }',
    '    $exe = $null',
    '    try { $exe = $p.Path } catch {}',
    '    if ((-not $exe) -or $exe.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { $ids += $id }',
    '  }',
    '  return $ids',
    '}',
    'function Start-VibeSpace {',
    '  if (-not $Relaunch) { return }',
    "  $exe = Join-Path $InstallDir 'VibeSpace.exe'",
    "  try { Start-Process -FilePath $exe -ArgumentList '--relaunch-after-update'; Log 'relaunched' } catch { Log ('relaunch failed: ' + $_.Exception.Message) }",
    '}',
    '',
    'Log ("install " + $Version + ": waiting for VibeSpace to quit (" + $InstallDir + ")")',
    '$n = 0',
    'while ($true) {',
    '  $left = @(Get-Running)',
    '  if ($left.Count -eq 0) { break }',
    '  $n++',
    '  if ($n -gt $Steps) {',
    `    Log ('fail: VibeSpace is still running after ${waitSecs} s: ' + ($left -join ' ') + ' (nothing changed)')`,
    "    Finish 'fail still running'",
    '    exit 1',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    'if ($Sha256) {',
    '  $h = $null',
    '  try { $h = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() } catch {}',
    '  if ($h -ne $Sha256) {',
    "    Log ('fail: the installer changed on disk (sha256 ' + $h + '), not running it')",
    "    Finish 'fail installer changed'",
    '    Start-VibeSpace',
    '    exit 1',
    '  }',
    '}',
    "$ArgLine = '/S ' + $Mode + ' /D=' + $InstallDir",
    "Log ('running the installer silently: ' + $ArgLine)",
    '$code = $null',
    'try { $proc = Start-Process -FilePath $Installer -ArgumentList $ArgLine -PassThru -Wait; $code = $proc.ExitCode } catch { Log (\'silent install could not start: \' + $_.Exception.Message) }',
    'if ($code -ne 0) {',
    "  Log ('silent install ended with ' + $code + ': running the installer normally')",
    '  try { $proc = Start-Process -FilePath $Installer -PassThru -Wait; $code = $proc.ExitCode } catch { Log (\'installer could not start: \' + $_.Exception.Message) }',
    '}',
    '$got = $null',
    "try { $got = (Get-Item -LiteralPath (Join-Path $InstallDir 'VibeSpace.exe') -ErrorAction Stop).VersionInfo.ProductVersion } catch {}",
    "$okVersion = $got -and ($got -match ('^' + [regex]::Escape($Version) + '(\\.0)?$'))",
    'if ($code -eq 0 -and ($okVersion -or -not $got)) {',
    "  Log ('ok: VibeSpace ' + $Version + ' installed (exe version ' + $got + ')')",
    "  Finish ('ok ' + $Version)",
    '  if ($Cleanup) { Remove-Item -LiteralPath $Cleanup -Recurse -Force -ErrorAction SilentlyContinue }',
    '} else {',
    "  Log ('fail: installer exit code ' + $code + ', exe version ' + $got)",
    "  Finish ('fail installer exit ' + $code)",
    '}',
    'Start-VibeSpace',
    'exit 0',
    '',
  ].join('\r\n');
}

// ---------- disk helpers ----------
function readState() {
  return normalizeState(U.readJson(stateFile(), {}));
}

// read-modify-write right before the write (several processes share the file)
function patchState(patch) {
  const next = { ...readState(), ...patch };
  U.ensureDir(path.dirname(stateFile()));
  U.writeJsonAtomic(stateFile(), next);
  return next;
}

function takeLock(file, staleMs) {
  U.ensureDir(path.dirname(file));
  for (let i = 0; i < 2; i++) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age < staleMs) return false;
      try { fs.rmSync(file, { force: true }); } catch { return false; }
    }
  }
  return false;
}
const dropLock = (file) => { try { fs.rmSync(file, { force: true }); } catch {} };

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// size (when known) + sha256 (when the API gave one)
async function verifyFile(file, asset) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { ok: false, reason: 'missing' }; }
  if (asset.size > 0 && size !== asset.size) return { ok: false, reason: `size ${size} != ${asset.size}` };
  const sha256 = await hashFile(file);
  if (asset.sha256) {
    return sha256 === asset.sha256 ? { ok: true, sha256, by: 'sha256' } : { ok: false, reason: `sha256 ${sha256} != ${asset.sha256}` };
  }
  return asset.size > 0 ? { ok: true, sha256, by: 'size' } : { ok: false, reason: 'neither a digest nor a size to check against' };
}

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
    });
  });
}

// ---------- network ----------
const userAgent = (version) => `VibeSpace/${version || '0'} (+https://github.com/${REPO})`;

// one check: ETag/If-None-Match, 10 s timeout. Never throws; returns what happened.
async function check({ feed = DEFAULT_FEED, version = '0.0.0', fetchImpl = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const st = readState();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': userAgent(version), 'X-GitHub-Api-Version': '2022-11-28' };
  if (st.feed === feed && st.etag && st.releases.length) headers['If-None-Match'] = st.etag;
  let res;
  try {
    res = await fetchImpl(feed, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT) });
  } catch (e) {
    const error = (e && (e.cause && e.cause.code || e.name === 'TimeoutError' && 'timeout' || e.message)) || String(e);
    patchState({ attemptAt: now(), error: `check failed: ${error}` });
    log(`check failed: ${error}`);
    return { ok: false, error };
  }
  if (res.status === 304) {
    patchState({ attemptAt: now(), checkedAt: now(), error: null });
    log('check: not modified');
    return { ok: true, notModified: true };
  }
  if (!res.ok) {
    const error = `HTTP ${res.status}`;
    patchState({ attemptAt: now(), error: `check failed: ${error}` });
    log(`check failed: ${error}`);
    return { ok: false, error };
  }
  let json;
  try { json = await res.json(); } catch (e) {
    patchState({ attemptAt: now(), error: 'check failed: bad JSON' });
    log('check failed: bad JSON');
    return { ok: false, error: 'bad JSON' };
  }
  const releases = compactReleases(json);
  patchState({ feed, etag: res.headers.get('etag') || null, releases, attemptAt: now(), checkedAt: now(), error: null });
  log(`check: ${releases.length} release(s), newest ${releases[0] ? releases[0].version : 'none'}`);
  return { ok: true, releases };
}

// stream to <dir>/<name>.part (resumes with Range), verify, rename. Never
// returns an unverified file.
async function download(asset, dir, { onProgress = null, allowHttp = false, fetchImpl = globalThis.fetch, version = '0.0.0', log = () => {} } = {}) {
  const name = String(asset && asset.name || '');
  if (!name || path.basename(name) !== name || name.startsWith('.') || /[\\/:]/.test(name)) throw new Error(`bad asset name ${JSON.stringify(name)}`);
  const u = new URL(asset.url);
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error(`refusing a ${u.protocol} download`);
  if (!asset.sha256 && !(asset.size > 0)) throw new Error('the release lists neither a sha256 digest nor a size: refusing it');
  if (!asset.sha256) log(`${name}: the release has no sha256 digest, checking the size only`);
  U.ensureDir(dir);
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    const v = await verifyFile(file, asset);
    if (v.ok) { if (onProgress) onProgress(100); return { file, ...v, cached: true }; }
    fs.rmSync(file, { force: true });
  }
  const part = `${file}.part`;
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  if (asset.size > 0 && have > asset.size) { fs.rmSync(part, { force: true }); have = 0; }
  if (!(asset.size > 0 && have === asset.size)) {
    const ctrl = new AbortController();
    let stall = null;
    const kick = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(new Error('download stalled')), STALL_TIMEOUT); };
    kick();
    try {
      const headers = { 'User-Agent': userAgent(version), Accept: 'application/octet-stream' };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const res = await fetchImpl(asset.url, { headers, signal: ctrl.signal, redirect: 'follow' });
      if (res.status === 416) { fs.rmSync(part, { force: true }); throw new Error('HTTP 416 (the partial download was dropped, try again)'); }
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      if (res.status === 200) have = 0; // the server ignored the Range: start over
      if (!res.body) throw new Error('empty response');
      if (have > 0) log(`${name}: resuming at ${have} bytes`);
      const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
      let got = have;
      let lastPct = -1;
      try {
        for await (const chunk of res.body) {
          kick();
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
          got += chunk.length;
          if (onProgress && asset.size > 0) {
            const pct = Math.min(99, Math.floor(got * 100 / asset.size));
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
          }
        }
      } finally {
        await new Promise(r => out.end(r));
      }
    } finally {
      clearTimeout(stall);
    }
  }
  const v = await verifyFile(part, asset);
  if (!v.ok) { fs.rmSync(part, { force: true }); throw new Error(`${name} failed verification: ${v.reason}`); }
  fs.renameSync(part, file);
  if (onProgress) onProgress(100);
  log(`${name}: downloaded and verified (${v.by})`);
  return { file, ...v };
}

// ---------- macOS: unpack + check the new app ----------
async function plistGet(plist, key) {
  const r = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], 20000);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function checkMacApp(appPath, version) {
  const sig = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], 300000);
  if (sig.code !== 0) throw new Error(`codesign --verify failed: ${sig.stderr.trim().split('\n')[0]}`);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const v = await plistGet(plist, 'CFBundleShortVersionString');
  if (v !== version) throw new Error(`the downloaded app says version ${v}, expected ${version}`);
  const id = await plistGet(plist, 'CFBundleIdentifier');
  if (id !== BUNDLE_ID) throw new Error(`the downloaded app is ${id}, expected ${BUNDLE_ID}`);
}

// zip → ditto -x -k; dmg → hdiutil attach (read-only, no Finder window) +
// ditto + detach. Returns the checked .app inside <workDir>/app/.
async function prepareMac(file, kind, version, workDir) {
  const out = path.join(workDir, 'app');
  fs.rmSync(out, { recursive: true, force: true });
  U.ensureDir(out);
  if (kind === 'zip') {
    const r = await run('/usr/bin/ditto', ['-x', '-k', file, out], 600000);
    if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr.trim()}`);
  } else if (kind === 'dmg') {
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-update-mnt-'));
    const a = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-noverify', '-mountpoint', mnt, file], 180000);
    if (a.code !== 0) { try { fs.rmdirSync(mnt); } catch {} throw new Error(`hdiutil attach failed: ${a.stderr.trim()}`); }
    try {
      const name = fs.readdirSync(mnt).find(n => n.endsWith('.app'));
      if (!name) throw new Error('no .app in the disk image');
      const c = await run('/usr/bin/ditto', [path.join(mnt, name), path.join(out, name)], 600000);
      if (c.code !== 0) throw new Error(`copying from the disk image failed: ${c.stderr.trim()}`);
    } finally {
      let d = await run('/usr/bin/hdiutil', ['detach', mnt, '-quiet'], 60000);
      if (d.code !== 0) d = await run('/usr/bin/hdiutil', ['detach', mnt, '-force', '-quiet'], 60000);
      try { fs.rmdirSync(mnt); } catch {}
    }
  } else {
    throw new Error(`unknown archive kind: ${kind}`);
  }
  const apps = fs.readdirSync(out).filter(n => n.endsWith('.app'));
  const name = apps.includes('VibeSpace.app') ? 'VibeSpace.app' : apps[0];
  if (!name) throw new Error('no .app in the download');
  const appPath = path.join(out, name);
  await checkMacApp(appPath, version);
  return appPath;
}

// can the helper swap this bundle? Not from a read-only dmg, not from App
// Translocation (an app run straight from Downloads), not without write access.
function canReplaceBundle(bundle) {
  if (!bundle) return { ok: false, reason: 'not running from an app bundle' };
  if (bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'macOS runs this copy from a read-only App Translocation folder' };
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch (e) {
    return { ok: false, reason: `${path.dirname(bundle)} is not writable (${e.code || e.message})` };
  }
  return { ok: true };
}

function writeScript(dir, name, text, { bom = false } = {}) {
  U.ensureDir(dir);
  const file = path.join(dir, name);
  // Windows PowerShell 5.1 reads a BOM-less file as ANSI: a non-ASCII path would break
  fs.writeFileSync(file, (bom ? '\ufeff' : '') + text, { mode: 0o755 });
  return file;
}

// ---------- process registry (who runs, from which executable) ----------
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function sameExec(a, b) {
  if (!a || !b) return false;
  const n = (p) => path.resolve(p);
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function liveProcs(execPath) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(procsDir()); } catch { return out; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const file = path.join(procsDir(), n);
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (!j || !Number.isInteger(j.pid) || !isAlive(j.pid)) { try { fs.rmSync(file, { force: true }); } catch {} continue; }
    if (!execPath || sameExec(j.execPath, execPath)) out.push(j);
  }
  return out;
}

// ---------- the running app (electron side) ----------
let ctx = null; // { app, BrowserWindow, ipcMain, shell, logger, wsId }
let started = false;
let busy = null; // { phase: download|verify|install|quit, pct }
let lastMtime = -1;
let lastViewJson = '';
let quitAsked = false;
const startedAt = Date.now();

const log = (msg) => { try { ctx && ctx.logger.info(`app update: ${msg}`); } catch {} };
const env = () => process.env;
const feedUrl = () => env().VIBESPACE_UPDATE_FEED || DEFAULT_FEED;
const feedOverridden = () => Boolean(env().VIBESPACE_UPDATE_FEED);
const enabled = () => Boolean(ctx && (ctx.app.isPackaged || env().VIBESPACE_UPDATE_FORCE === '1'));
const version = () => (ctx ? ctx.app.getVersion() : '0.0.0');
const targetOverride = () => env().VIBESPACE_UPDATE_TARGET || null;
const dryRun = () => !ctx.app.isPackaged && !targetOverride();

function pendingInstall(st, now = Date.now()) {
  const i = st.install;
  return Boolean(i && now - i.at < INSTALL_FRESH && !fs.existsSync(resultFile(i.id)));
}

function view() {
  const st = readState();
  const on = enabled();
  const upd = on ? pickUpdate(st.releases, version(), process.platform, process.arch) : null;
  const result = on && st.result && Date.now() - st.result.at < RESULT_SHOW ? st.result : null;
  return {
    enabled: on,
    current: version(),
    update: upd ? { version: upd.version, name: upd.name, url: upd.url, asset: upd.asset.name, size: upd.asset.size } : null,
    busy,
    result,
    checkedAt: st.checkedAt,
    error: st.error,
  };
}

function push(force = false) {
  if (!ctx) return;
  const v = view();
  const json = JSON.stringify(v);
  if (!force && json === lastViewJson) return;
  lastViewJson = json;
  for (const w of ctx.BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send('appupdate:state', v); } catch {} }
  }
}

function setBusy(phase, pct = null) {
  busy = phase ? { phase, pct } : null;
  push();
}

// another process of THIS install asked everyone to quit for an update
function maybeQuitForInstall(st) {
  if (quitAsked || !enabled()) return;
  const i = st.install;
  if (!i || i.by === process.pid || !pendingInstall(st)) return;
  if (!sameExec(i.execPath, process.execPath) || i.version === version()) return;
  quitAsked = true;
  log(`quitting: process ${i.by} installs ${i.version}`);
  setTimeout(() => ctx.quit(), 200);
}

let lastPollPush = 0;
function poll() {
  let m = 0;
  try { m = fs.statSync(stateFile()).mtimeMs; } catch {}
  const now = Date.now();
  if (m !== lastMtime) {
    lastMtime = m;
    maybeQuitForInstall(readState());
  } else if (now - lastPollPush < 60000) {
    return;
  }
  lastPollPush = now;
  push(); // a minute later at the latest: an old `result` expires
}

async function maybeCheck(minAge) {
  if (!enabled()) return;
  const st = readState();
  const last = st.feed === feedUrl() ? (st.attemptAt || 0) : 0;
  if (Date.now() - last < minAge) return;
  const lock = path.join(updatesDir(), 'check.lock');
  if (!takeLock(lock, LOCK_STALE)) return; // another process is checking
  try {
    await check({ feed: feedUrl(), version: version(), log });
  } finally {
    dropLock(lock);
  }
  push();
}

// helper's verdict from the last install, judged by the first process after it
function settleLastInstall() {
  const st = readState();
  const i = st.install;
  if (!i || !sameExec(i.execPath, process.execPath)) return;
  let res = null;
  try { res = fs.readFileSync(resultFile(i.id), 'utf8').trim(); } catch {}
  if (!res && Date.now() - i.at < INSTALL_FRESH) return; // still running (we'll be asked to quit)
  const ok = Boolean(res && res.startsWith('ok')) && version() === i.version;
  const reason = ok ? null : (res ? res.replace(/^fail\s*/, '') : 'the update helper never reported back') || 'unknown';
  patchState({ install: null, result: { ok, version: i.version, from: i.from, reason, at: Date.now() } });
  try { fs.rmSync(resultFile(i.id), { force: true }); } catch {}
  dropLock(path.join(updatesDir(), 'install.lock'));
  log(ok ? `now running ${version()} (updated from ${i.from})` : `install of ${i.version} failed: ${reason} (running ${version()}; see ${installLogFile()})`);
}

// downloads of versions we already run (or older) are done with
function pruneDownloads() {
  let names = [];
  try { names = fs.readdirSync(updatesDir()); } catch { return; }
  for (const n of names) {
    if (parseSemver(n) && cmpSemver(n, version()) <= 0) {
      try { fs.rmSync(path.join(updatesDir(), n), { recursive: true, force: true }); } catch {}
    }
  }
}

// ---------- install ----------
async function installNow() {
  if (!enabled()) return { ok: false, error: 'updates are off in this build' };
  if (busy) return { ok: false, error: 'an update is already running' };
  const upd = pickUpdate(readState().releases, version(), process.platform, process.arch);
  if (!upd) return { ok: false, error: 'no update available' };
  const lockFile = path.join(updatesDir(), 'install.lock');
  if (!takeLock(lockFile, INSTALL_LOCK_STALE)) return { ok: false, error: 'another VibeSpace window is already updating' };
  let keepLock = false;
  try {
    log(`installing ${upd.version} (${upd.asset.name}) over ${version()}`);
    setBusy('download', 0);
    const dir = path.join(updatesDir(), upd.version);
    const allowHttp = feedOverridden();
    const fetchFile = async (asset) => download(asset, dir, { allowHttp, version: version(), log, onProgress: (pct) => setBusy('download', pct) });

    if (process.platform === 'darwin') {
      let appPath = null;
      let file = null;
      let lastErr = null;
      for (const asset of upd.assets) { // zip first; a zip that fails its checks falls back to the dmg
        try {
          setBusy('download', 0);
          file = (await fetchFile(asset)).file;
          setBusy('verify');
          appPath = await prepareMac(file, asset.kind, upd.version, dir);
          break;
        } catch (e) {
          lastErr = e;
          log(`${asset.name}: ${e.message}`);
        }
      }
      if (!appPath) throw lastErr || new Error('nothing to install');
      const bundle = targetOverride() || bundleFromExecPath(process.execPath);
      const can = dryRun() ? { ok: true } : canReplaceBundle(bundle);
      if (!can.ok) {
        log(`can't replace ${bundle}: ${can.reason} — showing the new app in Finder instead`);
        if (/\.dmg$/i.test(file)) await ctx.shell.openPath(file);
        else ctx.shell.showItemInFolder(appPath);
        return {
          ok: false,
          manual: true,
          message: `VibeSpace can't replace itself here (${can.reason}). The new version is open in Finder: quit VibeSpace, drag VibeSpace into Applications and choose Replace.`,
        };
      }
      setBusy('install');
      return await handOver(upd, dir, (pids, relaunch, id) => writeScript(updatesDir(), `install-${upd.version}.sh`, macInstallScript({
        target: bundle, source: appPath, version: upd.version, log: installLogFile(), result: resultFile(id),
        pids, relaunch, cleanup: dir,
      })), (script) => spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }), (k) => { keepLock = k; });
    }

    if (process.platform === 'win32') {
      const asset = upd.asset;
      const { file, sha256 } = await fetchFile(asset);
      setBusy('install');
      const installDir = targetOverride() || path.dirname(process.execPath);
      const pf = [env().ProgramFiles, env()['ProgramFiles(x86)'], env().ProgramW6432].filter(Boolean).map(p => p.toLowerCase().replace(/[\\/]+$/, '') + '\\');
      const perMachine = pf.some(p => (installDir.toLowerCase() + '\\').startsWith(p));
      const ps = path.join(env().SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return await handOver(upd, dir, (pids, relaunch, id) => writeScript(updatesDir(), `install-${upd.version}.ps1`, winInstallScript({
        installer: file, sha256: asset.sha256 ? sha256 : null, installDir, version: upd.version, log: installLogFile(), result: resultFile(id),
        pids, perMachine, relaunch, cleanup: dir,
      }), { bom: true }), (script) => spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
        { detached: true, stdio: 'ignore', windowsHide: true }), (k) => { keepLock = k; });
    }
    return { ok: false, error: `updates aren't supported on ${process.platform}` };
  } catch (e) {
    log(`install failed: ${e && e.message ? e.message : e}`);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    if (!keepLock) { dropLock(lockFile); setBusy(null); }
  }
}

// write the helper, record who quits and what reopens, start it, quit.
// Dry run (unpackaged, no target): stop after writing the helper.
// A target override (testing): run the helper on that target, quit nothing.
async function handOver(upd, dir, writeHelper, startHelper, setKeepLock) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  if (dryRun()) {
    const script = writeHelper([], false, id);
    log(`dry run: verified ${dir}, helper written to ${script} (not started)`);
    return { ok: true, dryRun: true, message: `Downloaded and verified ${upd.version}; the install helper is at ${script} (dry run: not started).` };
  }
  if (targetOverride()) {
    const script = writeHelper([], false, id);
    const child = startHelper(script);
    child.unref();
    log(`test install of ${upd.version} into ${targetOverride()} started (${script}); this process keeps running`);
    return { ok: true, test: true, message: `Installing ${upd.version} into ${targetOverride()} (see ${installLogFile()}).` };
  }
  const procs = liveProcs(process.execPath);
  const pids = [...new Set([process.pid, ...procs.map(p => p.pid)])];
  const wsIds = [...new Set([ctx.wsId, ...procs.map(p => p.wsId)].filter(Boolean))];
  const launcher = !ctx.wsId || procs.some(p => !p.wsId);
  const script = writeHelper(pids, true, id);
  const now = Date.now();
  patchState({
    install: { id, version: upd.version, from: version(), execPath: process.execPath, at: now, by: process.pid },
    reopen: { workspaces: wsIds, launcher, from: version(), to: upd.version, execPath: process.execPath, at: now },
  });
  const child = startHelper(script);
  child.unref();
  setKeepLock(true);
  log(`helper started (${script}); quitting ${pids.length} process(es); reopen after: ${wsIds.join(', ') || 'no workspaces'}${launcher ? ' + launcher' : ''}`);
  busy = { phase: 'quit', pct: null };
  push();
  quitAsked = true;
  setTimeout(() => ctx.quit(), 600);
  return { ok: true, quitting: true };
}

// agents working in OTHER workspaces of this install (the update quits them too)
function busyElsewhere() {
  if (!enabled()) return [];
  const ids = new Set(liveProcs(process.execPath).map(p => p.wsId).filter(id => id && id !== ctx.wsId));
  if (!ids.size) return [];
  const names = [];
  try {
    for (const j of require('./board.cjs').readOthers(ctx.wsId)) {
      if (!ids.has(j.wsId)) continue;
      for (const a of j.agents || []) if (a.status === 'working') names.push(`${a.name} (${j.name})`);
    }
  } catch {}
  return names;
}

// ---------- wiring ----------
// IPC only (every mode, smoke included: a window may ask)
function init(c) {
  ctx = c;
  const { ipcMain } = c;
  ipcMain.handle('appupdate:get', () => view());
  ipcMain.handle('appupdate:install', () => installNow());
  ipcMain.handle('appupdate:busyElsewhere', () => busyElsewhere());
  ipcMain.handle('appupdate:notes', () => {
    const upd = view().update;
    const url = upd && upd.url;
    if (!url || !(url.startsWith(`https://github.com/${REPO}/`) || feedOverridden())) return false;
    ctx.shell.openExternal(url);
    return true;
  });
}

// a normal launcher/workspace process: registry, quit watch, checks
function start() {
  if (!ctx || started || !enabled()) return;
  started = true;
  try {
    U.ensureDir(procsDir());
    U.writeJsonAtomic(path.join(procsDir(), `${process.pid}.json`), {
      pid: process.pid, wsId: ctx.wsId || null, execPath: process.execPath, version: version(), startedAt,
    });
  } catch (e) { log(`registry write failed: ${e.message}`); }
  ctx.app.on('will-quit', () => {
    for (const f of [`${process.pid}.json`, `${process.pid}.json.bak`]) { try { fs.rmSync(path.join(procsDir(), f), { force: true }); } catch {} }
  });
  try { settleLastInstall(); } catch (e) { log(`settle failed: ${e.message}`); }
  if (!pendingInstall(readState())) pruneDownloads();
  poll();
  setInterval(poll, POLL).unref?.();
  setTimeout(() => maybeCheck(START_MIN_GAP), START_DELAY).unref?.();
  setInterval(() => maybeCheck(CHECK_EVERY), TICK).unref?.();
}

// the launcher's first start after an update: reopen what was open.
// → 'quit' (workspaces reopened, the launcher wasn't open), 'launcher' or 'none'
function reopenAfterUpdate(openWorkspace) {
  if (!enabled()) return 'none';
  const st = readState();
  const r = st.reopen;
  if (!r || !sameExec(r.execPath, process.execPath) || pendingInstall(st)) return 'none';
  patchState({ reopen: null });
  const relaunched = process.argv.includes(RELAUNCH_FLAG);
  if (!relaunched && Date.now() - r.at > REOPEN_FRESH) { log('dropped an old reopen record'); return 'none'; }
  for (const id of r.workspaces) {
    try { openWorkspace(id); } catch (e) { log(`reopen ${id} failed: ${e.message}`); }
  }
  log(`reopened after the update: ${r.workspaces.join(', ') || 'no workspaces'}${r.launcher ? ' + launcher' : ''}`);
  return r.launcher || !r.workspaces.length ? 'launcher' : 'quit';
}

module.exports = {
  init,
  start,
  reopenAfterUpdate,
  RELAUNCH_FLAG,
  // pure (smoke)
  parseSemver,
  cmpSemver,
  parseDigest,
  compactReleases,
  assetMatchers,
  pickAssets,
  pickUpdate,
  normalizeState,
  shQuote,
  psQuote,
  bundleFromExecPath,
  macInstallScript,
  winInstallScript,
  // disk/network (smoke)
  readState,
  patchState,
  check,
  download,
  verifyFile,
  prepareMac,
  canReplaceBundle,
  writeScript,
  liveProcs,
  stateFile,
  updatesDir,
  DEFAULT_FEED,
};
