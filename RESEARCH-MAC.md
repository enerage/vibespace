# VibeSpace on macOS: plan, code audit and research

Started 2026-10-18 on Valentin's request ("make VibeSpace work on Mac"). The first Mac
user is his sister (MacBook, non-technical, one workspace, z.ai GLM preset), and the
Kiddoss session asked for image/video preview as well (its review:
`D:\Repositories\Kiddoss\research\opportunities\38a-vibespace-mac-glm-recheck.md`).

## Decisions (Valentin, 2026-10-18)
- **Scope: core port first, extras later.**
  - Phase 1: terminals, agents, the `claude` wrapper, every account kind (z.ai and
    Claude), session tracking, worktrees, the Git pane, the file tree, image/video
    preview (new on both platforms), Dock icon and badge, Mac keys and menu.
  - Phase 1 also includes an automated Mac build and smoke run on GitHub Actions.
  - Phase 2: a separate pinnable Dock icon per repo (one generated `.app` clone per
    workspace, needs a real-Mac spike first), Send to cloud on Mac
    (`cloud-send.sh`), and the Finder right-click entry.
- **Signing:** free ad-hoc signing now. The tester clicks Open Anyway in System
  Settings once per install. The $99/yr Developer ID comes later, only if the Mac build
  stays in use.
- **Testing:** GitHub's macOS runners run every build automatically. The only real Mac
  is the sister's MacBook, which gets a short hands-on checklist at the end.

## Ground rules for the port
- **Windows behaviour must not change.** Every Mac path sits behind
  `process.platform === 'darwin'` (main) or `vs.platform` (renderer). Windows code is
  moved, never rewritten. The Windows smoke must stay green after every merge.
- Mac design choices (from the research below):
  - Shell: the user's `$SHELL` (zsh) as a login shell. Our `claude()` function goes in
    through a `ZDOTDIR` rc that sources the user's own rc files first, the way VS Code
    does it.
  - PATH: GUI apps get only `/usr/bin:/bin`, so main reads the login shell's PATH once
    at boot, with a timeout and a fallback list.
  - Secrets: Keychain generic-password items through `/usr/bin/security`. This replaces
    DPAPI with the same trust model. Not `safeStorage`, which would prompt for every
    future per-workspace clone.
  - Process tree: one `ps -A -o pid=,ppid=,pgid=,comm=` snapshot, SIGTERM the tree and
    the process group, SIGKILL any survivors, and only then close the pty (same order as
    `taskkill /T`).
  - Claude login on a Mac: it is in the Keychain (`Claude Code-credentials`, or
    `…-<first 8 hex chars of sha256(config dir)>`), not in `.credentials.json`.
  - Prompt detection: a precmd OSC marker printed by our rc, not a prompt regex.
  - node-pty 1.1.0 prebuilds (darwin arm64 and x64) need `chmod +x spawn-helper`
    (shipped as mode 0644) at install time and after packaging.
  - electron-builder 26.15.3 no longer ad-hoc signs by itself, so we sign explicitly
    and verify with `codesign -dv`.
  - CI: `macos-15` (Apple Silicon) and an Intel runner build dmg and zip, and run the
    packaged `--smoke` with a real window. Screenshots use `capturePage`.


# Part 2: code audit, every Windows-only spot (2026-10-18, HEAD e73b45e)

Severity: **B** = blocker (the app can't start or agents can't run), **M** = major (a feature is broken), **m** = minor (cosmetic or UX).

## 1. pty + shell (~250 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| main/ptyhost.cjs:218-225 | `pty.spawn('powershell.exe', …, {useConpty:true})` | B | `$SHELL` (zsh) login shell |
| ptyhost.cjs:181 | `-NoLogo -NoExit -EncodedCommand <wrapper>` | B | zsh `ZDOTDIR` rc that sources the user's rc, then defines `claude()` |
| ptyhost.cjs:48-61 | `withSinglePath` writes `env.Path` | B | `PATH` on darwin |
| ptyhost.cjs:63-71 | `ensureClaudeOnPath`: `;` split, lowercase compare | B | `path.delimiter`, case-sensitive |
| ptyhost.cjs:78-93 | `repairPath` adds System32 | B | `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:~/.local/bin` |
| main/index.cjs:7-11, util.cjs:165-213 | `rebuildPath()` from the registry; returns `''` on mac | B | login-shell PATH once (`$SHELL -ilc`), Finder apps get only `/usr/bin:/bin` |
| ptyhost.cjs:312-327 | `PROMPT_RE = /PS [A-Za-z]:\\…> ?$/` | M | precmd marker (OSC) from our rc, process scan fallback |

## 2. Wrapper / claude launch (~200 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| ptyhost.cjs:117-180 | `CLAUDE_WRAPPER` PowerShell function, DPAPI decrypt inline, DRYRUN | B | zsh/sh `claude()` with the same arg logic |
| ptyhost.cjs:565 | `_wrapper` PS5.1 parser check | m | `zsh -n` |
| main/updater.cjs:8-12 | `~/.local/bin/claude.exe` | M | `~/.local/bin/claude`, PATH, `/opt/homebrew/bin/claude` |
| main/bgagents.cjs:38-46 | `claude agents --json` via updater | M | follows |
| ptyhost.cjs:344 | `Name -like 'claude*'` | M | `ps -o comm` |

## 3. Text the renderer types into the shell (~200 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| renderer/workspace/ui/shellcmd.js:7-9 | `psQuote` | B | POSIX `'…'` with `'\''` |
| shellcmd.js:26-33 | `setupPrefix` (`[scriptblock]::Create`, `$LASTEXITCODE`) | B | `( eval '<setup>' ) \|\| printf …` |
| shellcmd.js:55-69 | `crtQuote` | B | not needed |
| shellcmd.js:75-81 | `psString` | B | POSIX quote |
| shellcmd.js:88-137 | `realClaudeLine`, cloud send/teleport/login | B | `env -u CLAUDE_CODE_OAUTH_TOKEN … CLAUDE_CONFIG_DIR=… command claude …` |
| terms.js:1524-1534 | `claudeCommand` double quotes | m | single quotes (zsh expands `!`, `$`) |
| terms.js:559-561 | limit-switch prompt `plain()` | m | also strip `!` and `\` or single-quote |
| terms.js:1561-1586 | `/exit` + `waitClaudeExit` | M | depends on §1/§5 |
| terms.js:795, index.html:120-122 | "PowerShell" labels, setup placeholder | m | shell-neutral text |

## 4. Accounts / secrets (~150 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| main/accounts.cjs:50-63, 597-630, 793-816 | DPAPI via PowerShell `ProtectedData` | M | `security` CLI generic-password items |
| accounts.cjs:23-26, 45-47 | `<id>.dpapi` blobs | M | Keychain items, no blob |
| ptyhost.cjs:139, 163-170 | wrapper decrypts token blobs | M | wrapper reads the Keychain item, or main writes a per-tab 0600 file |
| accounts.cjs:230-248 | login = `.credentials.json` / `oauthAccount` | m | Keychain item `Claude Code-credentials`; `oauthAccount` fallback covers it |

## 5. Process management (~120 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| ptyhost.cjs:339-351 | `claudePidsUnder` via `Get-CimInstance` | M | `ps -A -o pid=,ppid=,pgid=,comm=` BFS |
| ptyhost.cjs:353-367, 437-496 | `taskkill /T /F`, sync killAll | M | ps snapshot → SIGTERM tree + `kill(-pgid)` → SIGKILL → then `pty.kill()` |
| main/gitfetch.cjs:32-50 | fetch timeout taskkill | M | `detached:true` + `process.kill(-pid)` |

## 6. App identity / taskbar / icons (~250 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| index.cjs:76-82 | `setAppUserModelId` | m | no-op; per-workspace userData stays |
| index.cjs:443-499 | `claimTaskbarIdentity`, `rebuildTaskbarButton` | M | `app.dock.setIcon(png)`; real pins = per-workspace `.app` clones (phase 2) |
| index.cjs:195-211, 311-314, 604 | `setOverlayIcon` badge | M | `app.dock.setBadge`, `dock.bounce` |
| index.cjs:435, 557, 776, 1784-1787; main/ico.cjs | `.ico` everywhere | M | PNG (and `.icns`) via sharp |
| main/shortcuts.cjs, assets/ps/set-shortcut.ps1 | `.lnk`, Start Menu; `sc:create` throws (no `APPDATA`) | M | guard; phase 2 clones |
| main/contextmenu.cjs, index.cjs:749-756 | registry "Open with VibeSpace" | M | hide; later Finder Quick Action / `open-file` |
| renderer/launcher/* | "taskbar", `D:\Repositories\MyProject` | m | "Dock", `~/Code/MyProject` |

## 7. Paths / sessions (~80 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| util.cjs:28-52 | munge + drive-letter fallback | – | portable |
| many `toLowerCase()` path compares | | m | fine on default APFS |
| renderer/workspace/ui/history.js:293 | `repoRoot + '\\' + rel` | M | `/` |
| app.js:397, 429 | backslash joins | M/m | `/` |
| terms.js:1309-1324 | file:line links only for drive letters | M | add `^/` branch |
| tabmenu.js:17 | `%USERPROFILE%` | m | `~` |

## 8. Hooks / feed: already portable (`echo`/`grep` command hooks, `curl` statusLine, HTTP hooks).

## 9. Presence / notifications / lifecycle (~40 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| main/presence.cjs | powerMonitor lock/idle | – | supported |
| index.cjs:297-307 | Notification with `.ico` | m | icon ignored on mac |
| index.cjs:1903-1913 | `session-end` (Windows only) | M | `before-quit` + `powerMonitor 'shutdown'` |
| index.cjs:99-107, 1887-1901 | darwin keeps a windowless workspace process alive holding the lock | M | workspace processes quit on `window-all-closed` on every platform |

## 10. Cloud (~100 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| main/cloud.cjs:15-60 | ready = `.credentials.json` / `oauthAccount` | m | Keychain `Claude Code-credentials-<sha8 of dir>` |
| assets/ps/cloud-send.ps1 | pwsh hidden console TTY | M | `cloud-send.sh` with `script -q /dev/null claude --cloud …` |

## 11. Git / worktrees: portable except the gitfetch tree kill; Xcode CLT `git` stub prompts when missing.

## 12. Packaging
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| package.json:16-17, 35-44 | `--win nsis` only, `app.ico` | M | `mac` block, dmg+zip arm64, `.icns`, explicit ad-hoc sign |
| node-pty prebuilds | darwin present, `spawn-helper` mode 0644 | M | chmod +x in postinstall + afterPack |
| node_modules/@img | only win32 sharp | M | install on the mac build (CI `npm ci`) |

## 13. Smoke (~300 lines): Windows paths, PowerShell runs (setupPrefix, realClaudeLine, wrapper dry-run, PS parser), DPAPI round-trips, `.lnk` test, PS prompt test, cmd.exe orphan test. Each needs a darwin twin or a skip.

## 14. UX / keys / fonts (~80 lines)
| file:line | what | sev | mac equivalent |
|---|---|---|---|
| finder.js:108, terms.js:627, search.js:41, board.js:372, app.js:156/161, viewer.js:88, cloud.js:180 | `ctrlKey \|\| metaKey` | m | Cmd only on darwin (Ctrl+P/F/B are readline keys) |
| terms.js:1234-1260 | Windows-Terminal Ctrl+C/V copy-paste | M | Cmd+C/Cmd+V; leave Ctrl+V to Claude (image paste) |
| inputsel.js:137-162 | Ctrl+Shift+←/→ word select | m | Option+Shift+←/→ |
| terms.js:444-451 | no `macOptionIsMeta` | m | set it |
| fonts in terms.js, diff.js, viewer.js, style.css | Cascadia/Consolas | m | add `"SF Mono", Menlo` |
| UI labels "Ctrl+", "Explorer" | | m | ⌘, "Finder" |
| index.cjs:427-437 | no app menu | m | mac app menu (Edit roles) |

Rough total: ~2,000 lines touched.

# Part 3: platform research (web sources)


Scope: the facts needed to port VibeSpace (Electron 44, launcher + one process per workspace,
node-pty + Claude Code agents) from Windows to macOS. Each section ends with a recommendation.
Confidence labels: **[verified]** = official docs, primary source, or checked locally;
**[secondary]** = third-party write-ups that agree with each other; **[spike]** = plausible but
needs a 30-minute test on a real Mac before we build on it.

Facts checked locally in this repo: `node-pty@1.1.0` (the version in package.json) ships
`prebuilds/darwin-arm64` and `prebuilds/darwin-x64` (thin Mach-O, N-API). The npm tarball
stores both `spawn-helper` files as **mode 0644** (not executable). The repo's
electron-builder is `^26.15.3`, the version that dropped the mac ad-hoc signing fallback
(see Q6).

---

### Q1. A separate Dock identity per workspace (separate tile, icon and pin)

#### How macOS decides Dock tiles
- One Dock tile per **running application process**. The tile's identity, name and icon
  come from the process's **main bundle**: the `.app` that holds the executable, its
  `Info.plist` (`CFBundleIdentifier`, `CFBundleName`, `CFBundleIconFile`). Every window of one
  process shares that one tile. There is no Windows-style "AppUserModelID per window" switch.
  io.Connect's FAQ says the same: "a single app icon represents all of that app's windows"
  ([interop.io FAQ](https://community.interop.io/t/faq-macos-dock-icon-for-windows/429)).
  [verified]
- Launching the same bundle again with `open -n` gives a second process and a second tile
  with the **same** icon ([Macworld](https://www.macworld.com/article/210780/opentwoinstancesofoneapp.html)).
  [secondary]
- "Keep in Dock" pins a **bundle path**, not a process. Pinning any instance of
  `VibeSpace.app` pins `VibeSpace.app`. A pin whose bundle was moved or deleted turns into a
  "?" ([GnuCash thread](https://lists.gnucash.org/pipermail/gnucash-user/2018-June/077591.html)).
  [verified]
- `app.dock.setIcon()` only changes the **running** process's tile. It does not touch the
  bundle on disk and reverts when the process quits, so a pinned tile that isn't running
  shows the bundle icon
  ([Granola write-up](https://www.granola.ai/blog/so-you-think-its-easy-to-change-an-app-icon),
  [electron-mac-dock-icon-switcher](https://github.com/davidcann/electron-mac-dock-icon-switcher)).
  An icon that persists for one bundle needs an `NSDockTilePlugIn` (native code, one per
  bundle). That doesn't help with many workspaces. [verified]

#### What other apps do
- **Chrome / Edge PWAs ("app shims")**: each installed PWA is a small generated `.app`
  (in a per-channel folder named `Chrome Apps.localized`, inside the user's Applications
  folder) with its **own bundle id**. Its loader `dlopen`s the main browser's framework, and
  the shim **process** hosts the app's windows through RemoteCocoa. That's why each PWA gets
  its own tile, its own pin and its own Cmd+Tab entry
  ([Chromium app_shim README](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/app_shim/README.md),
  [web_app_mac.mm](https://chromium.googlesource.com/chromium/src/+/5eed857e/chrome/browser/web_applications/web_app_mac.mm)).
  Since Chrome/Edge 132 the shims are **ad-hoc code-signed on the user's machine** "so each
  installed application has a unique identity to macOS system components"
  ([Edge policy AdHocCodeSigningForPWAsEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/adhoccodesigningforpwasenabled),
  [Chromium M132 fix](https://chromium.googlesource.com/chromium/src/+/e660f5610cf324520b9db9ce86259424df1f15fb%5E%21/)).
  [verified] This is exactly our pattern: a big, properly signed main app, plus small bundles
  generated on the user's machine, each with its own identity.
- **Duplex** (open source, runs several instances of Electron apps such as Claude/Codex):
  APFS copy-on-write **clone of the whole target .app** (about 2 s, about 6 MB of real disk
  for an 834 MB app), new `CFBundleIdentifier` + name + icon in the clone's `Info.plist`,
  launcher passes `--user-data-dir`, **main binary + helper apps re-signed ad-hoc**, large
  frameworks keep the vendor signature, clone rebuilt when the target's version changes.
  Known costs: the clone loses the original Keychain entry (they run with
  `--use-mock-keychain`), and re-signing can re-trigger TCC prompts
  ([github.com/bnimit/duplex](https://github.com/bnimit/duplex)). [verified]
- **Parall** (Mac App Store): generated shortcut `.app`s that launch the original app
  without copying or re-signing it. Each gets its own Dock name and icon. Known flaw:
  "clicking a notification can bring a different running instance to the front", because
  the real process is still the original bundle
  ([parall.app](https://parall.app), [MPU thread](https://talk.macpowerusers.com/t/parall-run-the-same-mac-app-separately-with-its-own-data-and-dock-icon/45561)).
  [secondary]
- **Wavebox**: one tile by default, profiles can show as separate Dock items (it is
  Chromium-based) ([Wavebox hub](https://hub.wavebox.io/wavebox-macos-icon/)).
  **Rambox / Ferdium / Station**: one tile, with an in-app sidebar and a Dock badge.
  **Nativefier**: built a complete separate Electron app per site (about 200 MB each, no
  sharing). [secondary]

#### Options for VibeSpace
| Option | Separate tile | Own icon when not running | Separate pin | Notes |
|---|---|---|---|---|
| A. `open -n` main bundle + `app.dock.setIcon` | yes | no | **no** (pins VibeSpace.app) | zero risk; good for dev builds |
| B. Shim with a launcher script that `exec`s the main binary | unclear | yes | yes | the process's main bundle becomes VibeSpace.app again → name, notifications and Cmd+Tab are attributed to the main app (Parall's notification bug) **[spike]** |
| C. **APFS clone of VibeSpace.app per workspace** (Duplex / Chrome pattern) | yes | yes | **yes** | own bundle id → own Notification Center entry and badge; needs ad-hoc re-sign and a rebuild after each VibeSpace update |
| D. Shim with symlinks to the main app's `Frameworks`/`Resources` | yes | yes | yes | `codesign` refuses symlinks that point outside the bundle (`errSecCSInvalidSymlink`, [Apple forums](https://developer.apple.com/forums/thread/114223)); unsigned it would run but has no stable identity |
| E. `LSUIElement` tricks | no | – | – | hides the tile; useful only for a tray-style launcher |

#### Signing, Gatekeeper and quarantine for generated bundles
- Gatekeeper assesses **quarantined** files. Bundles our own process writes locally are not
  quarantined (unless `LSFileQuarantineEnabled`), so an ad-hoc-signed clone in
  `~/Applications` launches without a dialog. This is how Chrome's shims work. [verified by
  analogy with Chrome/Duplex]
- **But**: `clonefile`/`cp -c` copies xattrs. If VibeSpace.app itself still carries
  `com.apple.quarantine` (downloaded and approved by the user), strip it from the clone
  (`xattr -dr com.apple.quarantine <clone>`). [spike]
- Apple Silicon requires every executable to have at least an ad-hoc signature. Editing a
  signed bundle's `Info.plist` breaks its seal, so re-sign the clone ad-hoc (`codesign
  --force --deep --sign - <clone>`, or sign the helpers and then the main executable).
  `/usr/bin/codesign` ships with macOS, no Xcode needed. Sign **without** hardened runtime:
  library validation would refuse to load the Team-ID-signed Electron Framework into an
  ad-hoc process (Chromium's signing README notes that a self-signed identity is
  incompatible with library validation:
  [Chromium signing README](https://chromium.googlesource.com/chromium/src/+/798e59c5275d4131797e8ea2e96e6c6000256b58/chrome/installer/mac/signing/README.md)).
- An ad-hoc identity changes with each re-sign → TCC grants (Documents/Desktop folder
  access, Accessibility, Screen Recording) can be asked again per workspace and after each
  rebuild. **Repos under ~/Documents or ~/Desktop will show a "VibeSpace – <repo> would like
  to access files in your Documents folder" prompt once per workspace bundle.** Keep the
  rebuilds rare (only on a version change).
- App Translocation: a quarantined app run from `~/Downloads` runs from a random read-only
  path. Generate clones only when `app.isInApplicationsFolder()` is true, and offer
  `app.moveToApplicationsFolder()`.

#### Icons
- `iconutil` and `sips` are part of stock macOS (no Xcode)
  ([codingforentrepreneurs](https://www.codingforentrepreneurs.com/blog/create-icns-icons-for-macos-apps)).
  [secondary]
- Easier and testable on Windows: **write the ICNS in JS**. The format is just
  `'icns'` + BE uint32 total length, then entries of `OSType(4) + BE uint32 length(incl. 8) +
  PNG bytes`. PNG entry types: `ic07` 128, `ic08` 256, `ic09` 512, `ic10` 1024 (512@2x),
  `ic11` 32 (16@2x), `ic12` 64 (32@2x), `ic13` 256 (128@2x), `ic14` 512 (256@2x). We already
  have sharp, so this is about 30 lines (or use `png2icons` / `icon-gen`).
- **macOS 26 Tahoe "squircle jail"**: a bundle icon that isn't the rounded-square shape gets
  shrunk about 20% onto a gray plate
  ([9to5mac](https://9to5mac.com/2025/08/08/macos-tahoe-fix-gray-box-icons/),
  [heise](https://heise.de/-11075561), [Michael Tsai](https://mjtsai.com/blog/2025/11/11/tahoes-terrible-icons/)).
  So render repo logos **into** Apple's template (on a 1024 canvas: a rounded rect of about
  824 px, about 100 px transparent margin, our own background colour) before encoding.
  Otherwise every workspace icon looks like a gray box. [secondary]
- Dock icon caching (the counterpart of our Windows 0.6.41 lesson): use a **new `.icns`
  filename per logo version** (update `CFBundleIconFile`), `touch` the bundle, re-register
  with `lsregister -f <bundle>` (`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister`).
  A running workspace can also refresh its tile at once with `app.dock.setIcon`. Whether a
  pinned, non-running tile refreshes without `killall Dock` is **[spike]**.

#### Recommendation (Q1)
**Option C, the Chrome/Duplex pattern.** Per workspace, generate
`~/Applications/VibeSpace Workspaces/<Name>.app` as an APFS clone (`cp -c -R`, falling back to
a full copy across volumes) of the installed VibeSpace.app. Then:
- `Info.plist`: `CFBundleIdentifier = app.vibespace.ws.<id>`, `CFBundleName` /
  `CFBundleDisplayName = <repo name>`, `CFBundleIconFile = <id>.v<stamp>.icns`, plus a custom
  key such as `VSWorkspaceId = <id>`. Main reads it from `<exe>/../../Info.plist` at startup,
  so a click on a pinned tile with no args still knows its workspace. Keep
  `CFBundleExecutable` unchanged, or Electron won't find its `… Helper.app`s.
- Strip quarantine, then re-sign ad-hoc without hardened runtime.
- Stamp the clone with the VibeSpace version. The launcher rebuilds clones on a version
  change at the **same path**, while that workspace isn't running: build next to it, swap,
  so pins survive.
- Launch workspaces with `open "<clone>.app"`, so LaunchServices attributes the process to
  the clone and focuses an already running one, instead of spawning a duplicate.

The bundle path and bundle id are load-bearing, exactly like the Windows AUMID rule: never
rename or move them on a repo rename, change only `CFBundleName`. For unpackaged dev runs,
use option A. Spike first: (1) the clone gets its own tile, name, notification identity and
pin; (2) re-signing works with our Developer-ID or ad-hoc main app; (3) the icon refreshes.
Estimated spike: about 2 h on a Mac.

---

### Q2. node-pty on macOS with Electron 44

- **Prebuilds** [verified locally]: `node-pty@1.1.0` ships `prebuilds/darwin-arm64/{pty.node,spawn-helper}`
  and `darwin-x64/…`, thin per-arch Mach-O files built with `node-addon-api` (N-API → ABI-stable
  across Electron versions). Its install script is `node scripts/prebuild.js || node-gyp rebuild`,
  so **no electron-rebuild and no Xcode** are needed when the prebuild exists. The README says
  Xcode is needed only to compile from source ([microsoft/node-pty](https://github.com/microsoft/node-pty)).
  Keep `npmRebuild: false`.
- **spawn-helper permission bug** [verified locally]: in the 1.1.0 tarball both
  `prebuilds/darwin-*/spawn-helper` files are `-rw-r--r--`. Without `+x`, every spawn fails with
  the opaque `posix_spawnp failed.` (node-pty issue #850; workaround scripts in
  [PilotDeck fix-node-pty.js](https://gitcode.com/OpenBMB/PilotDeck/blob/main/ui/scripts/fix-node-pty.js),
  [OpenCode fix-node-pty.ts](https://upd.dev/anomalyco/opencode/raw/branch/dev/packages/core/script/fix-node-pty.ts);
  same symptom in [vscode#213748](https://github.com/microsoft/vscode/issues/213748)).
  node-pty itself rewrites `app.asar` → `app.asar.unpacked` for the helper path
  (`lib/unixTerminal.js`), and our `asarUnpack: ["**/node-pty/**"]` already covers it. **Fix:**
  `chmod 755` the helper in a postinstall **and** in an electron-builder `afterPack` hook (the
  packaged copy keeps the source mode), and check it in the packaged smoke.
- Universal builds: both arch folders sit in the package, so the x64 and arm64 app copies have
  identical files and `@electron/universal` merges them without lipo. Simpler: ship arm64 only
  (see Q6).
- **sharp**: needs `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64` (optional deps).
  An `npm ci` on Windows won't fetch them, so build on a Mac runner, or use
  `npm install --os=darwin --cpu=arm64`.
- **Login shell / PATH**: a Finder- or Dock-launched app inherits launchd's minimal PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`). It is missing `~/.local/bin` (claude), `/opt/homebrew/bin`,
  nvm and so on. Two separate fixes:
  1. **Main process** (our own spawns of git, `claude agents --json`, curl…): resolve the user's
     env once at startup with `shell-env` (runs the login shell, falls back to `/bin/zsh`, disables
     oh-my-zsh tmux autostart) or `fix-path` for PATH only
     ([shell-env](https://www.npmjs.com/package/shell-env), [fix-path](https://npmjs.com/package/fix-path)).
     Add a timeout (a broken .zshrc can hang it), cache the result, and also probe absolute
     candidates for `claude` (`~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`).
  2. **The pty**: spawn `$SHELL` (default `/bin/zsh`) as a **login** shell (`-l`), like Terminal.app.
     Then `/etc/zprofile` (`path_helper`), `~/.zprofile` (brew shellenv) and `~/.zshrc` set PATH
     themselves.
  - macOS env is **case-sensitive**: `withSinglePath`/`readPath` must become platform-aware
    (`PATH` only on darwin).
  - Note: `/usr/bin/git` is an Xcode Command Line Tools stub that pops an "install developer
    tools" dialog when CLT is missing. Detect it (`xcode-select -p`) before the git sidebar polls.
- **Injecting the `claude` wrapper function** (replaces `-EncodedCommand`): use the VS Code
  shell-integration trick. Set `ZDOTDIR` to our own dir, whose `.zshenv/.zprofile/.zshrc` source
  the user's originals (from the real `$ZDOTDIR` or `$HOME`) and then define `claude()`. For bash,
  use `--rcfile`. This keeps the user's rc files and adds our function without typing anything
  into the prompt. [standard technique; spike]
- **Killing a process tree**: node-pty's `kill()` only does `process.kill(this.pid, 'SIGHUP')`
  [verified locally, `lib/unixTerminal.js`]. The pty child is a session and process-group leader
  (forkpty/setsid), so `process.kill(-pid, sig)` reaches everything still in that group. Children
  that `setsid`/`detached` (some MCP servers, claude's daemon/bg jobs) escape it. macOS has no
  `PR_SET_PDEATHSIG`, and orphans are re-parented to launchd (PPID 1), so **the same "walk
  before close" race as with taskkill exists**
  ([claude-code orphan report](https://claudeissues.com/issue/33947-bug-mcp-server-and-subagent-processes-not-cleaned-up-on-session-end-orphan-accum)).
  `tree-kill` forks one `pgrep -P` per descendant and can storm or throw mid-walk
  ([claude-code tree-kill storm](https://claudeissues.com/issue/52253-bug-tree-kill-dependency-causes-pgrep-storm-100-cpu-when-reaping-bash-subprocess)).
  Zed fixed its version of this with `killpg`
  ([Zed patch](https://git.secluded.site/zed/commit/01b716cf12199c82b480e5f2a7afb12128d273a4.patch)).

#### Recommendation (Q2)
- Keep node-pty 1.1.0 prebuilds, and chmod `spawn-helper` in postinstall + afterPack.
- Spawn `$SHELL -l` with a ZDOTDIR wrapper.
- Run `shell-env` (with a timeout) in main.
- Tree kill: **one** `ps -A -o pid=,ppid=,pgid=` snapshot → collect descendants of the shell pid
  plus its pgid → SIGTERM all of them + `kill(-pgid)` → after 1.5 s, SIGKILL the survivors →
  only then `pty.kill()`.
- On quit: the same, synchronously, with `ps` via `spawnSync`.
- Never kill claude's daemon or bg-pty-host jobs (use `claude stop`, same rule as today).

---

### Q3. Claude Code on macOS

- **Binary locations** [verified, [setup docs](https://code.claude.com/docs/en/setup)]:
  - Native installer: the launcher `~/.local/bin/claude` is a **symlink into
    `~/.local/share/claude/versions/<v>`** (auto-updates; macOS binaries signed by Anthropic PBC
    and notarized).
  - Homebrew: `brew install --cask claude-code` (stable, about a week behind) or
    `claude-code@latest`. No auto-update unless `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1`.
    Lives under `/opt/homebrew/bin/claude`.
  - npm: `@anthropic-ai/claude-code` installs the same native binary via
    `@anthropic-ai/claude-code-darwin-arm64`.
  - Requires macOS 13+.
  - Our "new Claude version" detector should read the symlink target (`versions/<v>`) instead of
    the Windows exe.
- **Credentials** [verified, [authentication docs](https://code.claude.com/docs/en/authentication)]:
  "On macOS, credentials are stored in the encrypted macOS Keychain". **`~/.claude/.credentials.json`
  normally does not exist on a Mac.** It is only written (0600) when the Keychain rejects the
  write, e.g. locked in SSH.
  - Item: generic password, service **`Claude Code-credentials`**, account = `$USER`, created via
    `/usr/bin/security add-generic-password` with the default ACL. So any user process can read it
    with `security find-generic-password -s "Claude Code-credentials" -a "$USER" -w`
    ([Silverfort](https://www.silverfort.com/blog/skipping-the-lock-a-claude-code-cli-weakness-lets-any-macos-process-read-stored-credentials/)).
    Anthropic said it is "tracking a tightening" of that ACL, so don't depend on reading it.
  - **Impact on VibeSpace**: the "login available" check (`.credentials.json` exists) and the
    cloud-dir "ready" check must change on darwin. Test for the Keychain item's **existence**
    without `-w` (no secret read), or `oauthAccount` in `~/.claude.json`.
- **CLAUDE_CONFIG_DIR and the Keychain** [verified]: the official docs now say Claude Code "keys
  the macOS Keychain entry to that directory too, so a session with a different
  `CLAUDE_CONFIG_DIR` reads a different entry", and the docs recommend one config dir per
  account for multiple logins.
  - The service name is **`Claude Code-credentials-<first 8 hex of SHA-256(absolute config dir path)>`**
    ([ai-usagebar keychain.rs](https://docs.rs/crate/ai-usagebar/0.21.0/source/src/anthropic/keychain.rs)).
  - Dir-scoped entries arrived around **2.1.144**; older builds shared one entry
    ([claude-account](https://github.com/hamzarehmandeveloper/claude-account); the older bug report
    "CLAUDE_CONFIG_DIR does not isolate macOS Keychain credentials" was resolved).
  - Our cloud-only config dirs (`<dataRoot>/cloud/<accountId>`) therefore work on mac exactly as
    designed. Exact hashing input (trailing slash, symlinks, NFC) is **[spike]**: always pass the
    same canonical absolute path.
- **setup-token / `CLAUDE_CODE_OAUTH_TOKEN`** [verified]: identical on mac. It prints a one-year
  token and saves nothing. Precedence: cloud provider > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`
  > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > profiles > `/login`. Still model requests only
  (no Remote Control, no claude.ai connectors). `--bare` ignores it.
- **Transcript dir munging** [secondary, matches our Windows rule]: every non-alphanumeric char
  → `-`, so `/Users/foo/My_Repo` → `-Users-foo-My-Repo`. Non-ASCII characters become `-` each, and
  it's lossy/colliding
  ([underscores](https://claudeissues.com/issue/39528-bug-bug-report-project-directory-key-converts-underscores-to-hyphens-causing-amb),
  [Cyrillic](https://claudeissues.com/issue/45718-project-path-encoding-breaks-with-non-ascii-cyrillic-directory-names),
  [ENAMETOOLONG](https://claudeissues.com/issue/59726-bug-enametoolong-creating-claude-projects-when-cwd-is-long-ecryptfs-name-max-143)).
  - **mac gotcha (the analogue of the drive-letter bug #90588)**: APFS is case-insensitive, so
    `cd /users/foo/repo` works and claude records a differently-cased cwd and munged dir. Also
    `/tmp` → `/private/tmp`, `/var` → `/private/var`. Always canonicalize the tab cwd (real
    on-disk case, physical path) before spawning claude. [spike: check that
    `fs.realpathSync.native` restores on-disk case on APFS]
- **statusLine / hooks**: platform-neutral JSON over stdin/HTTP.
  - Our `type:'http'` hooks and the curl statusLine work unchanged (`/usr/bin/curl` ships with
    macOS).
  - The Git Bash command-hook fallback becomes plain `/bin/sh`.
  - Claude's own desktop notifications fire by default only in Ghostty/Kitty/iTerm2, and Option
    shortcuts (Option+Enter newline, Option+P) need Option-as-Meta
    ([terminal config](https://code.claude.com/docs/en/terminal-config)).
- **`--cloud` / `--teleport`**: same CLI. They still need an interactive TTY. On mac we don't need
  the hidden-console trick: run it in a hidden node-pty from main, or `script -q /dev/null claude
  --cloud …` (BSD `script` allocates a pty). The trust-dialog pre-accept in the cloud dir's
  `.claude.json` is still needed.

#### Recommendation (Q3)
Resolve `claude` by PATH from the login shell, falling back to `~/.local/bin/claude`. Replace
every `.credentials.json` existence test with a Keychain existence test on darwin (service
`Claude Code-credentials` or `…-<sha8>` for a config dir). Canonicalize cwd case. Keep the token
model as-is.

---

### Q4. Secrets: replacing DPAPI

- **Electron `safeStorage` on mac**: the key lives in the Keychain ("<App> Safe Storage") with
  an ACL bound to the creating app's code signature. Access "can block the current thread to
  collect user input". An app without a stable signature may "re-prompt the user for permission
  on every update" ([safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage)).
  With per-workspace **ad-hoc clones (Q1)**, every clone is a different code identity, so each
  would prompt, and prompt again after every rebuild. Duplex hit this and runs clones with
  `--use-mock-keychain`. A shell in the pty also can't call safeStorage. [verified + inferred]
- **`security` CLI**: `security add-generic-password -U -s vibespace.account.<id> -a vibespace
  -w <token>` (default ACL trusts `/usr/bin/security`, the creating tool), read back with
  `security find-generic-password -s … -a … -w`.
  - Any process of the user can read it without a prompt. That is the **same model as DPAPI
    (CurrentUser) and as Claude Code's own credential item** (Silverfort article above), and it
    works identically from main, from every clone and from a zsh function in the pty.
  - Caveats: the Keychain can be locked (SSH sessions). Passing the secret with `-w` on the
    command line exposes it to `ps` for a moment, so write via stdin (`-w` as the last arg with no
    value prompts on the tty; or use the `security -i` interactive mode via stdin). Reads are fine.

#### Recommendation (Q4)
**Use the `security` CLI with generic-password items, one per account**
(service `VibeSpace-account-<id>`, account `$USER`):
- Main reads them (one spawn per account, cached), mirroring today's `accounts.endpointEnv`.
- The zsh `claude()` wrapper may read the token itself (`security find-generic-password … -w`),
  mirroring today's DPAPI wrapper. On mac there's no Defender-style command-line heuristic to
  dodge, but keeping decryption in main and passing env per call is still the cleaner design.
- Endpoint env blobs: the same, as a second item or one item holding the `KEY=VALUE` text.
- Don't use safeStorage while workspaces run from ad-hoc clones.

---

### Q5. Idle, screen lock, notifications, badges

- `powerMonitor.getSystemIdleTime()` and `getSystemIdleState(threshold)` (`active|idle|locked|unknown`)
  work on macOS, and **`lock-screen` / `unlock-screen` are emitted on macOS and Windows**
  ([powerMonitor](https://electronjs.org/docs/latest/api/power-monitor)). macOS also has
  `user-did-become-active`/`user-did-resign-active` (fast user switching). Keep our rule
  "locked = infinite idle". `getSystemIdleState` returns `locked` on mac, which is more reliable
  than the Windows idle reading. [verified]
- **Notifications**: Electron on mac uses UNNotification, which "requires an application to be
  code-signed in order for notifications to appear". Unsigned binaries emit `failed`, and
  `getHistory()` is empty in unsigned dev builds
  ([Notification API](https://www.electronjs.org/docs/latest/api/notification),
  [tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)).
  - Ad-hoc should be enough: Chrome ad-hoc-signs PWA shims precisely to give them a unique
    identity. **[spike]**
  - First use shows the system permission prompt, **once per bundle id**, so once per workspace
    clone.
  - Notification Center groups and shows them per bundle (repo name + repo icon), the mac
    counterpart of our per-AUMID toasts.
- **Badge**: `app.dock.setBadge('3')` (any short string) or `app.setBadgeCount(n)`. On macOS
  setBadgeCount needs notification permission
  ([app API](https://www.electronjs.org/docs/latest/api/app)). This replaces `setOverlayIcon`.
  With per-workspace clones each workspace's own tile carries its badge, which is better than
  Windows. Attention: `app.dock.bounce('informational'|'critical')` replaces `flashFrame`.
- Presence: Claude's own `CLAUDE_CLIENT_PRESENCE_FILE` mechanism is file-based → unchanged.

#### Recommendation (Q5)
Map `setOverlayIcon` → `app.dock.setBadge`, flashFrame → `dock.bounce('informational')`. Keep
toasts on Electron `Notification` (needs a signed or ad-hoc-signed bundle). Use `lock-screen` +
`getSystemIdleState` for presence.

---

### Q6. Packaging, distribution and CI

- **electron-builder mac** ([docs](https://www.electron.build/docs/mac)): targets `dmg`, `zip`,
  `pkg`, `dir`… (default dmg+zip, both needed for auto-update). Arch `arm64`, `x64` or
  `universal` (merged; `mergeASARs`). Hardened runtime defaults to on and is required for
  notarization. Notarize via `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`
  (recommended) or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. Default entitlement
  is `allow-jit`; from v27 `disable-library-validation` is no longer default. `extendInfo` for
  extra `Info.plist` keys.
- **Our version trap** [verified]: **electron-builder 26.15.3 (ours) removed the ad-hoc
  fallback**. With no certificate the `.app` ships with only the bare linker signature (no sealed
  resources), and TCC grants never stick (Accessibility kept re-asking in openscreen;
  [openscreen PR #257](https://github.com/getopenscreen/openscreen/pull/257)). Docs:
  `identity: "-"` = ad-hoc, `identity: null` = unsigned. Their fix is to ad-hoc sign explicitly
  in CI and verify that the signing identifier equals `CFBundleIdentifier`.
- **Electron 44 requires macOS 13 Ventura+** (macOS 12 removed)
  ([v44.0.0 release](https://releases.electronjs.org/release/v44.0.0),
  [breaking changes](https://electronjs.org/docs/latest/breaking-changes)). macOS 26 Tahoe is
  Apple's last Intel release, so arm64-only is reasonable.
- **Without an Apple Developer account** (ad-hoc or unsigned):
  - An unsigned arm64 binary won't run at all.
  - An ad-hoc-signed app downloaded from the web gets quarantine → "Apple could not verify…" or
    "**is damaged and can't be opened**"
    ([electron-builder #5850](https://github.com/electron-userland/electron-builder/issues/5850),
    [cloudhouse](https://cloudhousetechnologies.com/blog/how-to-fix-app-is-damaged-cant-be-opened-mac-2026)).
  - **Since Sequoia (15) the Control-click → Open bypass is gone**: the user must try once, then
    System Settings → Privacy & Security → **Open Anyway**, or run
    `xattr -dr com.apple.quarantine /Applications/VibeSpace.app`
    ([Macworld](https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html),
    [troz.net](https://troz.net/post/2024/sequoia_app_permissions/)).
  - Homebrew planned to stop supporting casks that fail Gatekeeper from 2026-09-01 (removing
    `--no-quarantine`), so an unsigned Homebrew cask is not a way out
    ([discussion](https://feedbagel.com/post/homebrew-to-remove-no-quarantine-flag-support-for-macos-security-compliance)).
    [secondary]
- **With an account**: Apple Developer Program **$99/year** → Developer ID Application
  certificate (`CSC_LINK` base64 p12 + `CSC_KEY_PASSWORD` in CI) + App Store Connect API key for
  `notarytool`. Notarization takes minutes per build, then it is stapled. Downloads open with
  the normal "downloaded from the internet" dialog only. The per-workspace clones stay ad-hoc on
  the user's machine either way (like Chrome).
- **GitHub Actions**:
  - **macos-14 is retired 2026-11-02** (brownouts in October). Use **`macos-15`** or
    **`macos-latest` (= macos-26, arm64)**
    ([GitHub changelog](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement)).
  - Standard arm64 runner: 3 vCPU / 7 GB
    ([M1 runner announcement](https://github.blog/changelog/2024-01-30-github-actions-introducing-the-new-m1-macos-runner-available-to-open-source/)).
  - Free for public repos (enerage/vibespace is public).
  - **A GUI session exists**: hosted macOS runners are interactive (Aqua) sessions. XCUITest
    runs without display setup
    ([simplified.guide](https://www.simplified.guide/xcuitest/ci-run-github-actions)), and
    Electron + Playwright `_electron.launch()` opens real windows on `macos-latest` with no Xvfb
    ([Simon Willison TIL](https://til.simonwillison.net/electron/testing-electron-playwright),
    [Playwright action](https://github.com/marketplace/actions/run-playwright-tests)).
    [secondary but consistent]
  - Caveats: system TCC prompts can't be clicked on runners (e.g. "bash requesting screen
    access" on macOS 15 images: [Apple forums](https://developer.apple.com/forums/thread/806451)),
    and `screencapture` can come back black without a Screen Recording grant
    ([testcafe#6789](https://github.com/DevExpress/testcafe/issues/6789)). So take screenshots
    with **`webContents.capturePage()`** (no TCC) and avoid features that trigger TCC in smoke.
  - **node-pty → zsh on the runner**: `/bin/zsh` exists on every macOS image, and forkpty needs
    no GUI. It works once spawn-helper is `+x`. node-pty and VS Code run their unix terminal tests
    on macOS CI. Our smoke's "stripped PATH / nested ConPTY" problems don't exist there.
    [high confidence; spike = first CI run]

#### Recommendation (Q6)
- Phase 1, no account: build `arm64` dmg+zip on `macos-15`.
- Ad-hoc sign explicitly (`identity: "-"` or an explicit `codesign --force --deep -s -` step,
  because 26.15.3 won't do it), and verify with `codesign -dv` (identifier == bundle id).
- Run `VibeSpace.app/Contents/MacOS/VibeSpace --smoke` headed on the runner, with
  `capturePage` screenshots as artifacts.
- Document "Open Anyway" / `xattr -dr` for testers.
- Phase 2, before handing it to anyone non-technical: $99 Developer ID + notarization in the
  same workflow.

---

### Q7. Keyboard and UX conventions

- **Cmd vs Ctrl**: on mac, Ctrl+C/D/Z/L/R go to the pty unchanged (SIGINT etc.). App shortcuts
  move to **Cmd**:
  - Cmd+C copy, Cmd+V paste, Cmd+K clear, Cmd+F search, Cmd+P finder, Cmd+Shift+B/U/D
    for board, attention and diagnostics.
  - Copy-vs-SIGINT is no longer a conflict.
  - xterm.js doesn't send Cmd combos to the pty. Wire Cmd+C/V through the Edit menu roles or
    `attachCustomKeyEventHandler`.
- **Option key**: `macOptionIsMeta: true` makes Option send ESC-prefixed keys. Claude's Option
  shortcuts (Option+Enter newline, Option+P model) need it, per Claude's docs (VS Code's
  `terminal.integrated.macOptionIsMeta`). The cost: Option can't type special characters (`@`,
  `€`, `|` on many non-US layouts!). Make it a setting, default on for US layouts.
  `macOptionClickForcesSelection: true` gives Option+drag an xterm selection even while Claude
  has mouse tracking on (the counterpart of Shift+drag). `rightClickSelectsWord` is mac-native
  behaviour ([ITerminalOptions](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)).
- **App menu is mandatory in practice**:
  - `autoHideMenuBar` does nothing on mac.
  - Cmd+C/V/X/A/Z in inputs and Monaco only work through an **Edit menu with role items**.
    Never call `Menu.setApplicationMenu(null)` on darwin.
  - Build a menu with `appMenu`, `editMenu`, `windowMenu` roles + our commands, so the
    accelerators also show up in the menu.
- **window-all-closed**: default = quit ([app API](https://www.electronjs.org/docs/latest/api/app)).
  The mac convention is to stay in the Dock, but a per-workspace process is "one document = one
  app", so quitting on last-window-close is fine (and keeps the pty lifecycle simple).
  - Handle `activate` (Dock click while there are no windows) for the launcher.
  - Cmd+Q = `before-quit`: reuse the busy-agent confirm.
- **Title bar**: `titleBarStyle: 'hiddenInset'` (+ `trafficLightPosition`). Leave about 72-80 px
  of left padding in our top bar, and mark drag regions with `-webkit-app-region: drag`
  (buttons `no-drag`).
- **Fonts**: Menlo is guaranteed. SF Mono is bundled inside Terminal.app and is **not**
  installed system-wide by default, so use a stack like `"SF Mono", Menlo, Monaco, monospace`.
  Keep the unicode11 addon. Re-check whether disabling GPU acceleration is needed on mac (it was
  a Windows remote-display fix, so make it Windows-only).

---

### Q8. Other common Windows → mac traps (and VibeSpace-specific ones)

- **Case-insensitive but case-preserving APFS** (default; case-sensitive volumes exist):
  - Compare paths after canonicalizing (realpath).
  - `U.jailed` checks must not assume case-sensitivity.
  - Claude cwd case matters (Q3).
  - `/tmp` and `/var` are symlinks to `/private/...`.
- **fs.watch recursive**: supported on macOS (FSEvents). Events are coalesced, and renames
  arrive as `rename` with ambiguous direction. `devwatch.cjs` works as-is. Non-recursive watches
  on single files use kqueue fds, and GUI apps have a low default `maxfiles` soft limit, so
  prefer directory watches ([Node fs.watch](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)).
- **`start` → `open`**: use `shell.openPath` / `shell.openExternal` / `shell.showItemInFolder`
  everywhere. Remove every `powershell.exe`, `taskkill`, `Get-StartApps`, `setAppUserModelId`,
  registry and `.lnk` path behind `process.platform` checks.
  - Files: `accounts.cjs`, `ptyhost.cjs`, `gitfetch.cjs`, `index.cjs` (AUMID, overlay icon),
    `assets/ps/*.ps1` (set-shortcut, cloud-send).
  - Also `shellcmd.js`: all the PowerShell quoting logic needs a zsh twin (single-quote escaping
    `'\''`).
- **`app.setAsDefaultProtocolClient`**: only for schemes declared in `Info.plist`
  `CFBundleURLTypes` (`extendInfo`). URLs arrive via the `open-url` event (register it before
  `ready`), not argv ([app API](https://www.electronjs.org/docs/latest/api/app)).
- **Single instance**: `requestSingleInstanceLock` works (lock in userData), and macOS
  additionally "enforces single instance automatically when users try to open a second instance
  of your app in Finder" → `open-file`/`open-url`/`activate` instead of a second process. Our
  "Focus that workspace" should become `open -b app.vibespace.ws.<id>` (or `open <clone path>`),
  which focuses the running process. No duplicate process, so the 0.6.19 whenReady-guard bug
  can't happen there.
- **Env**: case-sensitive (`PATH`). `HOME` instead of `USERPROFILE`. Use
  `app.getPath('appData')` = `~/Library/Application Support`.
- **Claude Code `CLAUDE_CODE_CHILD_SESSION` and similar inherited env**: same as Windows, clear
  `CLAUDE*` env for test instances.
- **Defender heuristics** don't exist on mac, but **TCC prompts** do: Documents, Desktop,
  Downloads, removable volumes, network volumes, plus Automation if we ever use AppleScript.
  Each is per bundle identity → per workspace clone (Q1).
- **Remote-control / UltraViewer splitter lessons**: the pointer-capture rule still holds (keep
  the window-capture listeners). There's no ConPTY reflow storm on mac, but keep the refit
  throttle.

---

## Bottom line
1. Per-repo Dock tiles + pins are **possible only with one generated bundle per workspace**.
   APFS-clone VibeSpace.app, give each clone its own bundle id + icns, ad-hoc re-sign. This is
   what Chrome PWAs and Duplex do. `dock.setIcon` alone can't be pinned.
2. node-pty 1.1.0 works without a rebuild, **after `chmod +x spawn-helper`**. Use a login zsh +
   shell-env for PATH, and kill trees with a single `ps` snapshot + process-group kill before
   closing the pty.
3. Claude on mac keeps its login in the **Keychain, not `.credentials.json`**.
   `CLAUDE_CONFIG_DIR` gets its own Keychain entry (`…-credentials-<sha8>`), so the
   token-per-call and cloud-dir designs carry over. The "login exists" checks must change.
4. Secrets: the `security` CLI generic-password items (same trust model as DPAPI and as Claude's
   own item). Not safeStorage, which breaks with per-workspace ad-hoc identities.
5. CI: macos-15 / macos-26 arm64 runners have a GUI session, so a headed `--smoke` is realistic
   (screenshots via `capturePage`). Our electron-builder 26.15.3 must be told to ad-hoc sign.
   Real distribution needs the $99/yr Developer ID + notarization.
