# clue

**Local-first, white-box personal memory and cross-harness session recall for AI coding agents.**

English | [简体中文](./README.zh-CN.md)

---

`clue` gives every AI coding harness you use — **Antigravity (AGY)**, **Claude Code**, **Codex**, **OMP**, **pi**, **OpenCode**, and **Hermes** — one Git-audited, local source of truth about you and your work.

No cloud, no always-on MCP, no vector database, no background LLM bill. Runtime needs only [Bun](https://bun.sh) and `git`.

## How it works

- **Rules live in `AGENTS.md`; memory lives in `clue`.** clue keeps what is worth remembering about you and your projects: preferences and habits, personal facts, project direction, verified bug root causes, key decisions, and verbatim history from every harness.
- **Draft first, write only after you confirm.** While working, the model drops anything memorable into a pending *draft box* (no effect, no interruption). When you wrap up or end the conversation, it shows you the drafts; once you approve, `clue apply` writes them as one commit and prints a system-generated receipt (commit id + every change). One `clue undo` reverts the whole batch.
- **Old fixes are a baseline, not a script.** Pitfalls separate the verified *root cause* from the *fix used at the time*. When a model relies on an old entry, wrap-up asks it to either `verify` it (still the best approach; stamps a confirmation date) or `supersede` it with a better one (history kept). Entries nobody has confirmed or looked up for a long time are surfaced by `clue dream` for pruning.
- **Read on demand.** Each session starts with one frozen snapshot (profile, current project intent card, a short index, alerts). Details come from `clue search`; a local matcher adds a 1–2 line flashback only on high-confidence overlap.

| Layer | Files | Contents | Context cost |
| :--- | :--- | :--- | :--- |
| Always loaded | `PROFILE.md` · `PROJECTS.md` · `INTENTS.json` | Profile, project habits, 4-slot intent cards (goal / approach / non-goals / checkpoint) | Frozen at session start, ~2–3k chars |
| On demand | `notes.jsonl` · `pitfalls.jsonl` · `decisions.jsonl` | Notes, pitfalls (root cause vs historical fix), decisions (assumptions, revisit-when) | A few index lines; details via `clue search` |
| Verbatim | `recall.db` (rebuildable cache) | Incremental full-text index of raw transcripts from all 7 harnesses | 0 until `clue recall` / `clue show` |
| Drafts | `drafts.jsonl` (not in git) | Changes waiting for your confirmation | Listed at wrap-up |

Every source of truth is a git-tracked text file, so `clue undo` (a `git revert`) restores exactly what tools see. Files are read-only by default; edits made outside clue are flagged at the next session start — `clue restore` discards them, `clue accept` keeps them.

## Quick start

Requires [Bun](https://bun.sh) `>= 1.2.0` and `git`.

```bash
git clone https://github.com/henryyu333/CLUE.git ~/workspace/clue
mkdir -p ~/.local/bin
cat <<'EOF' > ~/.local/bin/clue
#!/bin/sh
set -eu
BUN="$(command -v bun 2>/dev/null || echo /opt/homebrew/bin/bun)"
export CLUE_HOME="${CLUE_HOME:-$HOME/.clue}"
if [ "${1:-}" = "hook" ]; then
  "$BUN" "$HOME/workspace/clue/src/cli.ts" "$@" || printf '{}\n'
  exit 0
fi
exec "$BUN" "$HOME/workspace/clue/src/cli.ts" "$@"
EOF
chmod +x ~/.local/bin/clue

clue install --all       # wire clue into every harness detected on this machine (configs are backed up first)
clue index               # build the transcript index once
clue doctor --adapters   # check the wiring
```

Wire a single harness with `clue install <agy|claude|codex|hermes|omp|pi|opencode>`; add `--dry-run` to preview. Hermes prints the lines to add to its `config.yaml`. Re-run `clue install --all` after upgrading clue.

## Commands

- **Inspect**: `clue status` · `clue view` · `clue intent` · `clue drafts` · `clue log`
- **Search**: `clue search "phrasing 1 | phrasing 2"` · `clue recall "<query>"` · `clue show <id> --around <seq>`
- **Draft** (stdin JSON; nothing is written yet): `clue note` · `clue pitfall` · `clue decision` · `clue intent` · `clue curate`
- **Write & revert**: `clue apply <ids|all>` · `clue drop <ids|all>` · `clue undo`
- **Audit & repair**: `clue dream` · `clue restore` · `clue accept "<reason>"` · `clue doctor`
- **Other**: `clue wrap` (print the wrap-up checklist) · `clue export` (secret-scrubbed context pack for web chats)

`CLUE_ROLE=worker` makes a process read-only: it sees memory but cannot draft or write — useful for delegated execution panes.

## Optional configuration (`$CLUE_HOME/clue.config.json`)

```json
{
  "readOnlyGuard": true,
  "autoRecall": true,
  "limits": { "profileChars": 1500, "intentCardChars": 450, "entryChars": 160, "noteChars": 300, "coldDays": 60 },
  "worktreeSuffixes": ["fix", "wt", "worktree", "dev"],
  "workspaceRoots": ["workspace", "projects", "code"],
  "projectWorkflows": [
    {
      "name": "my-handoff",
      "detectFile": "docs/STATUS.md",
      "wrapUpHint": "Update {file} first, then review clue drafts.",
      "intentSkipSlots": ["checkpoint"]
    }
  ]
}
```

`projectWorkflows` adds start/wrap-up hints for projects that contain a marker file; `intentSkipSlots` names intent-card slots that the project's own files own, so clue refuses to write them.

## Upgrading from v0.5

The first run migrates automatically: `pitfalls.db` leaves git (the jsonl files become the only source of truth), hit counts move to `stats.json`, and the migration is committed once. Then re-run `clue install --all` to drop the old `hook guard` entries.

## Development

```bash
bun run typecheck
bun test
```

## License

[MIT](./LICENSE)
