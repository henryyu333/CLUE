---
name: clue
description: >-
  Personal memory, 4-slot project intent cards, anti-anchoring pitfalls & decisions,
  and cross-harness session recall via the `clue` CLI. Use when searching past bugs
  or decisions (`clue search`), recalling verbatim cross-tool chats (`clue recall` /
  `clue show`), updating project intent/pitfalls/decisions on wrap-up (`clue intent` /
  `clue pitfall` / `clue decision`), curating core background (`clue curate`) after
  user approval, or running a memory health audit (`clue dream`).
---

# clue Personal Memory Workflow

`clue` manages the user's single-source personal memory (`PROFILE.md`, `INTENTS.json`, `PROJECTS.md`, `pitfalls.db`).
Never directly edit files inside the memory directory with raw file-edit tools — core files are OS read-only guarded and must go through `clue` so validation, locking, and automatic Git commits stay intact.

## Core Principles

1. **Silent read-only by default**: Do not modify memory unprompted during ordinary work.
2. **Tiered wrap-up persistence (low-risk direct + receipt; high-risk draft-first)**:
   - **Low-risk daily updates** (`clue intent` partial slot updates, adding a new `clue pitfall` or `clue decision` with `evidence`): on natural close/wrap-up, write directly through `clue` and append a crisp **3–5 line receipt** at the end of your reply showing exact slot diffs/new entries, commit hash, and that saying "undo memory" (`clue undo`) reverts immediately.
   - **High-risk updates** (editing/deleting `PROFILE.md` background/taste card or `[pin]` entries): **never write directly** — run `clue view` first, show a clear before/after diff draft, and wait for user approval before calling `clue curate` (with mandatory `expectedEntry`).
   - If nothing worth remembering happened, add one brief line (or omit noise).
3. **Anti-anchoring on pitfalls & decisions**: Trust `root_cause` / `rationale` as verified clues, treat `historical_fix` as reference only, and check `revisit_when` + `evidence`. If a cleaner fix or changed assumption emerges, use `op: "supersede"`.

## Commands

### 1. Search pitfalls, decisions & past raw sessions (read-only)
```bash
clue search "<keywords>" [--type all|pitfall|decision] [--project <name>] [--limit 4]
clue recall "<keywords>" [--harness agy|claude|codex|omp|pi|opencode|hermes] [--since 30d] [--limit 6]
clue show <session-id-prefix> --around <seq> [--window 4]
```

### 2. Inspect current memory, status & web export
```bash
clue view
clue status
clue intent
clue export [--project <name>]
```

### 3. Update 4-slot project intent card (partial slot update via stdin JSON)
```bash
clue intent <<'EOF'
{
  "project": "myrepo",
  "goal": "Optional: only pass slots that actually changed",
  "approach": "Optional",
  "nonGoals": "Optional",
  "checkpoint": "Where this session stopped and next step",
  "evidence": "agy:conv-id or commit hash"
}
EOF
```
- Untouched slots are preserved verbatim. Total card budget is strictly bounded (`<= 450` chars).

### 4. Log or supersede a key decision (stdin JSON)
```bash
clue decision <<'EOF'
{
  "op": "add",
  "project": "myrepo",
  "topic": "architecture",
  "decision": "Chosen approach",
  "rationale": "Why chosen & what was rejected",
  "assumptions": "Underlying premise",
  "revisitWhen": "Condition under which this should be reconsidered",
  "evidence": "Session ID, file path, or commit hash"
}
EOF
```
- `op`: `"add"` | `"supersede"` (requires `id`) | `"update"` (requires `id`) | `"revert"` (requires `id`) | `"delete"` (requires `id`).

### 5. Log or supersede a pitfall (stdin JSON)
```bash
clue pitfall <<'EOF'
{
  "op": "add",
  "project": "global",
  "tags": "tag1, tag2",
  "symptom": "Observable failure or trigger",
  "rootCause": "Objective underlying mechanism",
  "historicalFix": "How it was resolved at the time",
  "rethinkHint": "When/how a cleaner solution would replace this",
  "evidence": "File path, commit hash, or session anchor"
}
EOF
```

### 6. Curate core background card (stdin JSON, after user approval)
```bash
clue curate <<'EOF'
{
  "target": "profile",
  "scope": "技术底座",
  "operations": [
    { "action": "patch", "oldText": "unique substring", "expectedEntry": "exact full original line", "content": "updated single-line entry" }
  ],
  "reason": "short summary of why this changed"
}
EOF
```
- `patch` and `remove` require exact `expectedEntry`. Entries tagged with `[pin]` require explicit `"forcePin": true` after user confirmation.

### 7. Health audit, adapter check, lock & rollback
```bash
clue dream                  # Staleness evidence check, 0-hit cold items, duplicates & active ledger
clue dream --mark-done      # Mark audit complete
clue doctor --adapters      # Verify all 7 harnesses' hook/guard/skill wiring
clue undo                   # Safely revert the latest memory commit
clue unlock / clue lock     # Temporarily unlock/relock read-only memory files for manual edits
```
