---
name: clue
description: >-
  The user's personal memory via the `clue` CLI: search past pitfalls, decisions and notes
  (`clue search`), recall verbatim past conversations across tools (`clue recall` / `clue show`),
  draft memory changes for the user to confirm (`clue note|pitfall|decision|intent|curate` →
  `clue apply`), and run a memory audit (`clue dream`). Use at wrap-up, when the user asks to
  remember/forget something, or when past context would help.
---

# clue personal memory

The memory directory is the user's single source of truth across every AI tool. Never edit files in it directly — every change goes through `clue` so it is validated, committed and revertible.

## Rules

1. **Draft freely, write only with consent.** Whenever something is worth remembering long-term (a preference or personal fact, a change in project direction, a verified root cause, a key decision), add a draft (set `reason` to a short plain-language summary). Drafts change nothing and need no permission. When presenting drafts or a `clue dream` audit for approval, follow 4 rules: (a) **BLUF** — open with 1 sentence giving overall status and draft count; (b) **No jargon, no hidden context** — avoid raw field names (`project`, `evidence`, `verified_at`), function names, file paths, or commit hashes in the main summary, and pair any old ID with a short plain title; (c) **Fixed 3-part block** — for each numbered draft, state which memory (new/existing), what changes, and why in 2–3 lines; (d) **Progressive disclosure** — keep technical details for follow-up and close with short reply choices (all / numbers / skip). Run `clue apply` **only after the user explicitly approves**, then paste its receipt verbatim.
2. **Old fixes are a baseline.** `root_cause` / `rationale` are verified facts; `historical_fix` is only what worked then. Think about a simpler or more native approach first. If an old entry helped and is still the best approach, draft `{"op":"verify","id":N}`; if you found something better, draft `{"op":"supersede","id":N,...}` with the new fix.
3. **Quality over quantity.** One atomic fact per note. Put synonyms and aliases in `tags` so future searches with different wording still match. If nothing is worth keeping, say so in one line.
4. **Read-only workers** (`CLUE_ROLE=worker`) only search; they never draft or write.

## Search

```bash
clue search "打包崩溃 | makensis bad_alloc"   # | separates alternative phrasings
clue search "<words>" --type note|pitfall|decision
clue recall "<words>" [--harness omp|claude|codex|agy|pi|opencode|hermes] [--since 30d]
clue show <session-id-prefix> --around <seq>
```

## Draft (stdin JSON)

```bash
clue note <<'EOF'
{"op":"add","content":"User prefers plain-language explanations of unfamiliar systems","tags":"communication, explain style","evidence":"session id"}
EOF

clue pitfall <<'EOF'
{"op":"add","project":"global","tags":"alias1, alias2","symptom":"...","rootCause":"...","historicalFix":"...","rethinkHint":"...","evidence":"commit / file / session"}
EOF

clue decision <<'EOF'
{"op":"add","topic":"...","decision":"...","rationale":"...","assumptions":"...","revisitWhen":"...","evidence":"..."}
EOF

clue intent <<'EOF'
{"checkpoint":"where this session stopped"}
EOF
```

- Ops for note / pitfall / decision: `add`, `update` (id), `supersede` (id), `verify` (id), `delete` (id); decisions also `revert` (id).
- Intent cards: pass only the slots that changed (`goal`, `approach`, `nonGoals`, `checkpoint`); total ≤ 450 chars.
- Profile / project habits: run `clue view` first, then
  `clue curate <<'EOF' {"target":"profile","scope":"<section>","operations":[{"action":"patch","oldText":"unique substring","expectedEntry":"exact full line","content":"new line"}]} EOF`.
  `[pin]` entries need `"forcePin": true` and explicit user approval.

## Wrap-up

```bash
clue wrap              # checklist + current drafts
clue drafts            # list drafts
clue apply 1 3         # write approved drafts as one commit, prints receipt
clue drop 2            # discard a draft
clue undo              # revert the last memory commit
```

## Maintenance

```bash
clue dream             # audit: stale evidence, cold entries, duplicates; draft fixes, then `clue dream --mark-done`
clue restore           # discard edits made outside clue
clue accept "<reason>" # keep edits made outside clue
clue doctor --adapters # check harness wiring
```
