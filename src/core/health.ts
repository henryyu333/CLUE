import { existsSync, readFileSync } from "node:fs";
import type { ClueConfig, CluePaths } from "./config.ts";
import { countCommitsSince, getRecentMemoryCommits } from "./git.ts";
import { atomicWriteFileSync } from "./lock.ts";
import { parseSectionedMarkdown, readHotMemoryView } from "./markdown.ts";
import { listActivePitfalls } from "./pitfalls.ts";

export interface ClueMeta {
	lastDreamAt?: string | null;
	lastDreamSummary?: string | null;
}

export interface DuplicateCandidate {
	file: "PROFILE.md" | "PROJECTS.md";
	sectionA: string;
	entryA: string;
	sectionB: string;
	entryB: string;
	similarity: number;
}

export interface MemoryHealthReport {
	status: "healthy" | "attention";
	reasons: string[];
	hint: string | null;
	metrics: {
		profileChars: number;
		profileLimit: number;
		profilePct: number;
		globalChars: number;
		globalLimit: number;
		globalPct: number;
		maxProjectPct: number;
		maxProjectHeading: string | null;
		activePitfalls: number;
		pitfallsWithoutEvidence: number;
		daysSinceDream: number | null;
		writesSinceDream: number;
		duplicateCandidates: DuplicateCandidate[];
	};
}

export function readClueMeta(paths: CluePaths): ClueMeta {
	if (!existsSync(paths.metaPath)) return {};
	try {
		return JSON.parse(readFileSync(paths.metaPath, "utf8")) as ClueMeta;
	} catch {
		return {};
	}
}

export function markDreamDone(paths: CluePaths, summary?: string): ClueMeta {
	const meta = readClueMeta(paths);
	const next: ClueMeta = {
		...meta,
		lastDreamAt: new Date().toISOString(),
		lastDreamSummary: summary?.trim() || meta.lastDreamSummary || null,
	};
	atomicWriteFileSync(paths.metaPath, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

function bigrams(text: string): Set<string> {
	const cleaned = text.toLowerCase().replace(/[\s，。、；：！？（）()【】\[\]"`'—-]+/g, "");
	const chars = [...cleaned];
	const set = new Set<string>();
	for (let i = 0; i < chars.length - 1; i++) {
		set.add(chars[i]! + chars[i + 1]!);
	}
	return set;
}

function jaccardSimilarity(a: string, b: string): number {
	const setA = bigrams(a);
	const setB = bigrams(b);
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const g of setA) {
		if (setB.has(g)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function findDuplicateCandidates(
	file: "PROFILE.md" | "PROJECTS.md",
	raw: string,
	threshold = 0.45,
): DuplicateCandidate[] {
	const map = parseSectionedMarkdown(raw);
	const flat: Array<{ section: string; entry: string }> = [];
	for (const [section, items] of map.entries()) {
		for (const entry of items) flat.push({ section, entry });
	}
	const hits: DuplicateCandidate[] = [];
	for (let i = 0; i < flat.length; i++) {
		for (let j = i + 1; j < flat.length; j++) {
			const sim = jaccardSimilarity(flat[i]!.entry, flat[j]!.entry);
			if (sim >= threshold) {
				hits.push({
					file,
					sectionA: flat[i]!.section,
					entryA: flat[i]!.entry,
					sectionB: flat[j]!.section,
					entryB: flat[j]!.entry,
					similarity: Number(sim.toFixed(2)),
				});
			}
		}
	}
	return hits;
}

export function evaluateMemoryHealth(
	config: ClueConfig,
	paths: CluePaths,
	projectKey: string | null,
): MemoryHealthReport {
	const view = readHotMemoryView(config, paths, projectKey);
	const globalPct = Math.round((view.scoped.globalChars / config.limits.globalProjectChars) * 100);

	let maxProjectPct = 0;
	let maxProjectHeading: string | null = null;
	for (const p of view.scoped.allProjects) {
		if (p.heading === config.globalProjectHeading) continue;
		const pct = Math.round((p.chars / config.limits.singleProjectChars) * 100);
		if (pct > maxProjectPct) {
			maxProjectPct = pct;
			maxProjectHeading = p.heading;
		}
	}

	const pitfalls = listActivePitfalls(paths.dbPath);
	const pitfallsWithoutEvidence = pitfalls.filter(p => !p.evidence?.trim()).length;

	const meta = readClueMeta(paths);
	const lastDreamAt = meta.lastDreamAt ?? null;
	const daysSinceDream = lastDreamAt
		? Math.floor((Date.now() - new Date(lastDreamAt).getTime()) / (86400 * 1000))
		: null;
	const writesSinceDream = countCommitsSince(paths.home, lastDreamAt);

	const duplicateCandidates = [
		...findDuplicateCandidates("PROFILE.md", view.profileRaw),
		...findDuplicateCandidates("PROJECTS.md", view.projectsRaw),
	];

	const reasons: string[] = [];
	if (view.profilePct >= config.limits.dreamWarnPct) {
		reasons.push(`PROFILE.md 水位达 ${view.profilePct}%（建议合并精简）`);
	}
	if (globalPct >= config.limits.dreamWarnPct) {
		reasons.push(`PROJECTS.md 全局区水位达 ${globalPct}%`);
	}
	if (maxProjectPct >= config.limits.dreamWarnPct && maxProjectHeading) {
		reasons.push(`PROJECTS.md [${maxProjectHeading}] 水位达 ${maxProjectPct}%`);
	}
	if (daysSinceDream !== null && daysSinceDream >= config.limits.dreamMaxDays && writesSinceDream > 0) {
		reasons.push(`距上次整理已过 ${daysSinceDream} 天`);
	}
	if (writesSinceDream >= config.limits.dreamMaxWrites) {
		reasons.push(`距上次整理已累计 ${writesSinceDream} 次写入`);
	}
	if (duplicateCandidates.length > 0) {
		reasons.push(`检测到 ${duplicateCandidates.length} 组疑似重复条目`);
	}

	const status = reasons.length > 0 ? "attention" : "healthy";
	const hint =
		status === "attention"
			? `💡 clue 记忆健康提醒：${reasons.join("；")}。有空时可说「做梦整理 / clue dream」做一次体检合并。`
			: null;

	return {
		status,
		reasons,
		hint,
		metrics: {
			profileChars: view.profileChars,
			profileLimit: config.limits.profileChars,
			profilePct: view.profilePct,
			globalChars: view.scoped.globalChars,
			globalLimit: config.limits.globalProjectChars,
			globalPct,
			maxProjectPct,
			maxProjectHeading,
			activePitfalls: pitfalls.length,
			pitfallsWithoutEvidence,
			daysSinceDream,
			writesSinceDream,
			duplicateCandidates,
		},
	};
}

export function buildDreamPacket(config: ClueConfig, paths: CluePaths, projectKey: string | null): string {
	const health = evaluateMemoryHealth(config, paths, projectKey);
	const view = readHotMemoryView(config, paths, projectKey);
	const pitfalls = listActivePitfalls(paths.dbPath);
	const recentCommits = getRecentMemoryCommits(paths.home, 12);

	const lines: string[] = [
		"=== CLUE DREAM（记忆健康体检与深度整理材料）===",
		`状态: ${health.status === "healthy" ? "健康" : "建议整理"}`,
		...(health.reasons.length > 0 ? [`触发信号: ${health.reasons.join("；")}`] : ["触发信号: 无明显超标（可做常规瘦身与纠错）"]),
		`水位: PROFILE ${health.metrics.profileChars}/${health.metrics.profileLimit} (${health.metrics.profilePct}%) | 全局工程 ${health.metrics.globalChars}/${health.metrics.globalLimit} (${health.metrics.globalPct}%) | 活跃踩坑 ${health.metrics.activePitfalls} 条（缺溯源 ${health.metrics.pitfallsWithoutEvidence} 条）`,
		"",
		view.formatted,
		"",
		"=== 活跃踩坑清单 ===",
		...(pitfalls.length > 0
			? pitfalls.map(
					p =>
						`- #${p.id} [${p.project}] 现象: ${p.symptom} | 根因: ${p.root_cause}${p.evidence ? ` | 溯源: ${p.evidence}` : " | (无溯源)"}`,
				)
			: ["(暂无)"]),
	];

	if (health.metrics.duplicateCandidates.length > 0) {
		lines.push(
			"",
			"=== 疑似重复条目候选 ===",
			...health.metrics.duplicateCandidates.map(
				d => `- [${d.file}] 相似度 ${d.similarity}: (${d.sectionA}) "${d.entryA}"  <->  (${d.sectionB}) "${d.entryB}"`,
			),
		);
	}

	if (recentCommits.length > 0) {
		lines.push("", "=== 最近记忆提交记录 ===", ...recentCommits.map(c => `  ${c}`));
	}

	lines.push(
		"",
		"【做梦整理输出要求】",
		"1. 重点检查四件事：(a) 有无过时或互相冲突的条目；(b) 有无可以合并精简的重复项；(c) 有无应冷热升降级的条目（把一次性坑点沉进 pitfalls，把高频通用原则提炼进热层）；(d) 踩坑记录是否缺 `evidence` 溯源或已有更优解法。",
		"2. 严禁擅自直接写入！请先向用户输出一份清晰编号的「做梦整理提案草稿」（列出删/并/改哪条、预计字数变化），等用户批复后再通过 `clue curate` / `clue pitfall` 落盘，最后运行 `clue dream --mark-done` 刷新健康周期。",
	);

	return lines.join("\n");
}
