#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBootSnapshot,
	buildDreamPacket,
	buildProactiveFlashback,
	buildTurnNotice,
	checkRawEditGuard,
	curateHotMemory,
	detectUnauthorizedChanges,
	ensureClueStorage,
	evaluateMemoryHealth,
	formatAgyPreInvocation,
	formatAgySessionStart,
	formatClaudeHookOutput,
	formatDecisionGuidance,
	formatIntentCard,
	formatPitfallGuidance,
	getProjectIntent,
	getReadOnlyGuardedFiles,
	getRecentMemoryCommits,
	listActiveDecisions,
	listActivePitfalls,
	loadClueConfig,
	lockFilesReadOnly,
	markDreamDone,
	mutateDecision,
	mutatePitfall,
	mutateProjectIntent,
	openDecisionDb,
	openPitfallDb,
	readHotMemoryView,
	resolveProjectKey,
	searchDecisions,
	searchPitfalls,
	undoLastMemoryCommit,
	unlockFilesWritable,
	type CurateRequest,
	type DecisionMutationRequest,
	type IntentMutationRequest,
	type PitfallMutationRequest,
} from "./core/index.ts";
import {
	getRecallSources,
	indexRecallSessions,
	recallSessions,
	showSessionWindow,
	type RecallHarness,
} from "./recall/index.ts";
import { inspectHarnessAdapters, installHarnessAdapter, type InstallTarget } from "./adapters/install.ts";

const VERSION = "0.4";

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

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupStaleDedupFiles(dir: string): void {
	try {
		const now = Date.now();
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const full = join(dir, name);
			try {
				const st = statSync(full);
				if (now - st.mtimeMs > DEDUP_TTL_MS) {
					rmSync(full, { force: true });
				}
			} catch {
				// ignore individual file errors
			}
		}
	} catch {
		// ignore
	}
}

function wasHookTurnSeen(scopeKey: string, turnFingerprint: string): boolean {
	try {
		const dir = join(tmpdir(), "clue-hook-dedup");
		mkdirSync(dir, { recursive: true });
		if (Math.random() < 0.05) {
			cleanupStaleDedupFiles(dir);
		}
		const file = join(dir, `${createHash("sha1").update(scopeKey).digest("hex").slice(0, 16)}.json`);
		if (existsSync(file)) {
			const prev = JSON.parse(readFileSync(file, "utf8")) as { fp?: string };
			if (prev.fp === turnFingerprint) return true;
		}
		writeFileSync(file, JSON.stringify({ fp: turnFingerprint, ts: Date.now() }), "utf8");
	} catch {
		// Never fail hook execution because of temp dir issues
	}
	return false;
}

function readShownFlashbackKeys(scopeKey: string): Set<string> {
	try {
		const dir = join(tmpdir(), "clue-hook-dedup");
		const file = join(dir, `fb-${createHash("sha1").update(scopeKey).digest("hex").slice(0, 16)}.json`);
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { keys?: string[] };
			if (Array.isArray(parsed.keys)) return new Set(parsed.keys);
		}
	} catch {
		// ignore
	}
	return new Set();
}

function saveShownFlashbackKeys(scopeKey: string, keys: ReadonlySet<string>): void {
	try {
		const dir = join(tmpdir(), "clue-hook-dedup");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `fb-${createHash("sha1").update(scopeKey).digest("hex").slice(0, 16)}.json`);
		writeFileSync(file, JSON.stringify({ keys: [...keys].slice(-64), ts: Date.now() }), "utf8");
	} catch {
		// ignore
	}
}

function printHelp(): void {
	console.log(`clue v${VERSION} — Local-first, bounded, anti-anchoring personal memory CLI

Usage:
  clue boot [--cwd <dir>] [--format text|agy|claude|json]
  clue view [--cwd <dir>] [--json]
  clue status [--cwd <dir>] [--json]
  clue search [query] [--type all|pitfall|decision] [--project <key>] [--limit <1-10>] [--all] [--json]
  clue intent [--project <key>] [--dry-run]      (view card, or stdin JSON to update 4 slots)
  clue decision [--cwd <dir>]                    (reads JSON payload from stdin)
  clue recall [query] [--harness <name>] [--project <key>] [--role user|assistant] [--since 30d] [--limit 8] [--no-refresh] [--json]
  clue show <id-prefix> [--around <seq>] [--window 4] [--offset 0] [--limit 12] [--full] [--json]
  clue index [--harness <name>] [--rebuild] [--quiet] [--json]
  clue sources [--json]
  clue curate [--dry-run] [--cwd <dir>]          (reads JSON payload from stdin)
  clue pitfall [--cwd <dir>]                     (reads JSON payload from stdin)
  clue dream [--cwd <dir>] [--mark-done] [--summary <text>] [--json]
  clue log [--limit <n>]
  clue undo
  clue lock / unlock
  clue doctor [--adapters] [--json]
  clue install <agy|claude|codex|hermes> [--bin <path>] [--dry-run]
  clue hook <session-start|prompt|guard> --harness <agy|claude|codex|hermes> [--with-boot]
  clue version

Environment:
  CLUE_HOME    Path to memory data directory (default: ~/.clue)`);
}

async function runHookCommand(sub: string, flags: Record<string, string | boolean>): Promise<void> {
	const harness = (getFlagStr(flags, "harness") ?? "agy").toLowerCase();
	const raw = await readStdinText();
	let payload: Record<string, unknown> = {};
	if (raw) {
		try {
			payload = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// Fall back cleanly to empty object
		}
	}

	const config = loadClueConfig(getFlagStr(flags, "home"));
	const paths = ensureClueStorage(config);

	const workspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
	const cwd =
		String(
			payload.cwd ??
				workspacePaths[0] ??
				getFlagStr(flags, "cwd") ??
				process.cwd(),
		) || process.cwd();

	if (sub === "session-start") {
		const snap = buildBootSnapshot(config, paths, cwd);
		if (harness === "agy") {
			console.log(JSON.stringify(formatAgySessionStart(snap)));
		} else {
			console.log(JSON.stringify(formatClaudeHookOutput("SessionStart", snap.block)));
		}
		return;
	}

	if (sub === "prompt") {
		// In AGY, PreInvocation fires before EVERY model call in a turn; only trigger on first invocation of the turn
		if (harness === "agy" && typeof payload.invocationNum === "number" && payload.invocationNum > 1) {
			console.log("{}");
			return;
		}

		const extra = (payload.extra && typeof payload.extra === "object" ? payload.extra : {}) as Record<string, unknown>;
		const promptText = String(payload.lastUserInput ?? payload.prompt ?? payload.userPrompt ?? extra.user_message ?? "");
		const convId = String(payload.conversationId ?? payload.session_id ?? payload.sessionId ?? "");
		const initialNumSteps = String(payload.initialNumSteps ?? "");

		const blocks: string[] = [];

		// Optional first-turn boot injection for harnesses without a dedicated SessionStart hook (e.g. Codex, Hermes)
		if (getFlagBool(flags, "with-boot") && convId) {
			const bootAlreadySent = wasHookTurnSeen(`boot:${harness}:${convId}`, "booted");
			if (!bootAlreadySent) {
				blocks.push(buildBootSnapshot(config, paths, cwd).block);
			}
		}

		let notice = buildTurnNotice(config, paths, promptText, cwd);
		if (notice && (harness === "agy" || harness === "hermes") && convId) {
			const fp = createHash("sha1").update(`${initialNumSteps}:${promptText}`).digest("hex");
			if (wasHookTurnSeen(`prompt:${harness}:${convId}`, fp)) {
				notice = null;
			}
		}
		if (notice) blocks.push(notice);

		// Pure-local (<15ms) high-confidence flashback for ordinary technical turns (deduplicated per session)
		if (!notice && config.autoRecall && promptText.trim()) {
			const projKey = resolveProjectKey(cwd, config.workspaceRoots);
			const fbScope = convId ? `fb:${harness}:${convId}` : "";
			const shown = fbScope ? readShownFlashbackKeys(fbScope) : new Set<string>();
			const fb = buildProactiveFlashback(config, paths, promptText, projKey, shown, convId || undefined);
			if (fb.notice) {
				blocks.push(fb.notice);
				if (fbScope) {
					for (const item of fb.items) shown.add(item.key);
					saveShownFlashbackKeys(fbScope, shown);
				}
			}
		}

		const combined = blocks.length > 0 ? blocks.join("\n\n") : null;
		if (harness === "agy") {
			console.log(JSON.stringify(formatAgyPreInvocation(combined)));
		} else if (harness === "hermes") {
			console.log(JSON.stringify(combined ? { context: combined } : {}));
		} else {
			console.log(JSON.stringify(formatClaudeHookOutput("UserPromptSubmit", combined)));
		}
		return;
	}

	if (sub === "guard") {
		const toolCall = (payload.toolCall ?? {}) as Record<string, unknown>;
		const toolName = String(toolCall.name ?? payload.tool_name ?? payload.toolName ?? "");
		const toolArgs = (toolCall.args ?? payload.tool_input ?? payload.toolInput ?? {}) as Record<string, unknown>;
		const verdict = checkRawEditGuard(paths, toolName, toolArgs);

		if (harness === "agy") {
			if (verdict.blocked) {
				console.log(JSON.stringify({ decision: "deny", reason: verdict.reason }));
			} else {
				console.log(JSON.stringify({ decision: "allow" }));
			}
			return;
		}

		if (harness === "hermes") {
			if (verdict.blocked) {
				console.log(JSON.stringify({ action: "block", message: verdict.reason }));
			} else {
				console.log("{}");
			}
			return;
		}

		// Claude Code / Codex PreToolUse contract
		if (verdict.blocked) {
			console.log(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: verdict.reason,
					},
				}),
			);
		} else {
			console.log("{}");
		}
		return;
	}

	console.error(`Unknown hook subcommand: ${sub}`);
	process.exit(1);
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
		const rawTarget = (positionals[1] ?? "").toLowerCase();
		const validTargets: InstallTarget[] = ["agy", "claude", "codex", "hermes"];
		if (!validTargets.includes(rawTarget as InstallTarget)) {
			console.error(`Usage: clue install <${validTargets.join("|")}> [--bin <path>] [--dry-run]`);
			process.exit(1);
		}
		const res = installHarnessAdapter({
			target: rawTarget as InstallTarget,
			clueBin: getFlagStr(flags, "bin"),
			dryRun: getFlagBool(flags, "dry-run"),
		});
		const prefix = getFlagBool(flags, "dry-run") ? "[DRY-RUN] " : "";
		console.log(`${prefix}✅ Installed clue adapter for ${res.target}:`);
		for (const c of res.changes) console.log(`  - ${c}`);
		for (const n of res.notes) console.log(`\n${n}`);
		return;
	}

	const config = loadClueConfig(getFlagStr(flags, "home"));
	const paths = ensureClueStorage(config);
	const cwd = getFlagStr(flags, "cwd") ?? process.cwd();
	const projectKey = getFlagStr(flags, "project")?.trim().toLowerCase() || resolveProjectKey(cwd, config.workspaceRoots);

	if (cmd === "boot") {
		const snap = buildBootSnapshot(config, paths, cwd);
		const fmt = (getFlagStr(flags, "format") ?? "text").toLowerCase();
		if (fmt === "agy") {
			console.log(JSON.stringify(formatAgySessionStart(snap)));
		} else if (fmt === "claude") {
			console.log(JSON.stringify(formatClaudeHookOutput("SessionStart", snap.block)));
		} else if (fmt === "json") {
			console.log(JSON.stringify(snap, null, 2));
		} else {
			console.log(snap.block);
		}
		return;
	}

	if (cmd === "view") {
		const view = readHotMemoryView(config, paths, projectKey);
		if (getFlagBool(flags, "json")) {
			console.log(JSON.stringify({ projectKey, ...view }, null, 2));
		} else {
			console.log(view.formatted);
		}
		return;
	}

	if (cmd === "status") {
		const view = readHotMemoryView(config, paths, projectKey);
		const health = evaluateMemoryHealth(config, paths, projectKey);
		const tampering = detectUnauthorizedChanges(paths.home);
		const intentCard = getProjectIntent(paths.intentsPath, projectKey);
		const allActivePitfalls = listActivePitfalls(paths.dbPath);
		const allActiveDecisions = listActiveDecisions(paths.dbPath);
		const pitfalls = searchPitfalls(paths.dbPath, positionals.slice(1).join(" "), projectKey, 5, false);
		const decisions = searchDecisions(paths.dbPath, positionals.slice(1).join(" "), projectKey, 5, false);
		const commits = getRecentMemoryCommits(paths.home, 4);
		const totalHits =
			allActivePitfalls.reduce((acc, p) => acc + (p.hit_count || 0), 0) +
			allActiveDecisions.reduce((acc, d) => acc + (d.hit_count || 0), 0);
		if (getFlagBool(flags, "json")) {
			console.log(
				JSON.stringify(
					{
						home: paths.home,
						projectKey,
						health,
						tampering,
						intentCard,
						totalHits,
						recentDecisions: decisions,
						recentPitfalls: pitfalls,
						commits,
					},
					null,
					2,
				),
			);
			return;
		}
		const m = health.metrics;
		const projPct = Math.round((view.scoped.projectChars / config.limits.singleProjectChars) * 100);
		const lines = [
			`📚 clue 个人记忆状态（数据目录：${paths.home}）`,
			...(tampering.dirty
				? [`⚠️ 完整性警报：检测到绕过 clue 的未提交修改（${tampering.files.join(", ")}），请核对 git diff！`]
				: []),
			`- PROFILE.md：${m.profileChars} / ${m.profileLimit} 字 (${m.profilePct}%)`,
			`- PROJECTS.md：全局 ${m.globalChars} / ${m.globalLimit} 字 (${m.globalPct}%) | 当前项目 (${projectKey ?? "无"}) ${view.scoped.projectChars} / ${config.limits.singleProjectChars} 字 (${projPct}%)`,
			`- 项目 4 格意图卡 (${projectKey ?? "无"})：${intentCard ? `已建立（更新于 ${intentCard.updatedAt.slice(0, 16)}）` : "尚未建立"}`,
			...(intentCard ? formatIntentCard(intentCard).split("\n").map(l => `  ${l}`) : []),
			`- 活跃记忆：踩坑 ${allActivePitfalls.length} 条（缺溯源 ${m.pitfallsWithoutEvidence} 条） | 关键决定 ${allActiveDecisions.length} 条 | 累计自动闪回命中 ${totalHits} 次`,
			`- 健康状态：${health.status === "healthy" ? "健康" : `需留意（${health.reasons.join("；")}）`}`,
			`- 最近关键决定：`,
			...(decisions.length > 0
				? decisions.map(
						d =>
							`  • #${d.id} [${d.project}] ${d.decision}${d.hit_count > 0 ? ` (命中 ${d.hit_count} 次)` : ""}${d.evidence ? `（溯源: ${d.evidence}）` : ""}`,
					)
				: ["  • (暂无记录)"]),
			`- 最近踩坑线索：`,
			...(pitfalls.length > 0
				? pitfalls.map(
						p =>
							`  • #${p.id} [${p.project}] ${p.symptom} → 根因：${p.root_cause}${p.hit_count > 0 ? ` (命中 ${p.hit_count} 次)` : ""}${p.evidence ? `（溯源: ${p.evidence}）` : ""}`,
					)
				: ["  • (暂无记录)"]),
			`- 最近版本记录：`,
			...(commits.length > 0 ? commits.map(c => `  ${c}`) : ["  (暂无提交)"]),
		];
		console.log(lines.join("\n"));
		return;
	}

	if (cmd === "search") {
		const query = positionals.slice(1).join(" ").trim();
		const limRaw = Number.parseInt(getFlagStr(flags, "limit") ?? "4", 10);
		const limit = Math.max(1, Math.min(10, Number.isFinite(limRaw) ? limRaw : 4));
		const includeInactive = getFlagBool(flags, "all");
		const searchType = (getFlagStr(flags, "type") ?? "all").toLowerCase();
		const pitfallRows =
			searchType === "decision" ? [] : searchPitfalls(paths.dbPath, query, projectKey, limit, includeInactive);
		const decisionRows =
			searchType === "pitfall" ? [] : searchDecisions(paths.dbPath, query, projectKey, limit, includeInactive);
		if (getFlagBool(flags, "json")) {
			console.log(
				JSON.stringify(
					{
						query,
						project: projectKey,
						type: searchType,
						pitfalls: pitfallRows,
						decisions: decisionRows,
						count: pitfallRows.length + decisionRows.length,
						rows: pitfallRows,
					},
					null,
					2,
				),
			);
		} else {
			const parts: string[] = [];
			if (searchType !== "pitfall" && decisionRows.length > 0) {
				parts.push(formatDecisionGuidance(decisionRows));
			}
			if (searchType !== "decision" && pitfallRows.length > 0) {
				parts.push(formatPitfallGuidance(pitfallRows));
			}
			console.log(parts.length > 0 ? parts.join("\n\n") : "未检索到匹配的历史踩坑或关键决定。");
		}
		return;
	}

	if (cmd === "intent") {
		const raw = await readStdinText();
		let req: IntentMutationRequest;
		if (!raw) {
			req = { op: "view", project: getFlagStr(flags, "project") ?? projectKey ?? undefined };
		} else {
			try {
				req = JSON.parse(raw) as IntentMutationRequest;
			} catch (e) {
				console.error(`stdin JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
				process.exit(1);
			}
		}
		if (getFlagBool(flags, "dry-run")) req.dryRun = true;
		const res = mutateProjectIntent(config, paths, req, projectKey);
		if (!res.ok) {
			console.error(res.message);
			process.exit(1);
		}
		console.log(res.message);
		return;
	}

	if (cmd === "decision") {
		const raw = await readStdinText();
		if (!raw) {
			console.error(
				'clue decision 需要从 stdin 传入 JSON 请求，例如：clue decision <<\'EOF\'\n{"op":"add","topic":"architecture","decision":"...","rationale":"...","assumptions":"...","revisitWhen":"...","evidence":"..."}\nEOF',
			);
			process.exit(1);
		}
		let req: DecisionMutationRequest;
		try {
			req = JSON.parse(raw) as DecisionMutationRequest;
		} catch (e) {
			console.error(`stdin JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
			process.exit(1);
		}
		const res = mutateDecision(paths, req, projectKey, config.readOnlyGuard);
		if (!res.ok) {
			console.error(res.message);
			process.exit(1);
		}
		console.log(res.message);
		return;
	}

	if (cmd === "index") {
		const harnessFlag = getFlagStr(flags, "harness")?.toLowerCase() as RecallHarness | undefined;
		const rebuild = getFlagBool(flags, "rebuild");
		const summary = indexRecallSessions(paths.recallDbPath, {
			harness: harnessFlag,
			rebuild,
			lockPath: paths.recallLockPath,
			worktreeSuffixes: config.worktreeSuffixes,
			workspaceRoots: config.workspaceRoots,
		});
		if (getFlagBool(flags, "json")) {
			console.log(JSON.stringify(summary, null, 2));
			return;
		}
		if (!getFlagBool(flags, "quiet")) {
			console.log(
				`✅ clue 索引完成（${summary.elapsedMs}ms）：扫描 ${summary.scannedFiles} 项，更新 ${summary.indexedSessions} 会话（${summary.indexedMessages} 条消息），跳过未变更 ${summary.skippedUnchanged} 项。`,
			);
			for (const [h, st] of Object.entries(summary.byHarness)) {
				console.log(`  - ${h}: ${st.sessions} sessions, ${st.messages} messages`);
			}
		}
		return;
	}

	if (cmd === "sources") {
		const rows = getRecallSources(paths.recallDbPath);
		if (getFlagBool(flags, "json")) {
			console.log(JSON.stringify({ recallDbPath: paths.recallDbPath, sources: rows }, null, 2));
			return;
		}
		if (rows.length === 0) {
			console.log("尚未建立会话索引，请先运行 `clue index`。");
			return;
		}
		console.log(`📚 clue 跨 Harness 原始会话索引（${paths.recallDbPath}）：`);
		for (const r of rows) {
			console.log(`  - ${r.harness.padEnd(9)} ${String(r.sessions).padStart(5)} sessions | ${String(r.messages).padStart(7)} msgs | 最新: ${r.latestUpdated.slice(0, 19)}`);
		}
		return;
	}

	if (cmd === "recall") {
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
		const limit = Math.max(1, Math.min(30, Number.isFinite(limRaw) ? limRaw : 8));
		const roleFlag = getFlagStr(flags, "role")?.toLowerCase();
		const role = roleFlag === "user" || roleFlag === "assistant" ? roleFlag : undefined;
		const explicitProject = getFlagStr(flags, "project")?.trim().toLowerCase() ?? null;
		const hits = recallSessions(paths.recallDbPath, {
			query,
			harness: harnessFlag,
			project: explicitProject ?? projectKey,
			role,
			since: getFlagStr(flags, "since"),
			limit,
			includeNoise: getFlagBool(flags, "all"),
		});
		if (getFlagBool(flags, "json")) {
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

	if (cmd === "show") {
		const idPrefix = positionals[1]?.trim() ?? "";
		if (!idPrefix) {
			console.error("用法：clue show <session-id-prefix> [--around <seq>] [--window 4] [--full]");
			process.exit(1);
		}
		const aroundStr = getFlagStr(flags, "around");
		const winStr = getFlagStr(flags, "window");
		const offStr = getFlagStr(flags, "offset");
		const limStr = getFlagStr(flags, "limit");
		const res = showSessionWindow(paths.recallDbPath, {
			idPrefix,
			around: aroundStr ? Number.parseInt(aroundStr, 10) : undefined,
			window: winStr ? Number.parseInt(winStr, 10) : undefined,
			offset: offStr ? Number.parseInt(offStr, 10) : undefined,
			limit: limStr ? Number.parseInt(limStr, 10) : undefined,
			full: getFlagBool(flags, "full"),
		});
		if (!res.ok) {
			console.error(res.message);
			process.exit(1);
		}
		if (getFlagBool(flags, "json")) {
			console.log(JSON.stringify({ session: res.session, messages: res.messages }, null, 2));
		} else {
			console.log(res.message);
		}
		return;
	}

	if (cmd === "curate") {
		const raw = await readStdinText();
		if (!raw) {
			console.error("clue curate 需要从 stdin 传入 JSON 请求，例如：clue curate <<'EOF'\n{\"target\":\"profile\",\"operations\":[...]}\nEOF");
			process.exit(1);
		}
		let req: CurateRequest;
		try {
			req = JSON.parse(raw) as CurateRequest;
		} catch (e) {
			console.error(`stdin JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
			process.exit(1);
		}
		if (getFlagBool(flags, "dry-run")) req.dryRun = true;
		const res = curateHotMemory(config, paths, req, projectKey);
		if (!res.ok) {
			console.error(res.message);
			process.exit(1);
		}
		console.log(res.message);
		return;
	}

	if (cmd === "pitfall") {
		const raw = await readStdinText();
		if (!raw) {
			console.error("clue pitfall 需要从 stdin 传入 JSON 请求，例如：clue pitfall <<'EOF'\n{\"op\":\"add\",\"symptom\":...,\"rootCause\":...,\"historicalFix\":...,\"rethinkHint\":...,\"evidence\":...}\nEOF");
			process.exit(1);
		}
		let req: PitfallMutationRequest;
		try {
			req = JSON.parse(raw) as PitfallMutationRequest;
		} catch (e) {
			console.error(`stdin JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
			process.exit(1);
		}
		const res = mutatePitfall(paths, req, projectKey, config.readOnlyGuard);
		if (!res.ok) {
			console.error(res.message);
			process.exit(1);
		}
		console.log(res.message);
		return;
	}

	if (cmd === "dream") {
		if (getFlagBool(flags, "mark-done")) {
			const meta = markDreamDone(paths, getFlagStr(flags, "summary"));
			console.log(`已记录本次做梦体检完成时间：${meta.lastDreamAt}`);
			return;
		}
		if (getFlagBool(flags, "json")) {
			console.log(JSON.stringify(evaluateMemoryHealth(config, paths, projectKey), null, 2));
		} else {
			console.log(buildDreamPacket(config, paths, projectKey));
		}
		return;
	}

	if (cmd === "log") {
		const lim = Number.parseInt(getFlagStr(flags, "limit") ?? "10", 10);
		const commits = getRecentMemoryCommits(paths.home, Number.isFinite(lim) ? lim : 10);
		console.log(commits.length > 0 ? commits.join("\n") : "(暂无 Git 提交记录)");
		return;
	}

	if (cmd === "undo") {
		const res = undoLastMemoryCommit(paths.home, {
			guardedFiles: getReadOnlyGuardedFiles(paths),
			restoreReadOnly: config.readOnlyGuard,
		});
		if (!res.ok) {
			console.error(res.message);
			process.exit(1);
		}
		console.log(res.message);
		return;
	}

	if (cmd === "unlock") {
		const unlocked = unlockFilesWritable(getReadOnlyGuardedFiles(paths));
		console.log(`🔓 已临时解锁 ${unlocked.length} 个核心记忆文件为可写状态（手动编辑完后可运行 \`clue lock\` 重新加锁）。`);
		return;
	}

	if (cmd === "lock") {
		const locked = lockFilesReadOnly(getReadOnlyGuardedFiles(paths));
		console.log(`🔒 已锁定 ${locked.length} 个核心记忆文件为只读（0444），防止任意 Harness 绕过校验直接篡改。`);
		return;
	}

	if (cmd === "doctor") {
		const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
		checks.push({ name: "CLUE_HOME", ok: existsSync(paths.home), detail: paths.home });
		checks.push({ name: "PROFILE.md", ok: existsSync(paths.profilePath), detail: paths.profilePath });
		checks.push({ name: "PROJECTS.md", ok: existsSync(paths.projectsPath), detail: paths.projectsPath });
		checks.push({ name: "Git repo", ok: existsSync(join(paths.home, ".git")), detail: join(paths.home, ".git") });
		const tampering = detectUnauthorizedChanges(paths.home);
		checks.push({
			name: "Git integrity sentinel",
			ok: !tampering.dirty,
			detail: tampering.dirty ? `uncommitted edits: ${tampering.files.join(", ")}` : "clean",
		});
		try {
			const db = openPitfallDb(paths.dbPath);
			const cnt = (db.query("SELECT COUNT(*) as c FROM pitfalls").get() as { c: number }).c;
			db.close();
			const ddb = openDecisionDb(paths.dbPath);
			const dcnt = (ddb.query("SELECT COUNT(*) as c FROM decisions").get() as { c: number }).c;
			ddb.close();
			checks.push({ name: "SQLite FTS5 pitfalls+decisions", ok: true, detail: `${cnt} pitfalls, ${dcnt} decisions` });
		} catch (e) {
			checks.push({ name: "SQLite FTS5 pitfalls+decisions", ok: false, detail: String(e) });
		}

		const adapters = getFlagBool(flags, "adapters") ? inspectHarnessAdapters() : undefined;

		if (getFlagBool(flags, "json")) {
			console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks, ...(adapters ? { adapters } : {}) }, null, 2));
		} else {
			for (const c of checks) {
				console.log(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
			}
			if (adapters) {
				console.log("\n🔌 Harness 接入状态（7 大工具巡检）：");
				for (const a of adapters) {
					const icon = !a.detected ? "⚪" : a.hookWired ? "✅" : "⚠️";
					console.log(`  ${icon} ${a.harness.padEnd(9)} ${a.detail}`);
				}
			}
		}
		if (!checks.every(c => c.ok)) process.exit(1);
		return;
	}

	console.error(`未知命令：${cmd}。运行 \`clue help\` 查看用法。`);
	process.exit(1);
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
