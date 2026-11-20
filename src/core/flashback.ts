import type { ClueConfig, CluePaths } from "./config.ts";
import { listActiveDecisions, recordDecisionHit, type DecisionRow } from "./decisions.ts";
import { listActivePitfalls, recordPitfallHit, type PitfallRow } from "./pitfalls.ts";
import { recallSessions } from "../recall/store.ts";

export interface FlashbackItem {
	key: string;
	kind: "pitfall" | "decision" | "session";
	score: number;
	line: string;
	numericId?: number;
}

export interface FlashbackResult {
	notice: string | null;
	items: FlashbackItem[];
}

const ASCII_STOPWORDS = new Set([
	"the", "and", "for", "that", "this", "with", "from", "have", "what", "when", "where", "which", "would",
	"could", "should", "about", "there", "their", "please", "thanks", "thank", "hello", "help", "just",
	"like", "make", "need", "want", "code", "file", "files", "test", "tests", "work", "done", "okay", "sure",
	"good", "fine", "true", "false", "null", "none", "auto", "only", "also", "more", "some", "into", "over",
	"then", "than", "here", "does", "dont", "cant", "will", "your", "mine", "ours", "clue", "project", "memory",
]);

const CJK_STOP_RE =
	/(?:今天|明天|昨天|一下|帮我|看看|怎么|为什么|出现|遇到|问题|处理|修复|解决|关于|时候|还是|依然|不能|无法|一个|这个|那个|可以|没有|需要|觉得|应该|目前|现在|已经|如果|或者|就是|然后|因为|所以|但是|不过|其实|大概|一下吧|好的|谢谢|继续|没事了|先这样|收尾|收工|开工)/g;

const RETROSPECTIVE_RE =
	/(?:上次|之前|以前|先前|那次|记得|聊过|定过|怎么定|为啥选|为什么选|之前踩过|原来怎么|当初|回顾|last\s+time|previously|earlier\s+we|what\s+did\s+we\s+decide)/i;

interface ExtractedSignals {
	strongTokens: string[];
	cjkTokens: string[];
	isRetrospective: boolean;
}

function stripCodeFences(raw: string): string {
	return raw.replace(/```[\s\S]*?```/g, " ").trim();
}

export function extractFlashbackSignals(promptText: string): ExtractedSignals | null {
	const cleaned = stripCodeFences(promptText);
	if (!cleaned) return null;

	const compact = cleaned.replace(/[\s，。！？,.!~～:：;；"'`]+/g, "");
	const hasAsciiIdentifier = /[a-zA-Z0-9_-]{3,}/.test(cleaned);
	// Skip short acknowledgements/chitchat immediately (<1ms)
	if ([...compact].length <= 6 && !hasAsciiIdentifier) return null;

	const strongSet = new Set<string>();
	for (const m of cleaned.matchAll(/[a-zA-Z][a-zA-Z0-9_.:/-]{2,}|[A-Z0-9_]{3,}|[a-z]+_[a-z0-9_]+/g)) {
		const tok = m[0].replace(/^[:./-]+|[:./-]+$/g, "").toLowerCase();
		if (tok.length < 3 || ASCII_STOPWORDS.has(tok)) continue;
		strongSet.add(tok);
		if (strongSet.size >= 10) break;
	}

	const cjkSet = new Set<string>();
	for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
		const stripped = m[0].replace(CJK_STOP_RE, " ").trim();
		for (const seg of stripped.split(/\s+/).filter(Boolean)) {
			const chars = [...seg];
			if (chars.length >= 2 && chars.length <= 5) {
				cjkSet.add(seg);
			} else if (chars.length > 5) {
				for (let i = 0; i <= chars.length - 2 && cjkSet.size < 10; i += 2) {
					cjkSet.add(chars.slice(i, i + 2).join(""));
				}
			}
			if (cjkSet.size >= 10) break;
		}
		if (cjkSet.size >= 10) break;
	}

	const isRetrospective = RETROSPECTIVE_RE.test(cleaned);
	if (strongSet.size === 0 && cjkSet.size === 0) return null;
	return {
		strongTokens: [...strongSet],
		cjkTokens: [...cjkSet],
		isRetrospective,
	};
}

function scoreHaystack(
	haystack: string,
	itemProject: string,
	currentProject: string | null,
	signals: ExtractedSignals,
): { score: number; strongHits: number; cjkHits: number } {
	const lower = haystack.toLowerCase();
	let strongHits = 0;
	let cjkHits = 0;
	for (const tok of signals.strongTokens) {
		if (lower.includes(tok)) strongHits++;
	}
	for (const tok of signals.cjkTokens) {
		if (lower.includes(tok)) cjkHits++;
	}
	if (strongHits === 0 && cjkHits === 0) {
		return { score: 0, strongHits: 0, cjkHits: 0 };
	}
	let score = strongHits * 3 + cjkHits * 1.5;
	if (currentProject && itemProject.toLowerCase() === currentProject.toLowerCase()) {
		score += 1;
	}
	return { score, strongHits, cjkHits };
}

function truncateLine(text: string, maxLen: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

/**
 * Pure-local (<15ms), high-threshold proactive memory flashback for UserPromptSubmit / PreInvocation hooks.
 * Strictly silent (returns null) unless strong technical/retrospective overlap is detected.
 */
export function buildProactiveFlashback(
	config: ClueConfig,
	paths: CluePaths,
	promptText: string,
	projectKey: string | null,
	alreadyShownKeys?: ReadonlySet<string>,
	currentConversationId?: string,
): FlashbackResult {
	if (!config.autoRecall) return { notice: null, items: [] };
	const signals = extractFlashbackSignals(promptText);
	if (!signals) return { notice: null, items: [] };

	const candidates: FlashbackItem[] = [];
	const seen = alreadyShownKeys ?? new Set<string>();

	// 1) Score active pitfalls (in-memory over active set — tiny & <2ms)
	const pitfalls: PitfallRow[] = listActivePitfalls(paths.dbPath);
	for (const p of pitfalls) {
		const key = `pitfall:#${p.id}`;
		if (seen.has(key)) continue;
		const hay = `${p.project} ${p.tags} ${p.symptom} ${p.root_cause}`;
		const { score, strongHits, cjkHits } = scoreHaystack(hay, p.project, projectKey, signals);
		// High-confidence gate: >=1 strong technical token OR >=2 distinct CJK topic tokens
		if (strongHits >= 1 || cjkHits >= 2) {
			const hintQuery = signals.strongTokens[0] ?? signals.cjkTokens[0] ?? p.tags.split(",")[0]?.trim() ?? "";
			const ev = p.evidence?.trim() ? `（溯源 ${truncateLine(p.evidence, 36)}）` : "";
			candidates.push({
				key,
				kind: "pitfall",
				score: score + 0.2, // slight preference for objective pitfalls
				numericId: p.id,
				line: `• [Pitfall #${p.id}] ${truncateLine(p.root_cause, 88)}${ev} → 详情 \`clue search "${hintQuery}"\``,
			});
		}
	}

	// 2) Score active decisions
	const decisions: DecisionRow[] = listActiveDecisions(paths.dbPath);
	for (const d of decisions) {
		const key = `decision:#${d.id}`;
		if (seen.has(key)) continue;
		const hay = `${d.project} ${d.topic} ${d.decision} ${d.rationale} ${d.assumptions}`;
		const { score, strongHits, cjkHits } = scoreHaystack(hay, d.project, projectKey, signals);
		if (strongHits >= 1 || cjkHits >= 2) {
			const hintQuery = d.topic || signals.strongTokens[0] || signals.cjkTokens[0] || "";
			const revisit = d.revisit_when?.trim() ? `（推翻条件：${truncateLine(d.revisit_when, 36)}）` : "";
			candidates.push({
				key,
				kind: "decision",
				score,
				numericId: d.id,
				line: `• [Decision #${d.id}] ${truncateLine(d.decision, 84)}${revisit} → 详情 \`clue search "${hintQuery}"\``,
			});
		}
	}

	candidates.sort((a, b) => b.score - a.score);
	const picked = candidates.slice(0, 2);

	// 3) Optional verbatim recall hint ONLY when user explicitly refers to past discussions (or strong multi-token technical match with <2 structured hits)
	if (picked.length < 2 && (signals.isRetrospective || signals.strongTokens.length >= 2)) {
		const queryTokens = [...signals.strongTokens.slice(0, 3), ...signals.cjkTokens.slice(0, 2)].slice(0, 4);
		if (queryTokens.length > 0) {
			const recallHits = recallSessions(paths.recallDbPath, {
				query: queryTokens.join(" "),
				project: projectKey,
				limit: 3,
				includeNoise: false,
			});
			for (const h of recallHits) {
				if (currentConversationId && h.sessionId.includes(currentConversationId)) continue;
				const key = `session:${h.sessionId}`;
				if (seen.has(key)) continue;
				const shortId = h.sessionId.length > 22 ? h.sessionId.slice(0, 22) : h.sessionId;
				picked.push({
					key,
					kind: "session",
					score: 3,
					line: `• [过往对话 ${shortId} | ${h.harness} | ${h.ts.slice(0, 10)}] "${truncateLine(h.snippet, 74)}" → 展开 \`clue show ${shortId} --around ${h.seq}\``,
				});
				break;
			}
		}
	}

	if (picked.length === 0) return { notice: null, items: [] };

	// Telemetry accounting (purely local, non-blocking)
	const pitfallIds = picked.filter(x => x.kind === "pitfall" && x.numericId).map(x => x.numericId!);
	const decisionIds = picked.filter(x => x.kind === "decision" && x.numericId).map(x => x.numericId!);
	if (pitfallIds.length > 0) recordPitfallHit(paths.dbPath, pitfallIds);
	if (decisionIds.length > 0) recordDecisionHit(paths.dbPath, decisionIds);

	const notice = ["【clue 记忆闪回（本地高置信命中，仅供参考）】", ...picked.map(x => x.line)].join("\n");
	return { notice, items: picked };
}
