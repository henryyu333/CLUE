#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acceptManualEdits,
	addDraft,
	applyDrafts,
	buildBootSnapshot,
	buildDreamPacket,
	buildProactiveFlashback,
	buildTurnNotice,
	buildWebExportBundle,
	detectInvoker,
	detectUnauthorizedChanges,
	dropDrafts,
	ensureClueStorage,
	evaluateMemoryHealth,
	formatAgyPreInvocation,
	formatAgySessionStart,
	formatClaudeHookOutput,
	formatDecisionGuidance,
	formatDraftList,
	formatIntentCard,
	formatNoteGuidance,
	formatPitfallGuidance,
	getProjectIntent,
	getReadOnlyGuardedFiles,
	getRecentMemoryCommits,
	isWorkerRole,
	LEDGER_KINDS,
	ledgerFile,
	ledgerLabel,
	listActive,
	loadClueConfig,
	lockFilesReadOnly,
	lookedUpSince,
	markDreamDone,
	mutateProjectIntent,
	noteHarnessSeen,
	readDrafts,
	readHotMemoryView,
	readLedger,
	recordHits,
	resolveProjectKey,
	restoreTruthFiles,
	searchLedger,
	skippedIntentSlots,
	undoLastMemoryCommit,
	unlockFilesWritable,
	type DecisionRow,
	type DraftKind,
	type NoteRow,
	type PitfallRow,
} from "./core/index.ts";
import {
	getRecallSources,
	indexRecallSessions,
	recallSessions,
	showSessionWindow,
	type RecallHarness,
} from "./recall/index.ts";
import { ADAPTER_TARGETS, inspectHarnessAdapters, installHarnessAdapter, type InstallTarget } from "./adapters/install.ts";

const VERSION = "0.6.0";

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i]!;
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			if (eq > 2) {
				flags[tok.slice(2, eq)] = tok.slice(eq + 1);
			} else {
				const key = tok.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else {
			positionals.push(tok);
		}
	}
	return { positionals, flags };
}

async function readStdinText(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

function getFlagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
	const v = flags[key];
	return typeof v === "string" ? v : undefined;
}

function getFlagBool(flags: Record<string, string | boolean>, key: string): boolean {
	return flags[key] === true || flags[key] === "true";
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Per-conversation scratch state for CLI-hook harnesses (one process per hook call).

const HOOK_STATE_DIR = join(tmpdir(), "clue-hook-dedup");
const HOOK_STATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function hookStateFile(prefix: string, scopeKey: string): string {
	mkdirSync(HOOK_STATE_DIR, { recursive: true });
	return join(HOOK_STATE_DIR, `${prefix}-${createHash("sha1").update(scopeKey).digest("hex").slice(0, 16)}.json`);
}

function readHookState<T>(prefix: string, scopeKey: string): T | null {
	try {
		const file = hookStateFile(prefix, scopeKey);
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
	} catch {
		return null;
	}
}

function writeHookState(prefix: string, scopeKey: string, value: unknown): void {
	try {
		writeFileSync(hookStateFile(prefix, scopeKey), JSON.stringify(value), "utf8");
		if (Math.random() < 0.05) {
			const now = Date.now();
			for (const name of readdirSync(HOOK_STATE_DIR)) {
				const full = join(HOOK_STATE_DIR, name);
				if (now - statSync(full).mtimeMs > HOOK_STATE_TTL_MS) rmSync(full, { force: true });
			}
		}
	} catch {
		// Scratch state must never fail a hook.
	}
}

function printHelp(): void {
	console.log(`clue v${VERSION} — local-first personal memory for AI coding agents

Read:
  clue boot [--cwd <dir>] [--format text|agy|claude|json]
  clue status | view | log [--limit n]
  clue search "<说法1 | 说法2>" [--type all|pitfall|decision|note] [--project <key>] [--limit n] [--all]
  clue intent [--project <key>]                 (no stdin: show card)
  clue recall "<query>" [--harness <name>] [--since 30d] [--limit n] [--all]
  clue show <id-prefix> [--around <seq>] [--window 4] [--full]
  clue index [--harness <name>] [--rebuild] | clue sources
  clue dream [--mark-done] | clue export [--project <key>]

Draft (stdin JSON; nothing is written until apply):
  clue note | pitfall | decision | intent | curate
  clue drafts                                   list pending drafts
  clue apply <ids|all>                          write confirmed drafts as one commit + receipt
  clue drop <ids|all>                           discard drafts
  clue wrap                                     print the wrap-up checklist with current drafts

Repair:
  clue undo                                     revert the last memory commit
  clue restore | clue accept "<reason>"         discard / keep edits made outside clue
  clue lock | clue unlock
  clue doctor [--adapters] [--json]
  clue install <${ADAPTER_TARGETS.join("|")}|--all> [--bin <path>] [--dry-run]
  clue hook <session-start|prompt> --harness <agy|claude|codex|hermes|opencode> [--with-boot]

Environment:
  CLUE_HOME    memory directory (default: ~/.clue)
  CLUE_ROLE    "worker" makes this process read-only (no drafts or writes)`);
}

async function runHookCommand(sub: string, flags: Record<string, string | boolean>): Promise<void> {
	const harness = (getFlagStr(flags, "harness") ?? "agy").toLowerCase();
	const raw = await readStdinText();
	let payload: Record<string, unknown> = {};
	if (raw) {
		try {
			payload = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// empty payload
		}
	}

	const config = loadClueConfig(getFlagStr(flags, "home"));
	const paths = ensureClueStorage(config);
	noteHarnessSeen(paths, harness);
	const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
	const cwd = String(payload.cwd ?? workspacePaths[0] ?? getFlagStr(flags, "cwd") ?? process.cwd()) || process.cwd();

	if (sub === "session-start") {
		const snap = buildBootSnapshot(config, paths, cwd);
		console.log(
			JSON.stringify(harness === "agy" ? formatAgySessionStart(snap) : formatClaudeHookOutput("SessionStart", snap.block)),
		);
		return;
	}

	if (sub !== "prompt") fail(`Unknown hook subcommand: ${sub}`);

	// AGY fires PreInvocation before every model call in a turn; only the first one carries the user turn.
	if (harness === "agy" && typeof payload.invocationNum === "number" && payload.invocationNum > 1) {
		console.log("{}");
		return;
	}
	const extra = (payload.extra && typeof payload.extra === "object" ? payload.extra : {}) as Record<string, unknown>;
	const promptText = String(payload.lastUserInput ?? payload.prompt ?? payload.userPrompt ?? extra.user_message ?? "");
	const convId = String(payload.conversationId ?? payload.session_id ?? payload.sessionId ?? "");
	const scope = convId ? `${harness}:${convId}` : "";

	const blocks: string[] = [];
	let sessionStart = new Date().toISOString();
	if (scope) {
		const st = readHookState<{ ts: string }>("start", scope);
		if (st?.ts) sessionStart = st.ts;
		else writeHookState("start", scope, { ts: sessionStart });
		// Harnesses without a SessionStart hook (Codex, Hermes, OpenCode) get the boot block on the first turn.
		if (getFlagBool(flags, "with-boot") && !st?.ts) blocks.push(buildBootSnapshot(config, paths, cwd).block);
	}

	// AGY/Hermes may call the prompt hook repeatedly for the same user turn.
	let duplicate = false;
	if ((harness === "agy" || harness === "hermes") && scope && promptText.trim()) {
		const fp = createHash("sha1").update(`${String(payload.initialNumSteps ?? "")}:${promptText}`).digest("hex");
		duplicate = readHookState<{ fp: string }>("turn", scope)?.fp === fp;
		if (!duplicate) writeHookState("turn", scope, { fp });
	}

	if (!duplicate) {
		const shown = new Set(scope ? (readHookState<{ keys: string[] }>("fb", scope)?.keys ?? []) : []);
		const notice = buildTurnNotice(config, paths, promptText, cwd, {
			sessionRef: scope || undefined,
			viewedKeys: [...shown, ...lookedUpSince(paths, sessionStart)],
		});
		if (notice) {
			blocks.push(notice);
		} else if (config.autoRecall && promptText.trim()) {
			const fb = buildProactiveFlashback(
				config,
				paths,
				promptText,
				resolveProjectKey(cwd, config.workspaceRoots),
				shown,
				convId || undefined,
			);
			if (fb.notice) {
				blocks.push(fb.notice);
				if (scope) {
					for (const item of fb.items) shown.add(item.key);
					writeHookState("fb", scope, { keys: [...shown].slice(-64) });
				}
			}
		}
	}

	const combined = blocks.length > 0 ? blocks.join("\n\n") : null;
	if (harness === "agy") console.log(JSON.stringify(formatAgyPreInvocation(combined)));
	else if (harness === "hermes" || harness === "opencode") console.log(JSON.stringify(combined ? { context: combined } : {}));
	else console.log(JSON.stringify(formatClaudeHookOutput("UserPromptSubmit", combined)));
}

function parseJsonInput<T>(raw: string, usage: string): T {
	if (!raw) fail(usage);
	try {
		return JSON.parse(raw) as T;
	} catch (e) {
		fail(`stdin JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
	}
}

async function main(): Promise<void> {
	const { positionals, flags } = parseArgs(process.argv.slice(2));
	const cmd = positionals[0];

	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || getFlagBool(flags, "help")) {
		printHelp();
		return;
	}
	if (cmd === "version" || cmd === "--version") {
		console.log(`clue ${VERSION}`);
		return;
	}
	if (cmd === "hook") {
		await runHookCommand(positionals[1] ?? "", flags);
		return;
	}
	if (cmd === "install") {
		const all = getFlagBool(flags, "all") || positionals[1] === "all";
		const targets: InstallTarget[] = all
			? inspectHarnessAdapters()
					.filter(a => a.detected)
					.map(a => a.harness)
			: [positionals[1]?.toLowerCase() as InstallTarget];
		if (targets.some(t => !ADAPTER_TARGETS.includes(t))) {
			fail(`Usage: clue install <${ADAPTER_TARGETS.join("|")}|--all> [--bin <path>] [--dry-run]`);
		}
		const dryRun = getFlagBool(flags, "dry-run");
		for (const target of targets) {
			const res = installHarnessAdapter({ target, clueBin: getFlagStr(flags, "bin"), dryRun });
			console.log(`${dryRun ? "[DRY-RUN] " : ""}✅ ${res.target}:`);
			for (const c of res.changes) console.log(`  - ${c}`);
			for (const n of res.notes) console.log(`  ${n.replaceAll("\n", "\n  ")}`);
		}
		if (targets.length === 0) console.log("没有检测到已安装的 harness。");
		return;
	}

	const config = loadClueConfig(getFlagStr(flags, "home"));
	const paths = ensureClueStorage(config);
	const cwd = getFlagStr(flags, "cwd") ?? process.cwd();
	const projectKey = getFlagStr(flags, "project")?.trim().toLowerCase() || resolveProjectKey(cwd, config.workspaceRoots);
	const invoker = detectInvoker();
	const json = getFlagBool(flags, "json");

	const submitDraft = (kind: DraftKind, request: Record<string, unknown>) => {
		// Untyped stdin JSON: the draft planner validates every field (same check runs again at apply time).
		const typed = request as Parameters<typeof addDraft>[3];
		const res = addDraft(config, paths, kind, typed, {
			projectKey,
			harness: invoker.harness,
			session: invoker.session,
			skipSlots: skippedIntentSlots(config, cwd),
		});
		if (!res.ok) fail(res.message);
		console.log(res.message);
	};
	const draft = async (kind: DraftKind, usage: string) =>
		submitDraft(kind, parseJsonInput<Record<string, unknown>>(await readStdinText(), usage));

	switch (cmd) {
		case "boot": {
			const snap = buildBootSnapshot(config, paths, cwd);
			const fmt = (getFlagStr(flags, "format") ?? "text").toLowerCase();
			if (fmt === "agy") console.log(JSON.stringify(formatAgySessionStart(snap)));
			else if (fmt === "claude") console.log(JSON.stringify(formatClaudeHookOutput("SessionStart", snap.block)));
			else if (fmt === "json") console.log(JSON.stringify(snap, null, 2));
			else console.log(snap.block);
			return;
		}

		case "view": {
			const view = readHotMemoryView(config, paths, projectKey);
			console.log(json ? JSON.stringify({ projectKey, ...view }, null, 2) : view.formatted);
			return;
		}

		case "status": {
			const view = readHotMemoryView(config, paths, projectKey);
			const health = evaluateMemoryHealth(config, paths, projectKey);
			const tampering = detectUnauthorizedChanges(paths.home);
			const intentCard = getProjectIntent(paths.intentsPath, projectKey);
			const drafts = readDrafts(paths);
			const commits = getRecentMemoryCommits(paths.home, 4);
			if (json) {
				console.log(JSON.stringify({ home: paths.home, projectKey, health, tampering, intentCard, drafts, commits }, null, 2));
				return;
			}
			const m = health.metrics;
			const projPct = Math.round((view.scoped.projectChars / config.limits.singleProjectChars) * 100);
			console.log(
				[
					`📚 clue 个人记忆状态（${paths.home}）`,
					...(tampering.dirty ? [`⚠️ 有绕过 clue 的改动：${tampering.files.join(", ")}（clue restore 丢弃 / clue accept 保留）`] : []),
					`- PROFILE.md：${m.profileChars} / ${m.profileLimit} 字 (${m.profilePct}%)`,
					`- PROJECTS.md：全局 ${m.globalChars} / ${m.globalLimit} 字 (${m.globalPct}%) | 当前项目 (${projectKey ?? "无"}) ${view.scoped.projectChars} / ${config.limits.singleProjectChars} 字 (${projPct}%)`,
					`- 意图卡 (${projectKey ?? "无"})：${intentCard ? `更新于 ${intentCard.updatedAt.slice(0, 16)}` : "尚未建立"}`,
					...(intentCard ? formatIntentCard(intentCard).split("\n").map(l => `  ${l}`) : []),
					`- 活跃记忆：${LEDGER_KINDS.map(k => `${ledgerLabel(k)} ${m.active[k]} 条`).join(" | ")}（缺溯源 ${m.withoutEvidence} 条，主动查阅 ${m.totalHits} 次）`,
					`- 待确认草稿：${drafts.length} 条`,
					`- 健康：${health.status === "healthy" ? "健康" : `需留意（${health.reasons.join("；")}）`}`,
					`- 最近提交：`,
					...(commits.length > 0 ? commits.map(c => `  ${c}`) : ["  (暂无)"]),
				].join("\n"),
			);
			return;
		}

		case "search": {
			const query = positionals.slice(1).join(" ").trim();
			const limRaw = Number.parseInt(getFlagStr(flags, "limit") ?? "4", 10);
			const limit = Math.max(1, Math.min(10, Number.isFinite(limRaw) ? limRaw : 4));
			const includeInactive = getFlagBool(flags, "all");
			const type = (getFlagStr(flags, "type") ?? "all").toLowerCase();
			const want = (k: string) => type === "all" || type === k;
			const decisions = want("decision") ? searchLedger<DecisionRow>(paths, "decision", query, projectKey, limit, includeInactive) : [];
			const pitfalls = want("pitfall") ? searchLedger<PitfallRow>(paths, "pitfall", query, projectKey, limit, includeInactive) : [];
			const notes = want("note") ? searchLedger<NoteRow>(paths, "note", query, projectKey, limit, includeInactive) : [];
			// Explicit lookups are the only thing that counts as a "hit" (usefulness signal for cold-item audits).
			if (query) {
				recordHits(paths, [
					...decisions.map(r => `decision:${r.id}`),
					...pitfalls.map(r => `pitfall:${r.id}`),
					...notes.map(r => `note:${r.id}`),
				]);
			}
			if (json) {
				console.log(JSON.stringify({ query, project: projectKey, decisions, pitfalls, notes }, null, 2));
				return;
			}
			const parts = [
				...(decisions.length ? [formatDecisionGuidance(decisions)] : []),
				...(pitfalls.length ? [formatPitfallGuidance(pitfalls)] : []),
				...(notes.length ? [formatNoteGuidance(notes)] : []),
			];
			console.log(parts.length > 0 ? parts.join("\n\n") : "未检索到匹配的记忆（可换几种说法用 | 分隔再查）。");
			return;
		}

		case "intent": {
			const raw = await readStdinText();
			if (!raw) {
				const res = mutateProjectIntent(config, paths, { op: "view", project: projectKey ?? undefined }, projectKey);
				console.log(res.message);
				return;
			}
			return submitDraft("intent", parseJsonInput<Record<string, unknown>>(raw, ""));
		}

		case "note":
			return draft("note", 'clue note 需要 stdin JSON，例如：{"op":"add","content":"...","tags":"别名1, 别名2","evidence":"..."}');
		case "pitfall":
			return draft(
				"pitfall",
				'clue pitfall 需要 stdin JSON，例如：{"op":"add","symptom":"...","rootCause":"...","historicalFix":"...","rethinkHint":"...","tags":"...","evidence":"..."}',
			);
		case "decision":
			return draft(
				"decision",
				'clue decision 需要 stdin JSON，例如：{"op":"add","topic":"...","decision":"...","rationale":"...","assumptions":"...","revisitWhen":"...","evidence":"..."}',
			);
		case "curate": {
			const req = parseJsonInput<Record<string, unknown>>(
				await readStdinText(),
				'clue curate 需要 stdin JSON，例如：{"target":"profile","scope":"技术底座","operations":[...]}',
			);
			if (req.target !== "profile" && req.target !== "projects") fail('curate 的 target 必须是 "profile" 或 "projects"。');
			return submitDraft(req.target, req);
		}

		case "drafts":
			console.log(json ? JSON.stringify(readDrafts(paths), null, 2) : formatDraftList(readDrafts(paths)));
			return;

		case "apply": {
			const selector = positionals.slice(1).join(" ");
			if (!selector.trim()) fail("用法：clue apply <编号...|all>（只写入用户已确认的草稿）");
			const res = applyDrafts(config, paths, selector, invoker);
			if (!res.ok) fail(res.message);
			console.log(res.message);
			return;
		}

		case "drop": {
			const selector = positionals.slice(1).join(" ");
			if (!selector.trim()) fail("用法：clue drop <编号...|all>");
			const res = dropDrafts(paths, selector);
			if (!res.ok) fail(res.message);
			console.log(res.message);
			return;
		}

		case "wrap": {
			const notice = buildTurnNotice(config, paths, "收尾", cwd, {});
			console.log(notice ?? (isWorkerRole() ? "只读执行窗格不执行收尾。" : "（无收尾内容）"));
			return;
		}

		case "index": {
			const summary = indexRecallSessions(paths.recallDbPath, {
				harness: getFlagStr(flags, "harness")?.toLowerCase() as RecallHarness | undefined,
				rebuild: getFlagBool(flags, "rebuild"),
				lockPath: paths.recallLockPath,
				worktreeSuffixes: config.worktreeSuffixes,
				workspaceRoots: config.workspaceRoots,
			});
			if (json) {
				console.log(JSON.stringify(summary, null, 2));
				return;
			}
			if (!getFlagBool(flags, "quiet")) {
				console.log(
					`✅ clue 索引完成（${summary.elapsedMs}ms）：扫描 ${summary.scannedFiles} 项，更新 ${summary.indexedSessions} 会话（${summary.indexedMessages} 条消息），跳过未变更 ${summary.skippedUnchanged} 项。`,
				);
				for (const [h, st] of Object.entries(summary.byHarness)) console.log(`  - ${h}: ${st.sessions} sessions, ${st.messages} messages`);
			}
			return;
		}

		case "sources": {
			const rows = getRecallSources(paths.recallDbPath);
			if (json) {
				console.log(JSON.stringify({ recallDbPath: paths.recallDbPath, sources: rows }, null, 2));
				return;
			}
			if (rows.length === 0) {
				console.log("尚未建立会话索引，请先运行 `clue index`。");
				return;
			}
			console.log(`📚 clue 跨 Harness 原始会话索引（${paths.recallDbPath}）：`);
			for (const r of rows) {
				console.log(
					`  - ${r.harness.padEnd(9)} ${String(r.sessions).padStart(5)} sessions | ${String(r.messages).padStart(7)} msgs | 最新: ${r.latestUpdated.slice(0, 19)}`,
				);
			}
			return;
		}

		case "recall": {
			const harnessFlag = getFlagStr(flags, "harness")?.toLowerCase() as RecallHarness | undefined;
			if (!getFlagBool(flags, "no-refresh")) {
				indexRecallSessions(paths.recallDbPath, {
					harness: harnessFlag,
					lockPath: paths.recallLockPath,
					worktreeSuffixes: config.worktreeSuffixes,
					workspaceRoots: config.workspaceRoots,
				});
			}
			const query = positionals.slice(1).join(" ").trim();
			const limRaw = Number.parseInt(getFlagStr(flags, "limit") ?? "8", 10);
			const roleFlag = getFlagStr(flags, "role")?.toLowerCase();
			const hits = recallSessions(paths.recallDbPath, {
				query,
				harness: harnessFlag,
				project: getFlagStr(flags, "project")?.trim().toLowerCase() ?? projectKey,
				role: roleFlag === "user" || roleFlag === "assistant" ? roleFlag : undefined,
				since: getFlagStr(flags, "since"),
				limit: Math.max(1, Math.min(30, Number.isFinite(limRaw) ? limRaw : 8)),
				includeNoise: getFlagBool(flags, "all"),
			});
			if (json) {
				console.log(JSON.stringify({ query, count: hits.length, hits }, null, 2));
				return;
			}
			if (hits.length === 0) {
				console.log(`未检索到匹配 "${query}" 的历史原始对话（可换近义词重试，或检查 \`clue sources\`）。`);
				return;
			}
			console.log(`🔎 clue 历史会话召回（命中 ${hits.length} 条；可用 \`clue show <id> --around <seq>\` 展开前后文）：\n`);
			for (const h of hits) {
				const shortId = h.sessionId.length > 26 ? h.sessionId.slice(0, 26) : h.sessionId;
				console.log(
					`[${shortId} | ${h.harness} | proj=${h.project} | #${h.seq} ${h.role} | ${h.ts.slice(0, 10)}${h.isNoise ? " | low-priority" : ""}]`,
				);
				console.log(`  标题: ${h.title}`);
				console.log(`  原话: ${h.snippet}\n`);
			}
			return;
		}

		case "show": {
			const idPrefix = positionals[1]?.trim() ?? "";
			if (!idPrefix) fail("用法：clue show <session-id-prefix> [--around <seq>] [--window 4] [--full]");
			if (!getFlagBool(flags, "no-refresh")) {
				// The conversation being inspected may be the current one, so pick up its latest messages first.
				indexRecallSessions(paths.recallDbPath, {
					lockPath: paths.recallLockPath,
					worktreeSuffixes: config.worktreeSuffixes,
					workspaceRoots: config.workspaceRoots,
				});
			}
			const num = (k: string) => (getFlagStr(flags, k) ? Number.parseInt(getFlagStr(flags, k)!, 10) : undefined);
			const res = showSessionWindow(paths.recallDbPath, {
				idPrefix,
				around: num("around"),
				window: num("window"),
				offset: num("offset"),
				limit: num("limit"),
				full: getFlagBool(flags, "full"),
			});
			if (!res.ok) fail(res.message);
			console.log(json ? JSON.stringify({ session: res.session, messages: res.messages }, null, 2) : res.message);
			return;
		}

		case "dream": {
			if (getFlagBool(flags, "mark-done")) {
				const meta = markDreamDone(paths, getFlagStr(flags, "summary"));
				console.log(`已记录本次记忆体检完成时间：${meta.lastDreamAt}`);
				return;
			}
			console.log(
				json ? JSON.stringify(evaluateMemoryHealth(config, paths, projectKey, cwd), null, 2) : buildDreamPacket(config, paths, projectKey, cwd),
			);
			return;
		}

		case "export": {
			const bundle = buildWebExportBundle(config, paths, projectKey);
			console.log(json ? JSON.stringify(bundle, null, 2) : bundle.text);
			return;
		}

		case "log": {
			const lim = Number.parseInt(getFlagStr(flags, "limit") ?? "10", 10);
			const commits = getRecentMemoryCommits(paths.home, Number.isFinite(lim) ? lim : 10);
			console.log(commits.length > 0 ? commits.join("\n") : "(暂无 Git 提交记录)");
			return;
		}

		case "undo": {
			if (isWorkerRole()) fail("只读执行窗格不能撤回记忆。");
			const res = undoLastMemoryCommit(paths.home, {
				guardedFiles: getReadOnlyGuardedFiles(paths),
				restoreReadOnly: config.readOnlyGuard,
			});
			if (!res.ok) fail(res.message);
			console.log(res.message);
			return;
		}

		case "restore": {
			if (isWorkerRole()) fail("只读执行窗格不能修改记忆。");
			const res = restoreTruthFiles(paths.home, config.readOnlyGuard);
			if (!res.ok) fail(res.message);
			console.log(res.message);
			return;
		}

		case "accept": {
			if (isWorkerRole()) fail("只读执行窗格不能修改记忆。");
			const res = acceptManualEdits(paths.home, positionals.slice(1).join(" "), config.readOnlyGuard);
			if (!res.ok) fail(res.message);
			console.log(res.message);
			return;
		}

		case "unlock": {
			const unlocked = unlockFilesWritable(getReadOnlyGuardedFiles(paths));
			console.log(`🔓 已解锁 ${unlocked.length} 个记忆文件。手改完后运行 \`clue accept "<原因>"\` 提交，或 \`clue restore\` 放弃。`);
			return;
		}

		case "lock": {
			const locked = lockFilesReadOnly(getReadOnlyGuardedFiles(paths));
			console.log(`🔒 已把 ${locked.length} 个记忆文件设为只读。`);
			return;
		}

		case "doctor": {
			const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
			checks.push({ name: "CLUE_HOME", ok: existsSync(paths.home), detail: paths.home });
			checks.push({ name: "Git repo", ok: existsSync(join(paths.home, ".git")), detail: join(paths.home, ".git") });
			const tampering = detectUnauthorizedChanges(paths.home);
			checks.push({
				name: "Integrity",
				ok: !tampering.dirty,
				detail: tampering.dirty ? `edited outside clue: ${tampering.files.join(", ")}` : "clean",
			});
			for (const kind of LEDGER_KINDS) {
				const file = ledgerFile(paths, kind);
				const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(l => l.trim()).length : 0;
				const parsed = readLedger(paths, kind).length;
				checks.push({
					name: `${kind}s.jsonl`,
					ok: lines === parsed,
					detail: `${parsed} rows (${listActive(paths, kind).length} active)${lines !== parsed ? `, ${lines - parsed} unreadable lines` : ""}`,
				});
			}
			checks.push({ name: "Drafts", ok: true, detail: `${readDrafts(paths).length} pending` });
			const adapters = getFlagBool(flags, "adapters") ? inspectHarnessAdapters() : undefined;
			if (json) {
				console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks, ...(adapters ? { adapters } : {}) }, null, 2));
			} else {
				for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
				if (adapters) {
					console.log("\n🔌 Harness 接入：");
					for (const a of adapters) {
						const icon = !a.detected ? "⚪" : a.hookWired ? "✅" : "⚠️";
						console.log(`  ${icon} ${a.harness.padEnd(9)} ${a.detail}`);
					}
				}
			}
			if (!checks.every(c => c.ok)) process.exit(1);
			return;
		}

		default:
			fail(`未知命令：${cmd}。运行 \`clue help\` 查看用法。`);
	}
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
