---
name: clue
description: >-
  Personal memory and anti-anchoring pitfall lookup via the `clue` CLI.
  Use when searching past technical pitfalls (`clue search`), reviewing or
  updating personal preferences/project conventions (`clue view` / `clue curate` /
  `clue pitfall`) after user approval, or running a memory health audit (`clue dream`).
---

# clue Personal Memory Workflow

`clue` manages the user's single-source personal memory (`PROFILE.md`, `PROJECTS.md`, `pitfalls.db`).
Never directly edit files inside the memory directory with raw file-edit tools — always go through `clue` so hard character caps, secret scanning, locking, and automatic Git commits stay intact.

## Core Principles

1. **Silent read-only by default**: Do not modify memory unprompted during ordinary work.
2. **Draft-first approval**: On wrap-up or closing turns, check whether anything is truly worth remembering across sessions.
   - If nothing new emerged, state briefly that there is no new long-term memory.
   - If something should be saved, present a concise draft (target, add/patch/remove or pitfall fields) and wait for the user's confirmation before executing `clue curate` or `clue pitfall`.
3. **Anti-anchoring on pitfalls**: Trust `root_cause` as a verified clue, treat `historical_fix` as reference only, and check `evidence` if details may have changed. If you validate a cleaner fix, propose `op: "supersede"`.

## Commands

### 1. Search historical pitfalls & past raw sessions (read-only)
```bash
clue search "<keywords or error>" [--project <name>] [--limit 4]
clue recall "<keywords>" [--harness agy|claude|codex|omp|pi|opencode|hermes] [--since 30d] [--limit 6]
clue show <session-id-prefix> --around <seq> [--window 4]
```
- Use `clue search` first for verified anti-anchoring bug root causes.
- Use `clue recall` + `clue show --around` when you need exact verbatim details from past sessions across any harness (zero memory tax; if keywords miss, retry with synonyms using `OR`).

### 2. Inspect current memory & capacity before proposing edits
```bash
clue view
clue status
```

### 3. Curate hot-layer memory (stdin JSON, after user approval)
```bash
clue curate <<'EOF'
{
  "target": "profile",
  "scope": "认知与审美偏好",
  "operations": [
    { "action": "add", "content": "Concise single-line entry <= 160 chars." }
  ],
  "reason": "short summary of why this changed"
}
EOF
```
- `target`: `"profile"` (`技术底座` | `认知与审美偏好` | `个人与协作习惯`) or `"projects"` (`global` or lowercase project key).
- `operations` supports `"add"`, `"patch"` (`oldText`, optional `expectedEntry`, `content`), `"remove"` (`oldText`, optional `expectedEntry`).
- If a hard-cap error occurs, combine `remove`/`patch` + `add` in the same atomic `operations` array.
- Add `--dry-run` to preview capacity before committing.

### 4. Log or supersede a pitfall (stdin JSON, after user approval)
```bash
clue pitfall <<'EOF'
{
  "op": "add",
  "project": "global",
  "tags": "tag1, tag2",
  "symptom": "Observable failure or trigger",
  "rootCause": "Objective underlying mechanism (no imperative workaround rules)",
  "historicalFix": "How it was resolved at the time",
  "rethinkHint": "When/how a cleaner solution would replace this",
  "evidence": "Optional file path, commit hash, or session anchor"
}
EOF
```
- `op`: `"add"` | `"supersede"` (requires `id`) | `"update"` (requires `id`) | `"delete"` (requires `id`).

### 5. Deep health audit ("dreaming") and rollback
```bash
clue dream                  # Print health metrics, duplicates, active pitfalls & recent commits
clue dream --mark-done      # Mark audit complete after approved updates land
clue undo                   # Safely revert the latest memory commit
```
