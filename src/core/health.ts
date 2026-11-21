import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ClueConfig, CluePaths } from "./config.ts";
import { countCommitsSince, getRecentMemoryCommits } from "./git.ts";
import { formatIntentCard, readIntentStore } from "./intents.ts";
import { atomicWriteFileSync } from "./lock.ts";
import { LEDGER_KINDS, ledgerLabel, listActive, rowSummary, type LedgerKind } from "./ledger.ts";
import { parseSectionedMarkdown, readHotMemoryView } from "./markdown.ts";

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

export interface EvidenceCheckItem {
	kind: LedgerKind;
	id: number;
	project: string;
	summary: string;
	evidence: string;
	status: "valid" | "stale-file-missing" | "stale-file-changed" | "unverifiable";
	detail: string;
}

export interface ColdMemoryItem {
	kind: LedgerKind;
	id: number;
	project: string;
	summary: string;
	/** Days since the row was last written or explicitly confirmed (verify). */
	ageDays: number;
	/** Days since a model last looked it up explicitly, or null if never. */
	daysSinceHit: number | null;
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
		active: Record<LedgerKind, number>;
		withoutEvidence: number;
		totalHits: number;
		staleEvidenceCount: number;
		daysSinceDream: number | null;
		writesSinceDream: number;
		duplicateCandidates: DuplicateCandidate[];
		evidenceChecks: EvidenceCheckItem[];
		coldItems: ColdMemoryItem[];
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

function resolveRepoRoot(cwd?: string): string | null {
	if (!cwd) return null;
	const resolved = resolve(cwd);
	try {
		const commonDir = execFileSync("git", ["-C", resolved, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (commonDir && basename(commonDir) === ".git") {
			return dirname(commonDir);
		}
	} catch {
		// fall back to cwd directly
	}
	return resolved;
}

/**
 * Zero-token local verification of file paths and git commits referenced in `evidence`.
 */
export function verifyEvidenceAnchor(
	evidence: string,
	cwd?: string,
): { status: EvidenceCheckItem["status"]; detail: string } {
	const raw = evidence.trim();
	if (!raw) return { status: "unverifiable", detail: "无溯源锚点" };

	const repoRoot = resolveRepoRoot(cwd);
	if (!repoRoot) return { status: "unverifiable", detail: "未提供仓库目录" };

	// Extract relative file path like src/core/lock.ts#L1-L40 or cmd/app/main.go
	const pathMatch = raw.match(/\b((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,8})(?:#L\d+(?:-L?\d+)?)?\b/);
	const commitMatch = raw.match(/\bcommit\s+([0-9a-f]{7,40})\b/i);

	if (pathMatch) {
		const relPath = pathMatch[1]!;
		const absPath = join(repoRoot, relPath);
		if (!existsSync(absPath)) {
			return { status: "stale-file-missing", detail: `溯源文件已不存在：${relPath}` };
		}
		if (commitMatch) {
			const sha = commitMatch[1]!;
			try {
				execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
				const countOut = execFileSync("git", ["-C", repoRoot, "rev-list", "--count", `${sha}..HEAD`, "--", relPath], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				const commitsAfter = Number.parseInt(countOut, 10);
				if (Number.isFinite(commitsAfter) && commitsAfter >= 8) {
					return {
						status: "stale-file-changed",
						detail: `溯源文件 ${relPath} 在 ${sha} 之后已历经 ${commitsAfter} 次提交，建议核实是否仍成立`,
					};
				}
			} catch {
				// commit may belong to another repo; file still exists
			}
		}
		return { status: "valid", detail: `文件仍在：${relPath}` };
	}

	if (commitMatch) {
		const sha = commitMatch[1]!;
		try {
			execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
			return { status: "valid", detail: `commit ${sha} 在当前仓库有效` };
		} catch {
			return { status: "unverifiable", detail: `commit ${sha} 不在当前仓库（可能属于其他项目）` };
		}
	}

	return { status: "unverifiable", detail: "非文件路径/commit 溯源（如会话编号）" };
}

export function evaluateMemoryHealth(
	config: ClueConfig,
	paths: CluePaths,
	projectKey: string | null,
	cwd?: string,
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

	const ledgers = LEDGER_KINDS.map(kind => ({ kind, rows: listActive(paths, kind) }));
	const active = Object.fromEntries(ledgers.map(l => [l.kind, l.rows.length])) as Record<LedgerKind, number>;
	const withoutEvidence = ledgers.reduce((n, l) => n + l.rows.filter(r => !r.evidence).length, 0);
	const totalHits = ledgers.reduce((n, l) => n + l.rows.reduce((m, r) => m + r.hit_count, 0), 0);

	const evidenceChecks: EvidenceCheckItem[] = [];
	const coldItems: ColdMemoryItem[] = [];
	const nowMs = Date.now();
	const daysAgo = (iso: string) => Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 86_400_000));

	for (const { kind, rows } of ledgers) {
		for (const r of rows) {
			const summary = rowSummary(kind, r);
			const isCurrentOrGlobal = !projectKey || r.project === "global" || r.project === projectKey.toLowerCase();
			if (cwd && r.evidence && isCurrentOrGlobal) {
				const res = verifyEvidenceAnchor(r.evidence, cwd);
				if (res.status === "stale-file-missing" || res.status === "stale-file-changed") {
					evidenceChecks.push({ kind, id: r.id, project: r.project, summary, evidence: r.evidence, status: res.status, detail: res.detail });
				}
			}
			// Cold = nobody confirmed it AND nobody looked it up for `coldDays`. Flashback shows never count.
			const ageDays = daysAgo(r.verified_at > r.updated_at ? r.verified_at : r.updated_at);
			const daysSinceHit = r.last_hit_at ? daysAgo(r.last_hit_at) : null;
			if (ageDays >= config.limits.coldDays && (daysSinceHit === null || daysSinceHit >= config.limits.coldDays)) {
				coldItems.push({ kind, id: r.id, project: r.project, summary, ageDays, daysSinceHit });
			}
		}
	}

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
	if (evidenceChecks.length > 0) {
		reasons.push(`检测到 ${evidenceChecks.length} 条记忆溯源疑似过期`);
	}
	if (coldItems.length > 0) {
		reasons.push(`${coldItems.length} 条记忆超过 ${config.limits.coldDays} 天没确认也没被查过`);
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
			active,
			withoutEvidence,
			totalHits,
			staleEvidenceCount: evidenceChecks.length,
			daysSinceDream,
			writesSinceDream,
			duplicateCandidates,
			evidenceChecks,
			coldItems,
		},
	};
}

export function buildDreamPacket(
	config: ClueConfig,
	paths: CluePaths,
	projectKey: string | null,
	cwd?: string,
): string {
	const health = evaluateMemoryHealth(config, paths, projectKey, cwd);
	const view = readHotMemoryView(config, paths, projectKey);
	const intentStore = readIntentStore(paths.intentsPath);
	const ledgers = LEDGER_KINDS.map(kind => ({ kind, rows: listActive(paths, kind) }));
	const recentCommits = getRecentMemoryCommits(paths.home, 12);

	const intentKeys = Object.keys(intentStore).sort();
	const lines: string[] = [
		"=== CLUE DREAM（记忆健康体检与防腐烂整理材料）===",
		`状态: ${health.status === "healthy" ? "健康" : "建议整理"}`,
		...(health.reasons.length > 0 ? [`触发信号: ${health.reasons.join("；")}`] : ["触发信号: 无明显超标（可做常规瘦身与纠错）"]),
		`指标: PROFILE ${health.metrics.profileChars}/${health.metrics.profileLimit} (${health.metrics.profilePct}%) | 意图卡 ${intentKeys.length} 个 | ${LEDGER_KINDS.map(k => `${ledgerLabel(k)} ${health.metrics.active[k]} 条`).join(" | ")} | 主动查阅 ${health.metrics.totalHits} 次 | 疑似过期溯源 ${health.metrics.staleEvidenceCount} 条`,
		"",
		view.formatted,
		"",
		"=== 项目 4 格意图卡清单 ===",
		...(intentKeys.length > 0
			? intentKeys.map(k => `[${k} · 更新 ${intentStore[k]!.updatedAt.slice(0, 10)}]\n${formatIntentCard(intentStore[k]!)}`)
			: ["(暂无)"]),
		...ledgers.flatMap(({ kind, rows }) => [
			"",
			`=== 活跃${ledgerLabel(kind)}清单 ===`,
			...(rows.length > 0
				? rows.map(
						r =>
							`- #${r.id} [${r.project}] ${rowSummary(kind, r)} | 最近确认 ${(r.verified_at || r.updated_at).slice(0, 10)} | 查阅 ${r.hit_count} 次${r.evidence ? ` | 溯源: ${r.evidence}` : " | (无溯源)"}`,
					)
				: ["(暂无)"]),
		]),
	];

	if (health.metrics.evidenceChecks.length > 0) {
		lines.push(
			"",
			"=== ⚠️ 溯源疑似过期告警（自动核验） ===",
			...health.metrics.evidenceChecks.map(
				e => `- [${e.kind} #${e.id} | ${e.project}] ${e.summary} -> ${e.detail}（原溯源：${e.evidence}）`,
			),
		);
	}

	if (health.metrics.coldItems.length > 0) {
		lines.push(
			"",
			`=== 冷门条目（≥${config.limits.coldDays} 天没确认、也没被查过） ===`,
			...health.metrics.coldItems.map(
				c =>
					`- [${c.kind} #${c.id} | ${c.project}] ${c.summary}（${c.ageDays} 天未确认，${c.daysSinceHit === null ? "从未被查过" : `${c.daysSinceHit} 天前被查过`}）`,
			),
		);
	}

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
		"1. 重点检查：(a) 溯源失效、过时或互相冲突的条目；(b) 误放进 PROFILE.md 的静态工作规则（规则属于 AGENTS.md）；(c) 意图卡是否与代码现状一致；(d) 冷门条目：仍成立就提 verify 草稿，已过时就提 delete/supersede 草稿；(e) 能合并的重复条目。",
		"2. 所有改动都用 clue 起草进待确认草稿箱，把完整草稿清单（编号 + 前后对比）给用户看，用户确认后 `clue apply`，最后运行 `clue dream --mark-done`。",
	);

	return lines.join("\n");
}
