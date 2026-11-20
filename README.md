# clue

**Local-first, bounded, anti-anchoring personal memory & cross-harness session recall for AI coding agents.**

English | [简体中文](./README.zh-CN.md)

---

`clue` gives every AI coding harness you use — **Antigravity (AGY)**, **Claude Code**, **Codex**, **OMP**, **pi**, **OpenCode**, and **Hermes** — one compact, Git-audited source of truth for your local setup & engineering taste, 4-slot project intent cards, key decisions, verified bug root causes, and verbatim cross-tool transcripts.

Zero cloud services. Zero always-on MCP bloat. Zero vector databases. Zero background LLM bills. Zero runtime dependencies beyond [Bun](https://bun.sh).

## Why `clue`?

Recent research exposed two uncomfortable truths about agent memory:

1. **Heavy memory pipelines often underperform direct search** (*[Memory Tax](https://arxiv.org/abs/2610.34073)*): aggressively summarizing or restructuring conversations introduces *faithfulness loss*, *retrieval mismatch*, and *cross-model fragility* — a memory written by Model A often degrades Model B.
2. **Preloaded context must stay tiny, and stale notes are worse than no notes** (*[The Components of Agent Memory](https://www.anthropic.com/research/components-of-agent-memory)*): longer instruction files reduce adherence, while unverified notes anchor future sessions into repeating the same mistakes.

`clue` separates **rules** (which belong in your global `AGENTS.md`) from **living memory** across four tight layers:

| Layer | Storage | Purpose | Token Cost |
| :--- | :--- | :--- | :--- |
| **Background & 4-Slot Intent** | `PROFILE.md` + `INTENTS.json` | Your local environment & judgment taste + current repo's **4-slot intent card** (`goal`, `approach`, `nonGoals`, `checkpoint`) + automatic continuity fallback for unwrapped sessions | Compact & frozen per session (`~1000` chars) — prompt cache stays intact |
| **Pitfalls & Decisions** | `pitfalls.db` + `pitfalls.jsonl` + `decisions.jsonl` | Anti-anchoring bug root causes (`root_cause` vs `historical_fix`) and key decisions (`decision`, `rationale`, `assumptions`, `revisit_when`) with `evidence` & hit telemetry | 1-line index at boot; full details on `clue search` or 10ms auto-flashback |
| **Verbatim Recall** | `recall.db` *(rebuildable cache)* | True incremental SQLite FTS5 search across all 7 harnesses' raw transcripts (including `.jsonl.zst` Codex rollouts) | **0 tokens** until searched (`clue recall` / `clue show --around`) |
| **Invisible Guardrails** | Local `.git` + OS `0444` lock + Hook guards | OS read-only protection, Git tampering sentinel, mandatory `expectedEntry` row locks, `[pin]` locks, secret/injection scanning, auto-commit & `clue undo` | **0 tokens** |

## Core Features

- **4-Slot Project Intent Cards (`clue intent`)**: Fixed slots (`goal`, `approach`, `nonGoals`, `checkpoint`, `<=450` chars total) with partial slot updates — untouched slots stay intact so even smaller/cheaper models stay aligned on your project design without rewriting or drifting past decisions.
- **10ms Pure-Local Proactive Flashback**: On ordinary technical prompts, `clue hook prompt` runs a `<15ms` local high-confidence matcher against active pitfalls, decisions, and retrospective sessions. Strictly silent (`0` chars) unless confident; injects at most 1–2 concise lines and deduplicates per session.
- **Tiered Wrap-Up with Transparent Receipts**: On natural close ("wrap up" / "that's all"), low-risk slot updates and new pitfalls/decisions commit directly with a crisp 3–5 line receipt and instant `clue undo`; edits to core background (`PROFILE.md`) or `[pin]` entries always require explicit diff approval.
- **Anti-Anchoring Pitfalls & Decisions (`clue pitfall` / `clue decision`)**: Separates objective causes/rationales from historical workarounds and tracks `revisit_when` + `evidence` + local `hit_count`.
- **Cross-Harness Verbatim Recall (`clue recall`)**: True incremental indexing across **AGY, Claude Code, Codex (including `.jsonl.zst`), OMP, pi, OpenCode, and Hermes** with shared secret `[REDACTED]` scrubbing, noise filtering, concurrency locking, and continuity fallback when you close a window without wrapping up.
- **Anti-Staleness Audits (`clue dream`) & Web Export (`clue export`)**: Verifies whether `evidence` file paths/commits still exist, surfaces 60+ day 0-hit cold items, checks all 7 harness adapters (`clue doctor --adapters`), and exports a secret-scrubbed snapshot (`clue export`) for web chats like Gemini or ChatGPT.

## Quick Start

### 1. Clone & Link `clue`

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
```

### 2. Verify & Index Past Sessions

```bash
clue doctor --adapters  # Initializes $CLUE_HOME & checks all 7 harnesses
clue status             # Check background, intent card, hits, decisions & pitfalls
clue index              # Incrementally index past transcripts across all harnesses
clue sources            # Inspect indexed session counts per harness
```

### 3. Connect Your Harnesses

`clue` never modifies your global `AGENTS.md` / `CLAUDE.md`. Install thin adapters per harness (automatic backups are created before editing existing config files):

```bash
clue install agy      # Installs native AGY plugin (~/.gemini/config/plugins/clue/)
clue install claude   # Merges SessionStart / UserPromptSubmit / PreToolUse hooks + Skill
clue install codex    # Merges UserPromptSubmit (--with-boot) hook + Skill
clue install hermes   # Installs Skill & prints config.yaml hook snippet
```

Add `--dry-run` to preview changes first. For **OMP**, **pi**, and **OpenCode**, import `src/core/index.ts` directly (or invoke `clue`) from a thin extension/plugin.

## CLI Reference

| Command | Description |
| :--- | :--- |
| `clue boot [--cwd <dir>] [--format text\|agy\|claude\|json]` | Render frozen background, 4-slot intent card, continuity anchors & memory index |
| `clue status [--cwd <dir>] [--json]` | Zero-token overview: intent card, decisions, pitfalls, flashback hit telemetry & commits |
| `clue view [--cwd <dir>]` | Print live `PROFILE.md` and `PROJECTS.md` before proposing edits |
| `clue intent [--project <key>] [--dry-run]` | View or partially update a project's 4-slot intent card (stdin JSON) |
| `clue decision` *(stdin JSON)* | Add, update, `supersede`, `revert`, or delete a key decision |
| `clue pitfall` *(stdin JSON)* | Add, update, `supersede`, or delete an anti-anchoring pitfall |
| `clue search "<query>" [--type all\|pitfall\|decision] [--project <key>]` | Search pitfalls and decisions with FTS5 + CJK fallback |
| `clue recall "<query>" [--harness <name>] [--since 30d] [--all]` | Search verbatim past conversations across all 7 harnesses |
| `clue show <id-prefix> [--around <seq>] [--window 4] [--full]` | Expand bounded conversation context around a recall hit |
| `clue index [--harness <name>] [--rebuild]` | Incrementally refresh (or rebuild) `recall.db` with concurrency locking |
| `clue sources` | List indexed session and message counts by harness |
| `clue curate [--dry-run]` *(stdin JSON)* | Atomically add/patch/remove entries with mandatory `expectedEntry`, `[pin]` & Git commit |
| `clue dream [--mark-done]` | Run anti-staleness audit (evidence file/commit checks, 0-hit cold items & duplicates) |
| `clue export [--project <key>]` | Export a secret-scrubbed context bundle for web chats (Gemini / ChatGPT) |
| `clue lock` / `clue unlock` | Lock (`0444`) or temporarily unlock core memory files for manual edits |
| `clue log [--limit 10]` / `clue undo` | Inspect memory Git history or safely revert the latest commit |
| `clue doctor [--adapters]` | Validate storage, SQLite FTS5, Git tampering sentinel & 7-harness adapter wiring |

## Optional Configuration (`$CLUE_HOME/clue.config.json`)

```json
{
  "readOnlyGuard": true,
  "autoRecall": true,
  "limits": {
    "profileChars": 1500,
    "intentCardChars": 450,
    "entryChars": 160
  },
  "worktreeSuffixes": ["fix", "wt", "worktree", "dev"],
  "workspaceRoots": ["workspace", "projects", "code"]
}
```

## Development

```bash
bun run typecheck
bun test
```

## License

[MIT](./LICENSE)
