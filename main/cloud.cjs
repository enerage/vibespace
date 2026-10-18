'use strict';
// Send to cloud (0.6.58): Claude Code cloud sessions (`claude --cloud`,
// `claude --teleport`) started from VibeSpace on a CHOSEN account.
//
// Cloud features need a real claude.ai login. A setup-token (our token
// accounts) can't start them, and CLAUDE_CODE_OAUTH_TOKEN overrides a login,
// so cloud calls run the real claude.exe with that variable removed
// (renderer/workspace/ui/shellcmd.js realClaudeLine). Each token account gets
// its OWN cloud-only config dir, <dataRoot>/cloud/<accountId>, where the user
// signs in once with claude's own login (browser OAuth). Only cloud tabs ever
// use it: normal agent tabs keep the one shared ~/.claude (CLAUDE.md, Accounts).
// The /login account needs no extra dir: its claude.ai login is already the
// normal config (CLAUDE_CONFIG_DIR if the user set one, else ~/.claude).
//
// Ready = the dir holds claude's credentials (.credentials.json, plain text on
// Windows) or its .claude.json names an oauthAccount. An API key alone is not
// a claude.ai login, so it doesn't count. On macOS the credentials are a
// Keychain item instead of the file (readiness below).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('./util.cjs');
const accounts = require('./accounts.cjs');
const keychain = require('./keychain.cjs');

const LOGIN = accounts.LOGIN;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const home = () => process.env.USERPROFILE || os.homedir();
let rootOverride = null; // smoke
const cloudRoot = () => rootOverride || path.join(U.dataRoot(), 'cloud');

// null = the account's normal config (the /login); else its cloud-only dir
function dirFor(id) {
  if (id === LOGIN) return null;
  if (!ID_RE.test(String(id || ''))) throw new Error('bad account id');
  return path.join(cloudRoot(), id);
}

// where claude keeps credentials + .claude.json for this account's cloud calls
function configOf(id) {
  const dir = dirFor(id);
  if (dir) return { credentials: path.join(dir, '.credentials.json'), claudeJson: path.join(dir, '.claude.json') };
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) return { credentials: path.join(env, '.credentials.json'), claudeJson: path.join(env, '.claude.json') };
  return { credentials: path.join(home(), '.claude', '.credentials.json'), claudeJson: path.join(home(), '.claude.json') };
}

// pure: { credentials: bool, claudeJson: parsed object | null } → { ready, email }
function readinessFrom({ credentials = false, claudeJson = null } = {}) {
  const oa = claudeJson && typeof claudeJson === 'object' ? claudeJson.oauthAccount : null;
  const email = oa && typeof oa.emailAddress === 'string' ? oa.emailAddress : null;
  return { ready: Boolean(credentials || email || (oa && oa.accountUuid)), email };
}

// macOS: claude keeps the login in the Keychain, keyed to the config dir
// (keychain.cjs claudeLoginService: sha256 of the exact CLAUDE_CONFIG_DIR
// string). A cloud tab must therefore set CLAUDE_CONFIG_DIR to exactly
// dirFor(id), or claude and this check name different items.
function keychainServiceOf(id) {
  const dir = dirFor(id);
  return keychain.claudeLoginService(dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env);
}

function readiness(id) {
  let c;
  try { c = configOf(id); } catch { return { ready: false, email: null }; }
  let claudeJson = null;
  try { claudeJson = JSON.parse(fs.readFileSync(c.claudeJson, 'utf8')); } catch {}
  if (process.platform === 'darwin') {
    // asked on demand (not per tick): a short cache, so a fresh sign-in shows soon
    const credentials = fs.existsSync(c.credentials) || keychain.exists(keychainServiceOf(id), null, { maxAgeMs: 5000 });
    return readinessFrom({ credentials, claudeJson });
  }
  return readinessFrom({ credentials: fs.existsSync(c.credentials), claudeJson });
}

// cloud needs a Claude account: the /login and setup-token accounts, never an
// API endpoint (z.ai has no claude.ai login)
const eligible = (row) => Boolean(row && (row.kind === 'login' || row.kind === 'token'));

// { [accountId]: { ready, email, own } } for every eligible account
// (own = it has a cloud-only config dir, i.e. it is not the /login)
function state() {
  const out = {};
  for (const a of accounts.state().accounts) {
    if (!eligible(a)) continue;
    out[a.id] = { ...readiness(a.id), own: a.id !== LOGIN };
  }
  return out;
}

// before a cloud tab types anything: the config dir to use (created for a
// token account's login), and whether the account is signed in there yet
function prepare(id, { create = false } = {}) {
  const row = accounts.state().accounts.find(a => a.id === id);
  if (!eligible(row)) return { ok: false, error: row ? 'API endpoint accounts have no claude.ai login' : 'unknown account' };
  const dir = dirFor(id);
  if (dir && create) U.ensureDir(dir);
  return { ok: true, configDir: dir, label: row.label, ...readiness(id) };
}

// shell.openExternal gets web links only (never file:, never an app protocol)
function isWebUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return false;
  try {
    const p = new URL(u);
    return (p.protocol === 'https:' || p.protocol === 'http:') && Boolean(p.host);
  } catch { return false; }
}

module.exports = {
  dirFor, configOf, readiness, readinessFrom, state, prepare, eligible, isWebUrl, keychainServiceOf,
  _setRoot: (r) => { rootOverride = r; },
};
