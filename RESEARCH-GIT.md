# Git history + actions for VibeSpace — research (2026-09-29)

Use case: solo supervisor, many Claude Code agents per repo, agents write code AND commit.
The human's job is: "what did the agents just do, is it OK, and how do I undo a bad one?"
Not: authoring commits, crafting history, rebasing.

## Verdict

Build a **read-mostly "History" view focused on recent commits** (list + commit detail diff
reusing the existing Monaco diff), plus a **branch/ahead-behind chip**, plus **file history**
from the tree/preview. Graph lanes are cheap (VS Code's algorithm is ~90 lines) but low value
for a mostly-linear, agent-committed main branch — do it after the list, not before.
Write actions: only **revert commit** (creates a new commit, never rewrites) and **discard file**
(with confirm + busy-agent guard) are clearly worth UI; push maybe; everything else stays with
agents/terminal.

**Most important non-feature finding:** VibeSpace's background git calls (`gitstatus.cjs`,
`gitdiff.cjs`, `githistory.cjs`) spawn with plain `process.env`. `git status` takes
`.git/index.lock` opportunistically to refresh the index; with many agents committing in the
same worktree, a background refresh can make an agent's `git commit`/`git add` fail with
"index.lock exists". Every read-only spawn should set `GIT_OPTIONAL_LOCKS=0`
(or pass `--no-optional-locks`). VS Code, GitHub Desktop (issue #22047), Git Extensions (#5066)
all hit this. Build it through ptyhost's Path-safe env helper (CLAUDE.md Path/PATH rule).

Note: `main/githistory.cjs` already exists in the repo (log/show/branch info, read-only,
`core.quotepath=off`, `i18n.logOutputEncoding=UTF-8`, `\x1f`/`\x1e` separators) — someone is
building this now; findings below are meant to feed that work.

---

## 1. History features ranked by value/effort (supervisor-of-agents)

| # | Feature | Value | Effort | Why for this use case |
|---|---------|-------|--------|------------------------|
| 1 | **Commit list** (subject, author, relative time, short sha, +/- stats, "unpushed" marker) paged 100 at a time | Very high | Low | The "what did my agents do in the last hour" timeline. Every tool (VS Code SCM Graph, GitLens, Zed History tab, lazygit, Fork, SM) has it as the spine. |
| 2 | **Commit detail = changed files + side-by-side diff** (reuse Changes tab Monaco diff: `sha^` vs `sha`) | Very high | Low (reuse) | This is the review surface. GitHub Desktop, Fork, SM, Zed all open a file-list + diff on click. |
| 3 | **Branch + ahead/behind chip** (current branch, upstream, ↑n ↓m, detached/rebase-in-progress warning) | High | Very low | Agents create branches, detach HEAD, leave rebases half-done. One glance catches it. VS Code status bar pattern. |
| 4 | **"Since I last looked" / unseen-commits marker** (store last-seen sha per workspace; badge new commits; group by agent tab if trailer/session maps) | High (agent-specific) | Low | Not in classic clients; it's the supervisor's real question. Ties into existing tab status lights. |
| 5 | **File history** (right-click file in tree/preview → commits touching it → per-file diff) | High | Low | Zed's most-upvoted git request (250+) and shipped 2025; GitLens/Fork/SM all have it. "Who broke this file, when?" |
| 6 | **Search/filter** (message, author, path; `--grep`, `--author`, `-- <path>`; optionally `-S`/`-G` pickaxe for content) | Medium-high | Low-medium | Sublime Merge's signature feature; with hundreds of agent commits/day, search by message/path matters. Pickaxe is slow on big repos — make it explicit. |
| 7 | **Compare range** (select two commits, or "everything since sha X" as one diff) | Medium-high | Low (same diff code) | Reviewing an agent's 12 micro-commits as one change. SM Ctrl+click two commits; VS Code "incoming/outgoing" groups. |
| 8 | **Graph lanes** | Medium | Medium | Useful when agents use branches/worktrees; nearly pointless on linear main. VS Code SCM Graph layout is ~90 LOC, O(n·lanes). |
| — | Blame | Low-medium | Medium | Line-level "who" is less useful when every line is authored by "Valentin + Claude". Defer; file history covers most needs. If added, `git blame --porcelain -w -M` streaming. |
| — | Stash list, tags, reflog UI | Low | Low | Reflog is a lifesaver but a terminal-level recovery tool; maybe a hidden "recover" view later. |

Agent-specific extras worth considering (cheap, high leverage):
- **Agent attribution**: Claude Code commits carry a `Co-Authored-By: Claude …` trailer; pull it with
  `%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)` and show a small agent badge. VibeSpace
  could additionally inject a `VibeSpace-Tab: <name>` trailer via the hook settings or map commit time
  to which tab was "working" (status.cjs already knows) to label "which agent made this commit".
  Git AI (git-ai-project) does line-level attribution via git notes — overkill here, but notes
  (`--show-notes=ai`) are the standard if ever wanted.
- **Mixed-commit warning**: a known multi-agent failure is agent B `git add -A` sweeping agent A's
  half-finished files into its commit (crystl.dev, dev.to "4 agents in parallel"). A commit whose file
  list overlaps files another tab was editing is worth flagging. Longer-term answer is worktree-per-agent.
- Claude Code `/rewind` checkpoints do NOT undo commits/pushes and die with the session; Cursor
  checkpoints likewise are "not version control". So git history is the durable undo layer — which
  argues for making revert easy (below).

## 2. Write actions: UI vs leave to agents

| Action | In UI? | Notes / safety |
|--------|--------|----------------|
| **Revert commit** (`git revert --no-edit <sha>`) | **Yes** — the killer supervisor action | Non-destructive (new commit), safe on pushed history (GitHub Desktop's "Revert changes in commit"). Guard: refuse if worktree has changes touching the same files (or run with `--no-commit` and show result); refuse on merge commits unless `-m 1`; block while any agent tab is "working" on overlapping files, or at least warn. On conflict → `git revert --abort` offer, never leave a half-state silently. |
| **Discard file changes** (`git restore --source=HEAD --staged --worktree -- <path>`; untracked → move to Recycle Bin, not delete) | **Yes**, from the Changes tab | Destructive and irreversible for uncommitted work — the most dangerous button in the app. Confirm dialog naming the file; warn loudly if an agent is working (it may be the agent's in-progress edit). Consider snapshotting the content (e.g. `git stash create` → store sha, or copy to `~/.vibespace/trash`) so it's undoable. |
| **Push** | Maybe (button in branch chip when ahead > 0) | Low risk if never `--force`. Agents usually push themselves; a one-click push is convenient. Never offer force-push. |
| **Pull / fetch** | Fetch yes (background, `--no-optional-locks` irrelevant; fetch writes refs only), pull no | Pull can merge/rebase under running agents' feet → conflicts in files they're editing. Show "↓n behind" and let the user tell an agent to pull. Periodic `git fetch` (VS Code autofetch default 180 s) makes ahead/behind honest. |
| **Commit** | No (or minimal) | Agents commit. A human commit button competes with agents for the shared index and risks sweeping agents' partial work (same problem as `git add -A`). |
| **Undo last commit** (`reset --soft HEAD~1`) | No | GitHub Desktop has it but it rewrites history; data-loss bug reported (desktop#5874); with agents committing concurrently "last" is a race. Revert covers the need. |
| **Checkout commit / branch switch** | No | Swaps files under every running agent in that worktree — catastrophic for parallel agents. Terminal/agent only. |
| **Stash** | No | Same: yanks files away from agents mid-edit. |
| **Reset --hard, rebase, force push, branch delete** | No | Never in UI. |
| Copy sha / copy message / "open commit on GitHub" | Yes | Zero risk, high convenience; also "send this sha to agent X" (paste into a tab) is a natural VibeSpace-specific action ("review commit abc123"). |

General safety rules from the tools: prefer operations that add history over ones that rewrite it
(GitHub Desktop's model); every destructive action needs a named confirm; run writes serially through
one queue per repo; detect `.git/index.lock`, `MERGE_HEAD`, `REBASE_HEAD`/`rebase-merge/`,
`REVERT_HEAD`, `CHERRY_PICK_HEAD` and surface "repo is mid-operation" before any write.

## 3. Commands and flags

### Commit list (paged)
```
git -c core.quotepath=off -c i18n.logOutputEncoding=UTF-8 -c log.showSignature=false \
  --no-optional-locks log -n 100 --skip=<k> --date-order \
  --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)%x1e \
  [<rev>|HEAD] [--first-parent] [-- <path>]
```
- Separators: `%x00`/`%x1f`/`%x1e` are safe because commit subjects can't contain NUL and control
  chars are vanishingly rare; vscode-git-graph uses a long random token instead — either works.
  Use `%s` for the list, fetch `%B` only in detail view.
- `-z` on `git log` NUL-terminates records but also changes `--name-status` file separators; if you
  combine format + name-status in one call, use `-z` and parse carefully. Simpler: two calls.
- Paging: `--skip`/`-n` is O(skip) per page (git re-walks) — fine up to tens of thousands; for
  deeper, page by `<last-sha>^` (or `--before`) instead of skip. Stats (`--shortstat`) per commit
  in the list roughly doubles cost on big repos — fetch lazily or only for the visible page.
- Ordering: `--date-order` interleaves by commit time (what a supervisor wants: "latest first");
  `--topo-order` groups branches (nicer graph, slower on big repos since it must walk everything first
  unless commit-graph file exists). Recommend `git commit-graph write` benefit: newer git maintains it
  via `fetch.writeCommitGraph`/`gc`; big speedup for log/topo/ahead-behind.
- Unpushed marker: `git rev-list @{u}..HEAD` (set of shas) — or compute from ahead count.

### Commit detail
- Metadata: `git show -s --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B <sha>`.
- Files: `git diff-tree -r --root --no-commit-id --find-renames -z --name-status <sha>` and
  `... --numstat -z <sha>` (vscode-git-graph does exactly this). `--root` makes the initial commit
  work. `-z` avoids quoting and gives rename pairs as separate NUL fields (`R100\0old\0new\0`).
- Merge commits: `diff-tree` on a merge shows nothing by default. Use `git diff-tree -r -m
  --first-parent` (or `--diff-merges=first-parent` with log/show) = "what this merge brought into
  the branch"; that's what humans expect. Combined diffs (`--cc`) are confusing — skip.
- File contents for Monaco: `git show <sha>:<path>` (new) and `git show <sha>^:<path>` (old; for
  renames use the old path; for root commit/added files → empty). Use `git cat-file --batch` as a
  persistent process if you need many blobs fast (one spawn, request/response on stdin) — spawning
  git on Windows costs ~20-50 ms each.
- Paths in `<sha>:<path>` must be repo-relative with forward slashes; prefix `./` issues — use
  `git show <sha>:"sub/dir/file"`, never backslashes.

### Branch / ahead-behind chip
- `git status --porcelain=v2 --branch -z` (with GIT_OPTIONAL_LOCKS=0) gives `# branch.head`,
  `# branch.upstream`, `# branch.ab +3 -1` AND the file status in one spawn — can replace the
  separate status call gitstatus.cjs already makes.
- Alternative: `git rev-list --left-right --count @{u}...HEAD` → "behind\tahead" (left = upstream).
  Fails with non-zero exit if no upstream — treat as "no upstream".
- Mid-operation detection: check files in `git rev-parse --git-dir` (MERGE_HEAD, REBASE_HEAD,
  rebase-merge/, rebase-apply/, REVERT_HEAD, CHERRY_PICK_HEAD, BISECT_LOG). Note worktrees:
  use `--git-dir`/`--git-common-dir`, never assume `.git` is a directory (it's a file in worktrees).

### File history
- `git log --follow --format=... -n 100 -- <path>` (`--follow` works for ONE file only and is a
  heuristic; fine for this). Per-commit file diff: `git diff <sha>^ <sha> -- <path>` or blobs via show.
  For rename-aware old path, add `--name-status` to the follow log to get the path at each commit.

### Search
- `--grep=<re> -i` (message), `--author=<re>`, `-- <path>`; `-S<string>` / `-G<regex>` (content,
  slow on large repos — make it an explicit "search contents" toggle with a timeout).

### Graph
- Don't parse `git log --graph` ASCII: unstable across versions, hard to page, can't color/click.
  Compute lanes from `%P` yourself (algorithm in §4).

### Windows quirks
- `GIT_OPTIONAL_LOCKS=0` (env) or `--no-optional-locks` on every read-only call — see verdict.
- `core.quotepath=off` for UTF-8 paths in non-`-z` output; with `-z`, paths are never quoted anyway.
- `i18n.logOutputEncoding=UTF-8` + decode the whole Buffer once (already done in githistory.cjs).
  Commits with a non-UTF-8 `encoding` header get re-encoded by git; invalid bytes pass through → use
  `TextDecoder('utf-8', {fatal:false})`.
- CRLF: `core.autocrlf=true` means `git show sha:path` returns LF blobs while the worktree has CRLF →
  whole-file diff noise; already handled in gitdiff.cjs (normalize EOL before diffing, or
  `ignoreTrimWhitespace`-style option in Monaco). For historical diffs (blob vs blob) both sides are
  repo form, so no issue.
- Long paths: `-c core.longpaths=true` for read calls on deep node_modules-style trees (mostly matters
  for checkout/status, harmless to pass).
- `LANG`/`LC_ALL` doesn't matter for porcelain; but set `GIT_TERMINAL_PROMPT=0` and
  `GCM_INTERACTIVE=never` on fetch/push so a credential prompt never hangs a hidden process.
- `safe.directory`: repos on other drives/owned by another SID produce "dubious ownership" errors
  (exit 128) — surface the message, don't swallow it as "not a repo".
- Always `windowsHide: true`, argv arrays (never shell strings), and a timeout (already done).
- Use the git on the repaired Path (ptyhost `withSinglePath`) — see CLAUDE.md Path/PATH bug.

### Refresh strategy
- Watch `.git/HEAD`, `.git/refs/heads/**`, `.git/packed-refs`, `.git/logs/HEAD` (reflog appends on
  every commit — single cheapest "a commit happened" signal) with a debounce, instead of polling log.
  With worktrees, the reflog lives in the worktree's git-dir.

## 4. Lane / graph layout algorithms

**Recommended: VS Code SCM Graph** (`src/vs/workbench/contrib/scm/browser/scmHistory.ts`,
`toISCMHistoryItemViewModelArray`, ~90 LOC, MIT).
- Walk commits in log order. Each row has `inputSwimlanes` (= previous row's outputs: list of
  "expected commit id + color"). For the current commit: the first input lane whose id == this commit
  becomes its column; that lane continues with `parentIds[0]` (first parent keeps the lane and color);
  other input lanes also pointing at this commit are closed (merge-in lines drawn to the node);
  parents 1..n are appended as new lanes at the end with new rotated colors; lanes not matching pass
  through unchanged.
- Rendering: per-row small SVG (fixed row height) drawing vertical lines, a circle, and curved
  connectors from input lane index → output lane index. Rows are independent → virtualizes trivially
  and pages naturally (carry the last row's outputSwimlanes into the next page).
- Complexity O(n × m), n commits, m concurrent lanes; streaming/pageable; no global pass.
- Downside: lanes can drift/widen (new parents always appended at the end, no compaction), fine for
  mostly-linear repos.

**vscode-git-graph** (`web/graph.ts`, mhutchie, MIT-ish "Git Graph License" — check before copying;
it is NOT plain MIT). `determinePath(startAt)` traces each branch from a vertex down through first
parents, registering occupied points per row (`registerUnavailablePoint`), reusing colors of branches
that ended (`availableColours`), with special handling when a merge connects two already-placed
vertices. Prettier, compact output; O(V²) worst case and needs the full loaded set (re-layout on
paging). More code (~several hundred LOC incl. rendering).

**lazygit** (`pkg/gui/presentation/graph`, MIT, Go): `GetPipeSets` builds per-row "pipes"
(from-lane, to-lane, kind start/terminate/continue) incrementally from the previous row — same
streaming model as VS Code, renders to box-drawing chars; I believe it reuses free columns (lane compaction), but this was
not verified in source. Good reference if compaction is wanted: roughly O(n × m).

Recommendation: port the VS Code approach (~90 LOC + ~80 LOC SVG row renderer), add lazygit-style
"reuse lowest free column" compaction if widening becomes ugly.

## Sources
- VS Code SCM history docs: https://code.visualstudio.com/docs/sourcecontrol/history
- VS Code SCM graph incoming/outgoing: https://github.com/microsoft/vscode/issues/227727 ;
  https://www.infoworld.com/article/2514182/visual-studio-code-previews-incoming-outgoing-changes-graph.html
- VS Code layout source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts
- vscode-git-graph: https://github.com/mhutchie/vscode-git-graph (web/graph.ts, src/dataSource.ts)
- lazygit graph pkg: https://pkg.go.dev/github.com/jesseduffield/lazygit/pkg/gui/presentation/graph
- Zed git / file history: https://zed.dev/blog/lets-git-together ; https://zed.dev/docs/git
- GitLens: https://help.gitkraken.com/gitlens/gl-commit-graph/ ; https://help.gitkraken.com/gitlens/gl-visual-file-history/
- Sublime Merge: https://www.sublimemerge.com/
- GitHub Desktop undo/revert: https://docs.github.com/en/desktop/managing-commits/undoing-a-commit-in-github-desktop ;
  https://docs.github.com/en/desktop/managing-commits/reverting-a-commit-in-github-desktop ;
  data-loss issue https://github.com/desktop/desktop/issues/5874
- Optional locks: https://github.com/desktop/desktop/issues/22047 ; https://github.com/gitextensions/gitextensions/issues/5066 ;
  Claude Code stale index.lock https://github.com/anthropics/claude-code/issues/57102
- Claude Code checkpoints: https://code.claude.com/docs/en/checkpointing
- Cursor git/agent review: https://cursor.com/docs/agent/agent-review ; https://cursor.com/help/integrations/git
- Multi-agent same-repo problems: https://crystl.dev/blog/two-agents-same-repo/ ;
  https://dev.to/yureki_lab/how-i-run-4-claude-code-agents-in-parallel-on-one-repo-without-chaos-5ejc
- Worktrees for parallel agents: https://superset.sh/blog/parallel-coding-agents-guide
- Git AI attribution: https://github.com/git-ai-project/git-ai
- Vibe-coder VCS: https://jxnl.co/writing/2025/03/18/version-control-for-the-vibe-coder-part-1/
- git-log docs: https://git-scm.com/docs/git-log
