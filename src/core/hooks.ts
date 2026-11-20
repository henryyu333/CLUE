import { basename, resolve } from "node:path";
import type { ClueConfig, CluePaths } from "./config.ts";
import { listActiveDecisions } from "./decisions.ts";
import { detectUnauthorizedChanges } from "./git.ts";
import { evaluateMemoryHealth } from "./health.ts";
import { classifyPromptIntent } from "./intent.ts";
import { formatIntentCard, getProjectIntent } from "./intents.ts";
import { readHotMemoryView } from "./markdown.ts";
import { formatPitfallGuidance, listActivePitfalls, searchPitfalls } from "./pitfalls.ts";
import { detectProjectFile, resolveProjectKey } from "./project.ts";
import { getRecentProjectSessionAnchors } from "../recall/store.ts";

export type SupportedHarness = "agy" | "claude" | "codex" | "hermes";

export interface BootSnapshot {
	projectKey: string | null;
	profileChars: number;
	profilePct: number;
	globalChars: number;
	projectChars: number;
	hasIntentCard: boolean;
	continuityCount: number;
	activeDecisionCount: number;
	activePitfallCount: number;
	healthHint: string | null;
	block: string;
}

function shortExcerpt(text: string, maxLen: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

export function buildBootSnapshot(config: ClueConfig, paths: CluePaths, cwd: string): BootSnapshot {
	const projectKey = resolveProjectKey(cwd, config.workspaceRoots);
	const view = readHotMemoryView(config, paths, projectKey);
	const health = evaluateMemoryHealth(config, paths, projectKey);
	const tampering = detectUnauthorizedChanges(paths.home);
	const intentCard = getProjectIntent(paths.intentsPath, projectKey);

	// Continuity fallback: surface 1-2 recent cross-harness sessions newer than the intent card (or latest 2 if no card yet)
	const continuityAnchors = projectKey
		? getRecentProjectSessionAnchors(paths.recallDbPath, projectKey, {
				afterIso: intentCard?.updatedAt ?? null,
				limit: 2,
			})
		: [];

	const activeDecisions = listActiveDecisions(paths.dbPath, projectKey).slice(0, 4);
	const activePitfalls = listActivePitfalls(paths.dbPath, projectKey).slice(0, 4);

	const sections: string[] = [
		`<clue-memory project="${projectKey ?? "none"}">`,
		"以下为用户的本地背景、当前项目意图与跨工具记忆索引（只读冻结快照；与当前明确指令或仓库实况冲突时以当前为准）。平时静默只读、绝不偷写；查老坑/老决定用 `clue search \"<词>\"`，翻过往原话用 `clue recall \"<词>\"` / `clue show <id>`。",
	];
	if (tampering.dirty) {
		sections.push(
			`## INTEGRITY WARNING\n检测到记忆文件存在绕过 clue CLI 的未提交改动（${tampering.files.join(", ")}）。请告知用户核对 \`git -C "${paths.home}" diff\` 或运行 \`clue status\` 检查，切勿覆盖现场。`,
		);
	}
	if (view.profileRaw.trim()) {
		sections.push(`## BACKGROUND & TASTE\n${view.profileRaw.trim()}`);
	}
	if (intentCard) {
		sections.push(`## PROJECT INTENT (${intentCard.project} · ${intentCard.updatedAt.slice(0, 10)})\n${formatIntentCard(intentCard)}`);
	}
	if (view.scoped.text) {
		sections.push(`## PROJECTS\n${view.scoped.text}`);
	}
	if (continuityAnchors.length > 0) {
		const anchorLines = continuityAnchors.map(a => {
			const shortId = a.id.length > 22 ? a.id.slice(0, 22) : a.id;
			const tail = a.lastUserMsg && a.lastUserMsg !== a.firstUserMsg ? ` → 末句：「${shortExcerpt(a.lastUserMsg, 56)}」` : "";
			return `- [${a.updatedAt.slice(5, 16).replace("T", " ")} | ${a.harness} | ${shortId}] 「${shortExcerpt(a.firstUserMsg, 64)}」${tail}`;
		});
		sections.push(`## RECENT UNWRAPPED SESSIONS (跨工具自动兜底)\n${anchorLines.join("\n")}`);
	}
	if (activeDecisions.length > 0 || activePitfalls.length > 0) {
		const idxLines: string[] = [];
		for (const d of activeDecisions) {
			idxLines.push(`- [Decision #${d.id}${d.project === "global" ? " · global" : ""}] ${shortExcerpt(d.decision, 76)}`);
		}
		for (const p of activePitfalls) {
			idxLines.push(`- [Pitfall #${p.id}${p.project === "global" ? " · global" : ""}] ${shortExcerpt(p.root_cause, 76)}`);
		}
		sections.push(`## ACTIVE MEMORY INDEX (1行目录，详情按需 clue search)\n${idxLines.join("\n")}`);
	}
	sections.push("</clue-memory>");

	return {
		projectKey,
		profileChars: view.profileChars,
		profilePct: view.profilePct,
		globalChars: view.scoped.globalChars,
		projectChars: view.scoped.projectChars,
		hasIntentCard: Boolean(intentCard),
		continuityCount: continuityAnchors.length,
		activeDecisionCount: activeDecisions.length,
		activePitfallCount: activePitfalls.length,
		healthHint: health.hint,
		block: sections.join("\n\n"),
	};
}

export function buildTurnNotice(
	config: ClueConfig,
	paths: CluePaths,
	promptText: string,
	cwd: string,
	compactionLessonsCount = 0,
): string | null {
	const intent = classifyPromptIntent(promptText);
	if (
		!intent.isStart &&
		!intent.isWrapUp &&
		!intent.isCasualClose &&
		!intent.isExplicitMemoryEdit &&
		!intent.isDream
	) {
		return null;
	}

	const projectKey = resolveProjectKey(cwd);
	const matchedWorkflows = config.projectWorkflows
		.map(wf => {
			const hit = detectProjectFile(cwd, wf.detectFile);
			return hit ? { wf, hit } : null;
		})
		.filter((x): x is { wf: (typeof config.projectWorkflows)[number]; hit: { file: string; dir: string } } => x !== null);
	const renderHint = (tpl: string, hit: { file: string; dir: string }) =>
		tpl.replaceAll("{dir}", hit.dir).replaceAll("{file}", hit.file);

	const health = evaluateMemoryHealth(config, paths, projectKey);
	const notices: string[] = [];

	if (intent.isStart) {
		const cleanQuery = promptText.replace(/开工(?:吧|了|啦|哈|呀|啊)?/g, " ").trim();
		const hits = cleanQuery ? searchPitfalls(paths.dbPath, cleanQuery, projectKey, 3, false) : [];
		const startLines = [
			"【clue 开工预热】",
			"- 已载入用户的 `PROFILE.md` 与当前项目偏好快照。",
		];
		for (const { wf, hit } of matchedWorkflows) {
			if (wf.startHint) {
				startLines.push(`- ${renderHint(wf.startHint, hit)}`);
			}
		}
		if (hits.length > 0) {
			startLines.push("", formatPitfallGuidance(hits));
		} else {
			startLines.push("- 排障遇到棘手报错或模块怪癖时，可随时运行 `clue search \"<关键词>\"` 查跨项目踩坑线索。");
		}
		notices.push(startLines.join("\n"));
	}

	if (intent.isDream) {
		notices.push(
			[
				"【clue 做梦体检模式】",
				"用户请求对个人记忆做一次深度整理体检：",
				"1. 先运行 `clue dream` 读取完整健康报告、水位、疑似重复项与活跃踩坑清单；",
				"2. 如有必要，结合近期代码/Git 状态核对哪些条目已经过时或失真；",
				"3. **严禁直接写入**！先向用户输出一份清晰编号的「做梦整理提案草稿」（合并/淘汰/升降级/补溯源），等用户逐条或整体批复后，再用 `clue curate` / `clue pitfall` 落盘并执行 `clue dream --mark-done`。",
			].join("\n"),
		);
	} else if (intent.isWrapUp) {
		const wrapLines = [
			"【clue 收尾复盘契约（统一草稿确认制）】",
			"用户已发出「收尾 / 收工」口令，请按以下顺序执行：",
		];
		let step = 1;
		for (const { wf, hit } of matchedWorkflows) {
			if (wf.wrapUpHint) {
				wrapLines.push(`${step}. ${renderHint(wf.wrapUpHint, hit)}`);
				step++;
			}
		}
		wrapLines.push(
			`${step}. **盘点个人记忆与踩坑（宁缺毋滥，严禁偷写）**：回顾本次会话${compactionLessonsCount > 0 ? "（含压缩摘要中的待沉淀线索）" : ""}是否有用户新定下的长期偏好、纠正过你的做法、跨会话项目约定，或非显而易见的客观 Bug 根因。`,
			`   - **若无新知**：直接明确告知「本次无新增长期记忆」并附当前水位即可，绝不硬凑废话。`,
			`   - **若有值得记住的**：先运行 \`clue view\` 核对原文，**不要直接落盘！**先向用户贴出一份极简清晰的「记忆修改草稿」（准备改 PROFILE 还是 PROJECTS、具体增/改/并哪条，或要记哪个坑的现象/客观根因/当时解法/重思提示/evidence 溯源），等用户确认后再调用 \`clue curate\` / \`clue pitfall\` 落盘并汇报最新水位。`,
			`   - 禁止直接用文件编辑工具修改 \`${paths.home}\` 下的记忆文件。`,
		);
		step++;
		if (health.hint) {
			wrapLines.push(`${step}. 顺带在回复末尾向用户转达健康提醒：${health.hint}`);
		}
		notices.push(wrapLines.join("\n"));
	} else if (intent.isCasualClose) {
		const closeLines = [
			"【clue 轻量收尾自检（草稿确认制）】",
			"检测到用户正在结束本次问答/小任务。请在正常回应之后，顺手做一次极轻的记忆自检：",
			"- 若本次没有任何值得跨会话长期记住的新偏好、纠偏或真坑：只在回复末尾用一句极短的话带过（例如：`记忆检查：本次无新增长期记忆。`），不要啰嗦。",
			"- 若确实出现了值得长期记住的偏好或真坑：**不要直接写入！**用 2~5 行给出清晰的「建议记忆草稿」（写哪边、具体内容），问用户“这样记可以吗？”，等确认后再走 `clue curate` / `clue pitfall` 写入。",
		];
		if (health.hint) {
			closeLines.push(`- 附带提醒：${health.hint}`);
		}
		notices.push(closeLines.join("\n"));
	} else if (intent.isExplicitMemoryEdit) {
		notices.push(
			[
				"【clue 显式记忆维护】",
				"检测到用户明确要求记录、修改、删除或回滚记忆：",
				"- 修改前先运行 `clue view`（或 `clue search`）核对原文；",
				"- 通过 `clue curate` / `clue pitfall`（stdin JSON）完成变更，严禁直接编辑记忆文件；",
				"- 若用户意图明确且具体，可直接落盘并简短汇报变更内容与最新水位；若措辞宽泛，先给草稿确认。",
				"- 如用户要求回滚上一次变更，运行 `clue undo`。",
			].join("\n"),
		);
	}

	return notices.length > 0 ? notices.join("\n\n") : null;
}

const PROTECTED_FILENAMES = [
	"PROFILE.md",
	"PROJECTS.md",
	"INTENTS.json",
	"pitfalls.db",
	"pitfalls.jsonl",
	"decisions.jsonl",
	"clue.meta.json",
];

function expandHomePath(raw: string): string {
	if (raw.startsWith("~/")) return resolve(process.env.HOME ?? "", raw.slice(2));
	return resolve(raw);
}

export function checkRawEditGuard(
	paths: CluePaths,
	toolName: string,
	args: Record<string, unknown>,
): { blocked: boolean; reason?: string } {
	const normTool = toolName.toLowerCase();
	const homeAbs = resolve(paths.home);
	const homeDirName = basename(homeAbs);

	// 1) Direct file write/edit tools across harnesses
	const isFileWriteTool =
		normTool === "write" ||
		normTool === "edit" ||
		normTool === "patch" ||
		normTool === "write_file" ||
		normTool === "edit_file" ||
		normTool === "write_to_file" ||
		normTool === "replace_file_content" ||
		normTool === "multi_replace_file_content" ||
		normTool === "multiedit";

	if (isFileWriteTool) {
		const candidatePaths = [
			args.Path,
			args.path,
			args.TargetFile,
			args.target_file,
			args.file_path,
			args.filePath,
			args.input,
		]
			.filter(v => typeof v === "string")
			.map(v => String(v));

		for (const raw of candidatePaths) {
			const expanded = expandHomePath(raw);
			const hitsHome = expanded === homeAbs || expanded.startsWith(`${homeAbs}/`) || expanded.startsWith(`${homeAbs}\\`);
			const hitsProtected = PROTECTED_FILENAMES.some(
				f => raw.endsWith(f) || expanded.endsWith(`/${f}`) || expanded.endsWith(`\\${f}`),
			);
			if (hitsHome && hitsProtected) {
				return {
					blocked: true,
					reason:
						"clue 门禁拦截：禁止绕过校验直接编辑个人记忆文件。请通过 `clue curate` / `clue intent` / `clue pitfall` / `clue decision` 安全写入。",
				};
			}
		}
		return { blocked: false };
	}

	// 2) Shell command trying to directly overwrite protected files (while allowing clue CLI itself)
	const isShellTool = normTool === "run_command" || normTool === "bash" || normTool === "shell" || normTool === "terminal";
	if (isShellTool) {
		const cmd = String(args.CommandLine ?? args.command ?? args.cmd ?? "");
		if (!cmd) return { blocked: false };
		const cmdMentionsHome =
			cmd.includes(homeAbs) ||
			cmd.includes("$CLUE_HOME") ||
			cmd.includes("${CLUE_HOME}") ||
			(homeDirName.length > 0 && cmd.includes(`${homeDirName}/`));
		const lines = cmd.split(/\r?\n/);
		for (const line of lines) {
			const touchesProtected =
				(cmdMentionsHome || line.includes(homeAbs)) && PROTECTED_FILENAMES.some(f => line.includes(f));
			if (!touchesProtected) continue;
			const isCluePipe = /\|\s*(?:~\/\.local\/bin\/|\/[^\s]*\/)?clue\b/.test(line);
			const isClueCli = /^\s*(?:CLUE_HOME=\S+\s+)?(?:~\/\.local\/bin\/|\/[^\s]*\/)?clue\b/.test(line);
			const looksLikeDirectWrite = /(?:>|>>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bchmod\b|\bperl\s+-i|\bpython.*write)/i.test(line);
			if (looksLikeDirectWrite && !isClueCli && !isCluePipe) {
				return {
					blocked: true,
					reason:
						"clue 门禁拦截：禁止通过 shell 重定向/覆盖命令直接篡改个人记忆文件。请使用 `clue` CLI 命令操作。",
				};
			}
		}
	}

	return { blocked: false };
}

export function formatAgySessionStart(snapshot: BootSnapshot): Record<string, unknown> {
	return {
		injectSteps: [
			{
				systemMessage: {
					systemMessage: snapshot.block,
				},
			},
		],
	};
}

export function formatAgyPreInvocation(notice: string | null): Record<string, unknown> {
	if (!notice) return {};
	return {
		injectSteps: [
			{
				systemMessage: {
					systemMessage: notice,
				},
			},
		],
	};
}

export function formatClaudeHookOutput(eventName: string, additionalContext: string | null): Record<string, unknown> {
	if (!additionalContext) return {};
	return {
		hookSpecificOutput: {
			hookEventName: eventName,
			additionalContext,
		},
	};
}
