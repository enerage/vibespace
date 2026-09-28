---
name: sync-docs
description: Flush this session's knowledge into the repo's docs and agent memory. Run when the user says "update all docs" or invokes /sync-docs. Docs and memory ONLY — never touch code.
---

# Sync docs

You are turning recent work into durable knowledge. DOCS AND MEMORY ONLY — no code
changes, no refactors, no "while I'm here" fixes.

## Steps

1. **Gather what happened since the last sync.**
   - `git log --oneline -20` and `git diff --stat` (whole session if unsure).
   - Recall this session's decisions, surprises, and lessons (including ones from
     conversation, not just commits).

2. **Update each doc that exists in this repo — skip ones that don't:**
   - **CHANGELOG.md** — new `[Unreleased]` or version section for user-visible
     changes since the last entry. One bullet per change, say what + why.
   - **DECISIONS.md** — append decisions from this session as one line each:
     `- **<topic>** — <choice>. Why: <reason>. (YYYY-MM-DD)` Create the file if
     this is the first decision. Keep it a flat list, no ADR ceremony.
   - **CLAUDE.md** — only NEW hard-won lessons/gotchas an agent must know
     (things that cost debugging time or contradict intuition). Don't rewrite
     what's already there.
   - **TODO.md** — re-triage: check off done items, add what came up, no essays.
   - **README.md** — only if features/usage drifted from what it says.

3. **Update agent memory** (your persistent memory directory, e.g.
   `~/.claude/projects/<munged-repo>/memory/`):
   - New durable facts about the USER (preferences, how they work) → `user`/`feedback`
     memories with Why + How-to-apply.
   - Ongoing project context not derivable from the repo → `project` memories.
   - Fix or delete any memory that this session proved wrong.
   - Keep `MEMORY.md` index to one line per memory.

4. **Commit if this repo uses git**: message `docs: sync (decisions, changelog, memory)`
   — only doc files + `.claude/` files. Never commit code changes made in this step
   (there shouldn't be any).

## Output

End with a short report: which files changed (docs vs memory), 1-line each, and the
single most important decision recorded. No preamble, no questions — if a doc is
already current, say "X: current" and move on.
