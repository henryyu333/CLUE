import type { ClueConfig, CluePaths } from "./config.ts";
import { readIntentStore } from "./intents.ts";
import { LEDGER_KINDS, listActive, rowHaystack, rowSummary, type LedgerKind } from "./ledger.ts";
import { parseSectionedMarkdown } from "./markdown.ts";
import { existsSync, readFileSync } from "node:fs";
import { recallSessions } from "../recall/store.ts";

export interface FlashbackItem {
	key: string;
	kind: LedgerKind | "session";
	score: number;
	line: string;
}

export interface FlashbackResult {
	notice: string | null;
	items: FlashbackItem[];
}

// Generic prose, broad dev vocabulary and platform names: never specific enough to trigger alone.
const ASCII_STOPWORDS = new Set([
	"the", "and", "for", "that", "this", "with", "from", "have", "what", "when", "where", "which", "would",
	"could", "should", "about", "there", "their", "please", "thanks", "thank", "hello", "help", "just",
	"like", "make", "need", "want", "code", "file", "files", "test", "tests", "work", "done", "okay", "sure",
	"good", "fine", "true", "false", "null", "none", "auto", "only", "also", "more", "some", "into", "over",
	"then", "than", "here", "does", "dont", "cant", "will", "your", "mine", "ours", "clue", "project", "memory",
	"github", "claude", "chatgpt", "openai", "gemini", "codex", "hermes", "opencode", "cursor", "windsurf",
	"harness", "harnesses", "agent", "agents", "model", "models", "release", "releases", "version", "versions",
	"plugin", "plugins", "hook", "hooks", "skill", "skills", "local", "cloud", "sync", "vector", "prompt",
	"system", "config", "update", "build", "error", "errors", "issue", "issues", "commit", "branch", "merge",
	"main", "push", "pull", "draft", "drafts", "review", "check", "start", "close", "status", "search", "recall",
	"index", "dream", "export", "install", "doctor", "debug", "readme", "markdown", "json", "yaml", "sqlite",
	"script", "window", "windows", "panel", "button", "style", "color", "click", "focus", "input", "output", "value",
	"string", "number", "array", "object", "async", "await", "return", "import", "const", "function", "class",
	"interface", "type", "tool", "tools", "chat", "session", "sessions", "note", "notes", "rule", "rules",
	"macos", "linux", "darwin", "win10", "win11", "ios", "android", "mac", "apple", "web", "browser",
	"guard", "python", "typescript", "javascript", "golang", "rust", "node", "bun", "npm", "brew", "homebrew",
]);

const CJK_STOP_RE =
	/(?:今天|明天|昨天|之前|以前|以后|之后|一下|帮我|看看|怎么|为什么|出现|遇到|问题|处理|修复|解决|关于|时候|还是|依然|不能|无法|一个|这个|那个|可以|没有|需要|觉得|应该|目前|现在|已经|如果|或者|就是|然后|因为|所以|但是|不过|其实|大概|一下吧|好的|谢谢|继续|没事了|先这样|收尾|收工|开工|记忆|系统|工具|模型|版本|发布|网页版|对齐|完美|放心|直接|向量|语义|检索|需要吗|可以吗|对吧|对吗|草稿|确认|写入)/g;

/** Explicit look-back phrasing only. Bare "之前/以前" usually mean "before (doing X)", not "last time". */
const RETROSPECTIVE_RE =
	/(?:上次|那次|当初|之前那个|之前的那个|以前那个|之前(?:踩过|聊过|说过|定过|做过|讨论过)|记得.{0,12}(?:吗|么)|原来怎么|后来怎么|怎么定的|为啥选|为什么选|last\s+time|previously|earlier\s+we|what\s+did\s+we\s+decide)/i;

interface ExtractedSignals {
	strongTokens: string[];
	cjkTokens: string[];
	isRetrospective: boolean;
}

function isHighSpecificityToken(rawTok: string, lower: string, projectNames: ReadonlySet<string>): boolean {
	if (ASCII_STOPWORDS.has(lower) || projectNames.has(lower)) return false;
	if (lower.length < 3) return false;
	if (/[_:/.-]/.test(rawTok) || /\d/.test(rawTok)) return true;
	if (/[a-z][A-Z]/.test(rawTok) || /^[A-Z]{3,}$/.test(rawTok)) return true;
	return lower.length >= 5;
}

/** Every project key known to memory: these name a scope, never a topic. */
function knownProjectNames(config: ClueConfig, paths: CluePaths, projectKey: string | null): Set<string> {
	const names = new Set<string>(Object.keys(readIntentStore(paths.intentsPath)));
	if (projectKey) names.add(projectKey.toLowerCase());
	if (existsSync(paths.projectsPath)) {
		for (const heading of parseSectionedMarkdown(readFileSync(paths.projectsPath, "utf8")).keys()) {
			const m = heading.match(/^project:\s*(.+)$/i);
			if (m) names.add(m[1]!.trim().toLowerCase());
		}
	}
	for (const r of config.workspaceRoots) names.add(r);
	return names;
}

export function extractFlashbackSignals(
	promptText: string,
	projectNames: ReadonlySet<string> = new Set(),
): ExtractedSignals | null {
	const cleaned = promptText.replace(/```[\s\S]*?```/g, " ").trim();
	if (!cleaned) return null;
	const compact = cleaned.replace(/[\s，。！？,.!~～:：;；"'`]+/g, "");
	if ([...compact].length <= 6 && !/[a-zA-Z0-9_-]{3,}/.test(cleaned)) return null;

	const strongSet = new Set<string>();
	for (const m of cleaned.matchAll(/[a-zA-Z][a-zA-Z0-9_.:/-]{2,}|[A-Z0-9_]{3,}|[a-z]+_[a-z0-9_]+/g)) {
		const rawTok = m[0].replace(/^[:./-]+|[:./-]+$/g, "");
		const lower = rawTok.toLowerCase();
		if (!isHighSpecificityToken(rawTok, lower, projectNames)) continue;
		strongSet.add(lower);
		if (strongSet.size >= 10) break;
	}

	const cjkSet = new Set<string>();
	for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
		for (const seg of m[0].replace(CJK_STOP_RE, " ").split(/\s+/).filter(Boolean)) {
			const chars = [...seg];
			if (chars.length >= 2 && chars.length <= 5) cjkSet.add(seg);
			else if (chars.length > 5) {
				for (let i = 0; i <= chars.length - 2 && cjkSet.size < 10; i += 2) cjkSet.add(chars.slice(i, i + 2).join(""));
			}
			if (cjkSet.size >= 10) break;
		}
		if (cjkSet.size >= 10) break;
	}

	if (strongSet.size === 0 && cjkSet.size === 0) return null;
	return { strongTokens: [...strongSet], cjkTokens: [...cjkSet], isRetrospective: RETROSPECTIVE_RE.test(cleaned) };
}

function truncateLine(text: string, maxLen: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

const KIND_TAG: Record<LedgerKind, string> = { pitfall: "Pitfall", decision: "Decision", note: "Note" };

/**
 * Pure-local high-threshold flashback for prompt hooks. Silent unless a specific technical token
 * (or two distinct CJK topic words) overlaps an active memory row. Never counts as a "hit":
 * hits only come from explicit lookups so they stay a trustworthy usefulness signal.
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
	const signals = extractFlashbackSignals(promptText, knownProjectNames(config, paths, projectKey));
	if (!signals) return { notice: null, items: [] };

	const seen = alreadyShownKeys ?? new Set<string>();
	const candidates: FlashbackItem[] = [];
	for (const kind of LEDGER_KINDS) {
		for (const row of listActive(paths, kind)) {
			const key = `${kind}:${row.id}`;
			if (seen.has(key)) continue;
			const hay = rowHaystack(kind, row);
			const text = `${hay.tags} ${hay.body}`;
			const strong = signals.strongTokens.filter(t => text.includes(t));
			const cjk = signals.cjkTokens.filter(t => text.includes(t));
			if (strong.length === 0 && cjk.length < 2) continue;
			const matched = [...strong, ...cjk];
			const score = strong.length * 3 + cjk.length * 1.5 + (projectKey && row.project === projectKey.toLowerCase() ? 1 : 0);
			const ev = row.evidence ? `（溯源 ${truncateLine(row.evidence, 36)}）` : "";
			candidates.push({
				key,
				kind,
				score,
				line: `• [${KIND_TAG[kind]} #${row.id}] ${truncateLine(rowSummary(kind, row), 88)}${ev} → 详情 \`clue search "${matched[0]}"\``,
			});
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	const picked = candidates.slice(0, 2);

	if (picked.length < 2 && signals.isRetrospective && signals.strongTokens.length + signals.cjkTokens.length >= 2) {
		const queryTokens = [...signals.strongTokens.slice(0, 3), ...signals.cjkTokens.slice(0, 2)].slice(0, 4);
		const recallHits = recallSessions(paths.recallDbPath, {
			query: queryTokens.join(" "),
			project: projectKey,
			limit: 4,
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

	if (picked.length === 0) return { notice: null, items: [] };
	return {
		notice: ["【clue 记忆闪回（本地匹配，仅供参考）】", ...picked.map(x => x.line)].join("\n"),
		items: picked,
	};
}
