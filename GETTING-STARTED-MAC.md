# Getting started with VibeSpace on a Mac

VibeSpace gives every project its own window with a file tree, a preview of
your files (code, images, videos) and Claude Code agents side by side. Setup
takes about 10 minutes. You need a Mac with **macOS 13 (Ventura) or newer**.

You need **one** of these:
- a **Claude** subscription (Pro or Max), or
- a **z.ai GLM Coding Plan** (an API key from z.ai).

## 1. Install Claude Code

Open **Terminal** (press ⌘ Space, type `Terminal`, press Return) and paste:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

When it finishes, close Terminal, open it again and check that it worked:

```sh
claude --version
```

If your Mac offers to install the **command line developer tools**, click
**Install** and wait until it's done. Claude Code and VibeSpace use Git, which
comes with them.

- **Using z.ai only?** Stop here. Don't log in; VibeSpace will give Claude Code
  your z.ai key.
- **Using a Claude subscription?** Type `claude`, press Return, log in in the
  browser, then type `/exit`.

## 2. Install VibeSpace

1. Open the [VibeSpace 0.7.0 release](https://github.com/enerage/vibespace/releases/tag/v0.7.0)
   and, under **Assets**, download the `.dmg` for your Mac:
   - Apple menu  → **About This Mac**. "Chip: Apple M…" → `VibeSpace-0.7.0-arm64.dmg`;
     "Processor: Intel" → `VibeSpace-0.7.0.dmg` (the Intel one).
2. Open the `.dmg` and drag **VibeSpace** onto **Applications**.
3. Open **VibeSpace** from Applications. The first time, macOS says it can't
   check the app, because it isn't from the App Store. Click **Done** (not
   "Move to Bin").
4. Open  → **System Settings → Privacy & Security**, scroll down to
   "VibeSpace was blocked…" and click **Open Anyway**. Confirm with your
   password or Touch ID, then click **Open**.

You only do steps 3–4 once; after that VibeSpace opens normally.

## 3. Open your project

In the launcher, click **New workspace**. Pick your project's folder with
**Browse…**, give it a name, click **Create**, then **Open**.

If macOS asks whether VibeSpace may access your **Documents** or **Desktop**
folder, click **Allow**.

## 4. Add your z.ai key (z.ai users)

In the project window:

1. Click **⚙** (top right) to open Preferences, then go to **Accounts**.
2. Click **+ Add account**, then **z.ai (GLM)**.
3. Paste your API key (z.ai → API Keys), then click **Add**.

That's all. The key is kept in your Mac's Keychain. Every new agent starts on
z.ai.

## 5. Start working

- **Click a file** in the tree on the left to see it: code, pictures, videos
  and sounds all open in the preview.
- **+ Claude** starts an agent. The first time, Claude Code asks you to pick a
  theme and to trust the folder: say yes.
- Each agent is a tab. Double-click a tab to rename it.
- **Tab lights:** amber = working, red = needs you, green = done.
- Close the window whenever you like. Next time every agent comes back with its
  conversation.

## Keys

| Do this | Press |
|---|---|
| Copy / paste in an agent tab | ⌘C / ⌘V |
| Paste a screenshot into Claude | Ctrl+V (Claude's own key) |
| Stop what the agent is doing | Esc |
| Find a file | ⌘P |
| Search the terminal | ⌘F |

## Good to know

- **One z.ai key per person.** Don't share a key between computers or people:
  z.ai doesn't allow it.
- **Something odd?** Press **⌘⇧D** in the window. It copies a diagnostics
  bundle you can send along.
