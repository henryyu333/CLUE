import { inspectHarnessAdapters } from "../adapters/install.ts";
import { getRecallSources, getRecentProjectSessionAnchors, refreshRecallIfStale } from "../recall/store.ts";
import { isWorkerRole, type ClueConfig, type CluePaths } from "./config.ts";
import { formatDraftList, readDrafts } from "./drafts.ts";
import { detectUnauthorizedChanges } from "./git.ts";
import { evaluateMemoryHealth } from "./health.ts";
import { classifyPromptIntent } from "./intent.ts";
import { formatIntentCard, getProjectIntent } from "./intents.ts";
import { LEDGER_KINDS, listActive, rowSummary, type LedgerKind } from "./ledger.ts";
import { readHotMemoryView } from "./markdown.ts";
import { matchProjectWorkflows, resolveProjectKey, skippedIntentSlots } from "./project.ts";
import { readHarnessSeen, readHitStats } from "./stats.ts";

export interface BootSnapshot {
	projectKey: string | null;
	pendingDrafts: number;
	continuityCount: number;
	healthHint: string | null;
	block: string;
}

function shortExcerpt(text: string, maxLen: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

const INDEX_TAG: Record<LedgerKind, string> = { pitfall: "Pitfall", decision: "Decision", note: "Note" };

const WORKER_BANNER =
	"【当前为只读执行窗格（CLUE_ROLE=worker）】以下背景与历史坑只作审美和排障参考；不起草、不写入记忆，不执行收尾流程。";

const MEMORY_DUTY =
	"平时不打扰用户。工作中遇到值得长期记住的内容（用户的偏好、习惯或个人事实，项目方向变化，踩坑根因，关键决定），随时用 clue 把它记进待确认草稿箱（`clue note|pitfall|decision|intent`，OMP 里用 memory_draft）：草稿不生效，不必先问，可在 tags 里写同义词和别名方便以后检索。收尾或用户结束对话时，把草稿整理给用户确认后才写入。";

const LOOKUP_HINT =
	"查老坑/老决定/记忆：`clue search \"说法1 | 说法2\"`（用 | 分隔几种不同说法一起查）；翻过往原话：`clue recall \"<词>\"` / `clue show <id>`。";

/**
 * Harnesses whose adapter is installed and that clue saw working before, but which have newer
 * sessions than the last time clue ran there: their hook format probably changed in an update.
 */
function staleHarnesses(paths: CluePaths): string[] {
	const seen = readHarnessSeen(paths);
	if (Object.keys(seen).length === 0) return [];
	const latest = new Map(getRecallSources(paths.recallDbPath).map(s => [s.harness, s.latestUpdated]));
	const wired = new Set(inspectHarnessAdapters().filter(a => a.detected && a.hookWired).map(a => a.harness as string));
	const out: string[] = [];
	for (const [harness, lastSeen] of Object.entries(seen)) {
		const newest = latest.get(harness);
		if (!wired.has(harness) || !newest) continue;
		if (Date.parse(newest) - Date.parse(lastSeen) > 6 * 3600 * 1000) out.push(harness);
	}
	return out;
}

export function buildBootSnapshot(config: ClueConfig, paths: CluePaths, cwd: string): BootSnapshot {
	const worker = isWorkerRole();
	const projectKey = resolveProjectKey(cwd, config.workspaceRoots);
	refreshRecallIfStale(paths.recallDbPath, {
		lockPath: paths.recallLockPath,
		worktreeSuffixes: config.worktreeSuffixes,
		workspaceRoots: config.workspaceRoots,
	});
	const view = readHotMemoryView(config, paths, projectKey);
	const health = evaluateMemoryHealth(config, paths, projectKey);
	const tampering = detectUnauthorizedChanges(paths.home);
	const intentCard = getProjectIntent(paths.intentsPath, projectKey);
	const drafts = worker ? [] : readDrafts(paths);
	const stale = staleHarnesses(paths);

	// Continuity fallback: recent sessions newer than the intent card (or the latest 2 without a card).
	const continuityAnchors = projectKey
		? getRecentProjectSessionAnchors(paths.recallDbPath, projectKey, { afterIso: intentCard?.updatedAt ?? null, limit: 2 })
		: [];

	const sections: string[] = [
		`<clue-memory project="${projectKey ?? "none"}">`,
		`以下是用户的个人记忆快照（只读；与当前明确指令或仓库实况冲突时以当前为准）。${worker ? "" : MEMORY_DUTY}${LOOKUP_HINT}`,
	];
	if (worker) sections.push(WORKER_BANNER);

	const alerts: string[] = [];
	if (tampering.dirty) {
		alerts.push(
			`⚠️ 记忆文件有绕过 clue 的改动（${tampering.files.join(", ")}）。告诉用户，并让用户选：\`clue restore\`（丢弃）或 \`clue accept "<原因>"\`（保留）；不要自己覆盖。`,
		);
	}
	if (drafts.length > 0) {
		alerts.push(`📝 待确认草稿 ${drafts.length} 条（\`clue drafts\` 查看）：用户收尾或结束对话时一并给用户确认。`);
	}
	if (stale.length > 0) {
		alerts.push(`🔌 ${stale.join(", ")} 最近有会话但 clue 没被调用，接入可能已失效；提醒用户运行 \`clue doctor --adapters\`。`);
	}
	if (health.hint) alerts.push(health.hint);
	if (alerts.length > 0) sections.push(`## ALERTS\n${alerts.join("\n")}`);

	if (view.profileRaw.trim()) sections.push(`## BACKGROUND & TASTE\n${view.profileRaw.trim()}`);
	if (intentCard) {
		sections.push(`## PROJECT INTENT (${intentCard.project} · ${intentCard.updatedAt.slice(0, 10)})\n${formatIntentCard(intentCard)}`);
	}
	if (view.scoped.text) sections.push(`## PROJECTS\n${view.scoped.text}`);
	if (continuityAnchors.length > 0) {
		const anchorLines = continuityAnchors.map(a => {
			const shortId = a.id.length > 22 ? a.id.slice(0, 22) : a.id;
			const tail = a.lastUserMsg && a.lastUserMsg !== a.firstUserMsg ? ` → 末句：「${shortExcerpt(a.lastUserMsg, 56)}」` : "";
			return `- [${a.updatedAt.slice(5, 16).replace("T", " ")} | ${a.harness} | ${shortId}] 「${shortExcerpt(a.firstUserMsg, 64)}」${tail}`;
		});
		sections.push(`## RECENT SESSIONS SINCE LAST INTENT UPDATE\n${anchorLines.join("\n")}`);
	}

	const idxLines: string[] = [];
	for (const kind of LEDGER_KINDS) {
		for (const r of listActive(paths, kind, projectKey).slice(0, 3)) {
			idxLines.push(`- [${INDEX_TAG[kind]} #${r.id}${r.project === "global" ? " · global" : ""}] ${shortExcerpt(rowSummary(kind, r), 76)}`);
		}
	}
	if (idxLines.length > 0) sections.push(`## MEMORY INDEX (详情按需 clue search)\n${idxLines.join("\n")}`);
	sections.push("</clue-memory>");

	return {
		projectKey,
		pendingDrafts: drafts.length,
		continuityCount: continuityAnchors.length,
		healthHint: health.hint,
		block: sections.join("\n\n"),
	};
}

export interface TurnContext {
	/** How many times this conversation's context was compacted so far. */
	compactions?: number;
	/** Recall id of the current conversation (e.g. `omp:<uuid>`), for looking up pre-compaction text. */
	sessionRef?: string;
	/** Ledger keys (`pitfall:3`) shown or looked up during this conversation. */
	viewedKeys?: readonly string[];
}

/** Keys of ledger rows explicitly looked up since `sinceIso`. */
export function lookedUpSince(paths: CluePaths, sinceIso: string): string[] {
	return Object.entries(readHitStats(paths))
		.filter(([, s]) => s.lastAt >= sinceIso)
		.map(([k]) => k);
}

function describeViewed(paths: CluePaths, keys: readonly string[]): string[] {
	const out: string[] = [];
	for (const key of [...new Set(keys)]) {
		const [kind, idStr] = key.split(":") as [LedgerKind, string];
		if (!LEDGER_KINDS.includes(kind)) continue;
		const row = listActive(paths, kind).find(r => r.id === Number(idStr));
		if (row) out.push(`${INDEX_TAG[kind]} #${row.id}：${shortExcerpt(rowSummary(kind, row), 60)}`);
	}
	return out;
}

export function buildTurnNotice(
	config: ClueConfig,
	paths: CluePaths,
	promptText: string,
	cwd: string,
	ctx: TurnContext = {},
): string | null {
	if (isWorkerRole()) return null;
	const intent = classifyPromptIntent(promptText);
	if (!intent.isStart && !intent.isWrapUp && !intent.isCasualClose && !intent.isExplicitMemoryEdit && !intent.isDream) {
		return null;
	}
	const workflows = matchProjectWorkflows(config, cwd);
	const render = (tpl: string, hit: { file: string; dir: string }) => tpl.replaceAll("{dir}", hit.dir).replaceAll("{file}", hit.file);
	const notices: string[] = [];

	if (intent.isStart) {
		const lines = ["【clue 开工】（仅当用户这句话是在宣布开工时适用）", "- 背景、意图卡和记忆目录已在上方载入。"];
		for (const { wf, hit } of workflows) if (wf.startHint) lines.push(`- ${render(wf.startHint, hit)}`);
		notices.push(lines.join("\n"));
	}

	if (intent.isDream) {
		notices.push(
			[
				"【clue 记忆体检】（仅当用户是在要求整理/体检记忆时执行）",
				"1. 运行 `clue dream` 读取体检材料（溯源过期、冷门条目、重复项、全部活跃条目）。",
				"2. 必要时对照当前代码和 git 核实；把每项整理建议起草进草稿箱（verify / supersede / delete / curate）。",
				"3. 把完整草稿清单（编号 + 前后对比）给用户看，确认后 `clue apply`，最后 `clue dream --mark-done`。",
			].join("\n"),
		);
	} else if (intent.isWrapUp || intent.isCasualClose) {
		const drafts = readDrafts(paths);
		const skip = skippedIntentSlots(config, cwd);
		const viewed = describeViewed(paths, ctx.viewedKeys ?? []);
		const lines = [
			intent.isWrapUp
				? "【clue 收尾】（仅当用户这句话是在要求收尾/收工时执行；只是在讨论“收尾”这个话题就忽略）"
				: "【clue 结束对话】（仅当用户确实在结束这次对话时执行；否则忽略）",
		];
		let step = 1;
		for (const { wf, hit } of workflows) {
			if (wf.wrapUpHint) lines.push(`${step++}. ${render(wf.wrapUpHint, hit)}`);
		}
		const compactNote = !ctx.sessionRef
			? ""
			: (ctx.compactions ?? 0) > 0
				? `本次对话被压缩过 ${ctx.compactions} 次，拿不准的早期细节用 \`clue show ${ctx.sessionRef}\` 查压缩前原文。`
				: `早期细节拿不准时可用 \`clue show ${ctx.sessionRef}\` 查本次对话原文。`;
		lines.push(
			`${step++}. 回顾本次对话，把还没进草稿箱、值得长期记住的内容补成草稿（偏好/个人事实→note 或 profile，方向变化→intent，根因→pitfall，取舍→decision）。没有就不补，绝不硬凑。${compactNote}`,
		);
		if (skip.length > 0) {
			lines.push(`   本项目意图卡的 ${skip.join(", ")} 由项目自己的交班文件维护，不要为它起草。`);
		}
		if (viewed.length > 0) {
			lines.push(
				`${step++}. 本次用到了这些旧条目，逐条判断后各起草一份：仍是最优做法 → verify；找到更好的做法 → supersede（写新解法）。`,
				...viewed.map(v => `   - ${v}`),
			);
		}
		lines.push(
			`${step++}. 把完整草稿清单原样给用户看（编号 + 内容），问用户：全部写入 / 只写哪几条 / 要改哪条 / 全部丢弃。用户没明确同意前，不要写入。`,
			`${step++}. 用户确认后运行 \`clue apply <编号|all>\`（丢弃用 \`clue drop\`），把它输出的回执原样贴给用户。`,
		);
		if (intent.isCasualClose) {
			lines.push("   若草稿箱为空、本次也没有值得记的：不要展开流程，只在回复末尾说一句「记忆：本次无新增」。");
		}
		lines.push("", `当前${formatDraftList(drafts)}`);
		notices.push(lines.join("\n"));
	} else if (intent.isExplicitMemoryEdit) {
		notices.push(
			[
				"【clue 记忆维护】（仅当用户明确要求记住/修改/删除/撤回记忆时执行；只是普通用词就忽略）",
				"- 记住或修改：起草对应草稿（note / pitfall / decision / intent；改个人名片或项目习惯用 profile / projects，先 `clue view` 核对原文），把草稿给用户确认后再 `clue apply`。",
				"- 撤回上一次写入：直接 `clue undo`，把结果告诉用户。",
			].join("\n"),
		);
	}

	return notices.length > 0 ? notices.join("\n\n") : null;
}

export function formatAgySessionStart(snapshot: BootSnapshot): Record<string, unknown> {
	return { injectSteps: [{ systemMessage: { systemMessage: snapshot.block } }] };
}

export function formatAgyPreInvocation(notice: string | null): Record<string, unknown> {
	if (!notice) return {};
	return { injectSteps: [{ systemMessage: { systemMessage: notice } }] };
}

export function formatClaudeHookOutput(eventName: string, additionalContext: string | null): Record<string, unknown> {
	if (!additionalContext) return {};
	return { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
}
