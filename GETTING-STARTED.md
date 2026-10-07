# Getting started with VibeSpace

VibeSpace gives every project its own window with a file tree, a code viewer and
several Claude Code agents side by side. Agents keep their conversations when
you restart. It runs on **Windows 10/11** and takes about 10 minutes to set up.

You need **one** of these:
- a **Claude** subscription (Pro or Max), or
- a **z.ai GLM Coding Plan** (an API key from z.ai).

## 1. Install Git for Windows

Claude Code uses Git's Bash on Windows. Download it from
<https://git-scm.com/download/win> and install with the default options.

## 2. Install Claude Code

Open **PowerShell** and run:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Close PowerShell, open a new one, and check that it worked:

```powershell
claude --version
```

- **Using z.ai only?** Stop here. Don't log in; VibeSpace will give Claude Code
  your z.ai key.
- **Using a Claude subscription?** Run `claude` once, log in in the browser,
  then type `/exit`.

## 3. Install VibeSpace

1. Download `VibeSpace Setup <version>.exe` from the
   [Releases page](https://github.com/enerage/vibespace/releases/latest).
2. Run it. Windows may say "Windows protected your PC" because the installer
   isn't signed. Click **More info → Run anyway**.
3. Start **VibeSpace Launcher** from the Start menu.

## 4. Open your project

In the launcher, click **New workspace**. Pick your project's folder with
**Browse…**, give it a name, and click **Create**, then **Open**.

**Pin to taskbar** gives the project its own taskbar button.

## 5. Add your z.ai key (z.ai users)

In the project window:

1. Click **⚙** (top right) to open Preferences, then go to **Accounts**.
2. Click **+ Add account**, then **z.ai (GLM)**.
3. Paste your API key (z.ai → API Keys), then click **Add**.

That's all. VibeSpace fills in the rest. Without a Claude login on the PC, every
new agent starts on z.ai.

Claude subscribers can skip this step: VibeSpace uses your Claude login. Extra
Claude accounts go in the same place, under **Claude subscription**.

## 6. Start working

- **+ Claude** starts an agent. The first time, Claude Code asks you to pick a
  theme and to trust the folder: say yes.
- Start more agents with **+ Claude**. Each one is a tab. Double-click a tab (or
  right-click → Rename…) to rename it.
- **+ ▾** has more: a new agent on a specific account, an agent in its own git
  worktree, or reopening an old conversation.
- **Tab lights:** amber = working, red = needs you (a permission or a question),
  green = done.
- **▦ Board** shows every agent at a glance.
- Close the window whenever you like. Next time every agent comes back with its
  conversation.

## Good to know

- **z.ai and Claude don't mix within one conversation.** A conversation started
  on GLM stays on GLM, and a Claude one stays on Claude. You can still have both
  kinds of agents side by side.
- **Phone control and claude.ai connectors** (Google Sheets, Chrome…) only work
  with a Claude login, not with z.ai.
- **"claude is not on PATH"**: you installed Claude Code while VibeSpace was
  open. Close VibeSpace and start it again.
- **Something odd?** Press **Ctrl+Shift+D** in the window. It copies a
  diagnostics bundle you can send along.
