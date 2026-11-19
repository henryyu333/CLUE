# clue

Local-first, bounded, anti-anchoring personal memory & cross-harness session recall engine for AI coding agents — works across **Antigravity (AGY)**, **Claude Code**, **Codex**, **OMP**, **pi**, **OpenCode**, and **Hermes** from a single source of truth.

## Design Philosophy

1. **Thin Hot Layer + Cold Pitfall Store**: Keep startup context tiny and frozen per session (`PROFILE.md` ≤ 1500 chars, `PROJECTS.md` scoped to global + current repo ≤ 900 chars each) so prompt cache stays intact and instruction adherence stays high.
2. **Code Guardrails over Model Discipline**: Enforce single-line entry caps, fixed sections, page hard-caps, secret/prompt-injection scanning, row-level pinning, cross-process file locking, and automatic Git commits in code.
3. **Anti-Anchoring Pitfalls + Traceable Evidence**: Separate objective `root_cause` from `historical_fix`, include `rethink_hint` and `evidence` anchors so newer models verify ground truth and `supersede` outdated workarounds.
4. **Zero-Memory-Tax Verbatim Recall (`clue recall`)**: Incrementally index raw transcripts across 7 harnesses (including zstd-compressed Codex rollouts) into a rebuildable local SQLite FTS5 cache with secret redaction, noise demotion (subagents/cron), and bounded `--around` window expansion.
5. **Draft-First Curation & Zero-Cost Health Signals**: Read-only during normal work. On wrap-up or casual close, propose a concise draft for human approval before writing. Local health heuristics signal when it's time to run `clue dream` — no silent background LLM jobs.
6. **Markdown + Git as Truth, SQLite as Fast Index**: Zero cloud services, zero permanent MCP bloat, zero runtime dependencies beyond Bun.

## Quick Start

```bash
# Inspect health, capacity, and indexed sources
clue doctor
clue status
clue sources

# Preview startup snapshot for current directory
clue boot

# Search anti-anchoring pitfalls
clue search "SQLITE_BUSY"

# Recall verbatim past conversations across all 7 harnesses
clue index
clue recall "billing webhook" --limit 6
clue show <session-id-prefix> --around <seq>

# Run memory health audit packet
clue dream

# Safely revert the latest memory commit
clue undo
```

Set `CLUE_HOME` to point to your personal memory directory (defaults to `~/.clue`).

## Development

```bash
bun test
```
