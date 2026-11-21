import { existsSync, readFileSync } from "node:fs";
import type { CluePaths } from "./config.ts";
import { atomicWriteFileSync } from "./lock.ts";
import { scanMemoryContent } from "./security.ts";
import { readHitStats, type HitStat } from "./stats.ts";

/**
 * Ledgers are the append-mostly memory tables (pitfalls, decisions, free-form notes).
 * The git-tracked `<kind>.jsonl` file is the single source of truth: reads parse it directly,
 * writes rewrite it atomically, and `git revert` therefore restores every visible state exactly.
 * Hit telemetry lives outside git in `stats.json` so lookups never dirty the history.
 */
export type LedgerKind = "pitfall" | "decision" | "note";
export const LEDGER_KINDS: readonly LedgerKind[] = ["pitfall", "decision", "note"];

export interface LedgerRowBase {
	id: number;
	project: string;
	tags: string;
	evidence: string;
	status: "active" | "superseded" | "reverted";
	superseded_by: number | null;
	verified_at: string;
	created_at: string;
	updated_at: string;
}

export interface PitfallRow extends LedgerRowBase {
	symptom: string;
	root_cause: string;
	historical_fix: string;
	rethink_hint: string;
}

export interface DecisionRow extends LedgerRowBase {
	topic: string;
	decision: string;
	rationale: string;
	assumptions: string;
	revisit_when: string;
}

export interface NoteRow extends LedgerRowBase {
	content: string;
}

export type LedgerRow = PitfallRow | DecisionRow | NoteRow;

/** A row joined with its out-of-git hit telemetry. */
export type WithHits<T> = T & { hit_count: number; last_hit_at: string };

export interface LedgerMutationRequest {
	op: "add" | "update" | "supersede" | "verify" | "revert" | "delete";
	/** One-line human summary shown in the draft box and receipt. */
	reason?: string;
	id?: number;
	project?: string;
	tags?: string;
	evidence?: string;
	// pitfall
	symptom?: string;
	rootCause?: string;
	historicalFix?: string;
	rethinkHint?: string;
	// decision
	topic?: string;
	decision?: string;
	rationale?: string;
	assumptions?: string;
	revisitWhen?: string;
	// note
	content?: string;
}

interface KindSpec {
	label: string;
	file: (p: CluePaths) => string;
	/** request field -> row column, for kind-specific text fields */
	fields: ReadonlyArray<readonly [keyof LedgerMutationRequest, string]>;
	required: readonly string[];
	/** Columns shown as the one-line summary. */
	summaryCol: string;
	ops: readonly LedgerMutationRequest["op"][];
}

const COMMON_OPS = ["add", "update", "supersede", "verify", "delete"] as const;

const SPECS: Record<LedgerKind, KindSpec> = {
	pitfall: {
		label: "踩坑",
		file: p => p.pitfallsPath,
		fields: [
			["symptom", "symptom"],
			["rootCause", "root_cause"],
			["historicalFix", "historical_fix"],
			["rethinkHint", "rethink_hint"],
		],
		required: ["symptom", "root_cause", "historical_fix", "rethink_hint"],
		summaryCol: "root_cause",
		ops: COMMON_OPS,
	},
	decision: {
		label: "关键决定",
		file: p => p.decisionsPath,
		fields: [
			["topic", "topic"],
			["decision", "decision"],
			["rationale", "rationale"],
			["assumptions", "assumptions"],
			["revisitWhen", "revisit_when"],
		],
		required: ["decision", "rationale"],
		summaryCol: "decision",
		ops: [...COMMON_OPS, "revert"],
	},
	note: {
		label: "记忆",
		file: p => p.notesPath,
		fields: [["content", "content"]],
		required: ["content"],
		summaryCol: "content",
		ops: COMMON_OPS,
	},
};

/** Persisted columns, in stable order, per kind. Unknown/legacy keys (e.g. old hit_count) are dropped on write. */
function persistedColumns(kind: LedgerKind): string[] {
	return [
		"id",
		"project",
		"tags",
		...SPECS[kind].fields.map(([, col]) => col),
		"evidence",
		"status",
		"superseded_by",
		"verified_at",
		"created_at",
		"updated_at",
	];
}

export function ledgerLabel(kind: LedgerKind): string {
	return SPECS[kind].label;
}

export function ledgerFile(paths: CluePaths, kind: LedgerKind): string {
	return SPECS[kind].file(paths);
}

export function normalizeLedgerRow(kind: LedgerKind, raw: Record<string, unknown>): LedgerRow {
	const out: Record<string, unknown> = {};
	for (const col of persistedColumns(kind)) {
		const v = raw[col];
		if (col === "id") out.id = Number(v);
		else if (col === "superseded_by") out.superseded_by = v === null || v === undefined || v === "" ? null : Number(v);
		else if (col === "status") out.status = v === "superseded" || v === "reverted" ? v : "active";
		else if (col === "project") out.project = String(v ?? "global").toLowerCase() || "global";
		else out[col] = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
	}
	return out as unknown as LedgerRow;
}

export function readLedger<T extends LedgerRow = LedgerRow>(paths: CluePaths, kind: LedgerKind): T[] {
	const file = ledgerFile(paths, kind);
	if (!existsSync(file)) return [];
	const rows: T[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(normalizeLedgerRow(kind, JSON.parse(line) as Record<string, unknown>) as T);
		} catch {
			// A corrupt line is surfaced by the integrity check (git diff); never crash reads.
		}
	}
	return rows.sort((a, b) => a.id - b.id);
}

export function writeLedger(paths: CluePaths, kind: LedgerKind, rows: readonly LedgerRow[], readOnly: boolean): void {
	const cols = persistedColumns(kind);
	const lines = [...rows]
		.sort((a, b) => a.id - b.id)
		.map(r => {
			const ordered: Record<string, unknown> = {};
			for (const c of cols) ordered[c] = (r as unknown as Record<string, unknown>)[c];
			return JSON.stringify(ordered);
		});
	atomicWriteFileSync(ledgerFile(paths, kind), lines.length > 0 ? `${lines.join("\n")}\n` : "", { readOnly });
}

function withHits<T extends LedgerRow>(kind: LedgerKind, rows: T[], stats: Record<string, HitStat>): WithHits<T>[] {
	return rows.map(r => {
		const s = stats[`${kind}:${r.id}`];
		return { ...r, hit_count: s?.count ?? 0, last_hit_at: s?.lastAt ?? "" };
	});
}

function freshness(r: LedgerRow): string {
	return r.verified_at > r.updated_at ? r.verified_at : r.updated_at;
}

/** Active rows, current project first, then global, then most recently confirmed/updated. */
export function listActive<T extends LedgerRow>(
	paths: CluePaths,
	kind: LedgerKind,
	projectKey?: string | null,
): WithHits<T>[] {
	const proj = projectKey?.toLowerCase() ?? null;
	const rows = readLedger<T>(paths, kind).filter(
		r => r.status === "active" && (!proj || r.project === proj || r.project === "global"),
	);
	rows.sort((a, b) => {
		if (proj) {
			const pa = a.project === proj ? 0 : 1;
			const pb = b.project === proj ? 0 : 1;
			if (pa !== pb) return pa - pb;
		}
		return freshness(b).localeCompare(freshness(a));
	});
	return withHits(kind, rows, readHitStats(paths));
}

export function rowSummary(kind: LedgerKind, row: LedgerRow): string {
	return String((row as unknown as Record<string, unknown>)[SPECS[kind].summaryCol] ?? "");
}

/** Searchable text excluding the project key (project names are scope, not topic). */
export function rowHaystack(kind: LedgerKind, row: LedgerRow): { tags: string; body: string } {
	const rec = row as unknown as Record<string, unknown>;
	return {
		tags: row.tags.toLowerCase(),
		body: [...SPECS[kind].fields.map(([, col]) => String(rec[col] ?? "")), row.evidence].join(" ").toLowerCase(),
	};
}

// ---------------------------------------------------------------------------
// Search: small ledgers are scanned in memory; tags act as hand-written aliases.

const CJK_QUERY_STOP =
	/(?:今天|排查|一下|帮我|看看|怎么|为什么|出现|遇到|问题|处理|修复|解决|关于|时候|还是|依然|不能|无法|一个|这个|那个|决定|方案|之前|上次|以前)/g;

/**
 * Tokenize a query. `|` separates alternative phrasings (e.g. "打包崩溃 | makensis bad_alloc");
 * all phrasings are OR-ed so one search covers several wordings of the same idea.
 */
export function tokenizeQuery(query: string): string[] {
	const seen = new Set<string>();
	const tokens: string[] = [];
	const add = (t: string) => {
		const clean = t.trim().toLowerCase();
		if ([...clean].length < 2 || seen.has(clean)) return;
		seen.add(clean);
		tokens.push(clean);
	};
	for (const phrase of query.split("|")) {
		for (const m of phrase.matchAll(/[a-zA-Z0-9_.:/-]{2,}/g)) add(m[0].replace(/^[.:/-]+|[.:/-]+$/g, ""));
		for (const m of phrase.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
			for (const part of m[0].replace(CJK_QUERY_STOP, " ").split(/\s+/).filter(Boolean)) {
				const chars = [...part];
				if (chars.length <= 4) add(part);
				else for (let i = 0; i <= chars.length - 2; i++) add(chars.slice(i, i + 2).join(""));
			}
		}
	}
	return tokens.slice(0, 24);
}

export interface SearchHit<T extends LedgerRow> {
	row: WithHits<T>;
	score: number;
}

export function searchLedger<T extends LedgerRow>(
	paths: CluePaths,
	kind: LedgerKind,
	query: string,
	projectKey: string | null,
	limit = 4,
	includeInactive = false,
): WithHits<T>[] {
	const proj = projectKey?.toLowerCase() ?? null;
	const all = withHits(kind, readLedger<T>(paths, kind), readHitStats(paths)).filter(
		r => includeInactive || r.status === "active",
	);
	const tokens = tokenizeQuery(query);
	const projRank = (r: LedgerRow) => (proj && r.project === proj ? 0 : r.project === "global" ? 1 : 2);
	if (tokens.length === 0) {
		return all
			.filter(r => !proj || r.project === proj || r.project === "global")
			.sort((a, b) => projRank(a) - projRank(b) || freshness(b).localeCompare(freshness(a)))
			.slice(0, limit);
	}
	const hits: SearchHit<T>[] = [];
	for (const r of all) {
		const hay = rowHaystack(kind, r);
		let score = 0;
		for (const t of tokens) {
			if (hay.tags.includes(t)) score += 2;
			else if (hay.body.includes(t)) score += 1;
		}
		if (score > 0) hits.push({ row: r, score });
	}
	hits.sort(
		(a, b) => b.score - a.score || projRank(a.row) - projRank(b.row) || freshness(b.row).localeCompare(freshness(a.row)),
	);
	return hits.slice(0, limit).map(h => h.row);
}

// ---------------------------------------------------------------------------
// Mutations are planned purely (validation + diff) and only then written.

export interface LedgerPlan {
	ok: boolean;
	message: string;
	rows?: LedgerRow[];
	changes?: string[];
	id?: number;
}

function clip(text: string, max = 90): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function planLedgerMutation(
	kind: LedgerKind,
	rows: readonly LedgerRow[],
	req: LedgerMutationRequest,
	defaultProject: string | null,
	limits: { noteChars: number },
	now = new Date().toISOString(),
): LedgerPlan {
	const spec = SPECS[kind];
	const label = spec.label;
	if (!spec.ops.includes(req.op)) {
		return { ok: false, message: `${label}不支持操作 "${String(req.op)}"（可用：${spec.ops.join(" / ")}）。` };
	}

	const textFields: Array<[string, string]> = [];
	for (const [reqKey, col] of spec.fields) {
		const v = req[reqKey];
		if (typeof v === "string") textFields.push([col, v.trim()]);
	}
	for (const v of [req.tags, req.evidence, ...textFields.map(([, t]) => t)]) {
		if (!v) continue;
		const sec = scanMemoryContent(v);
		if (!sec.ok) return { ok: false, message: `安全安检拦截（${sec.rule}）：${sec.reason}` };
	}
	if (kind === "note" && typeof req.content === "string") {
		const len = [...req.content.trim()].length;
		if (len > limits.noteChars) {
			return { ok: false, message: `单条记忆超出上限（${len}/${limits.noteChars} 字），请压缩成一条独立事实。` };
		}
	}

	const next = rows.map(r => ({ ...r }));
	const find = (id: number | undefined) => (id ? next.find(r => r.id === id) : undefined);
	const proj = (req.project?.trim().toLowerCase() || defaultProject || "global").replace(/^project:\s*/, "");

	if (req.op === "delete" || req.op === "verify" || req.op === "revert" || req.op === "update") {
		const target = find(req.id);
		if (!target) return { ok: false, message: `${req.op} 需要有效的 id（未找到${label} #${req.id ?? "?"}）。` };
		if (req.op === "delete") {
			return {
				ok: true,
				message: `删除${label} #${target.id}`,
				rows: next.filter(r => r.id !== target.id),
				changes: [`- ${label} #${target.id}：${clip(rowSummary(kind, target))}`],
				id: target.id,
			};
		}
		if (req.op === "verify") {
			target.verified_at = now;
			if (req.evidence?.trim()) target.evidence = req.evidence.trim();
			return {
				ok: true,
				message: `确认${label} #${target.id} 仍是当前最优`,
				rows: next,
				changes: [`✓ ${label} #${target.id} 经本次复核仍成立：${clip(rowSummary(kind, target))}`],
				id: target.id,
			};
		}
		if (req.op === "revert") {
			target.status = "reverted";
			target.updated_at = now;
			return {
				ok: true,
				message: `撤销${label} #${target.id}`,
				rows: next,
				changes: [`↩ ${label} #${target.id} 标记为已撤销：${clip(rowSummary(kind, target))}`],
				id: target.id,
			};
		}
		// update
		const rec = target as unknown as Record<string, unknown>;
		const changes: string[] = [];
		const setCol = (col: string, value: string | undefined) => {
			if (value === undefined) return;
			if (rec[col] === value) return;
			if (spec.required.includes(col) && !value) return;
			changes.push(`~ ${label} #${target.id}.${col}：「${clip(String(rec[col] ?? ""), 40)}」→「${clip(value, 60)}」`);
			rec[col] = value;
		};
		for (const [col, val] of textFields) setCol(col, val);
		setCol("tags", req.tags?.trim());
		setCol("evidence", req.evidence?.trim());
		if (req.project?.trim()) setCol("project", proj);
		if (changes.length === 0) return { ok: false, message: `${label} #${target.id} 没有实质变动。` };
		target.updated_at = now;
		return { ok: true, message: `更新${label} #${target.id}`, rows: next, changes, id: target.id };
	}

	// add / supersede
	const values: Record<string, string> = Object.fromEntries(textFields);
	const missing = spec.required.filter(col => !values[col]);
	if (missing.length > 0) {
		return { ok: false, message: `新增${label}缺少必填字段：${missing.join(", ")}。` };
	}
	let old: LedgerRow | undefined;
	if (req.op === "supersede") {
		old = find(req.id);
		if (!old) return { ok: false, message: `supersede 需要被替换的旧${label} id（未找到 #${req.id ?? "?"}）。` };
		if (old.status !== "active") return { ok: false, message: `${label} #${old.id} 已是 ${old.status} 状态，不能再被替换。` };
	}
	const newId = next.reduce((m, r) => Math.max(m, r.id), 0) + 1;
	const row: Record<string, unknown> = {
		id: newId,
		project: req.project?.trim() ? proj : (old?.project ?? proj),
		tags: req.tags?.trim() ?? old?.tags ?? "",
		evidence: req.evidence?.trim() ?? "",
		status: "active",
		superseded_by: null,
		verified_at: now,
		created_at: now,
		updated_at: now,
	};
	for (const [, col] of spec.fields) row[col] = values[col] ?? "";
	next.push(row as unknown as LedgerRow);
	const changes = [`+ ${label} #${newId} [${String(row.project)}]：${clip(String(row[spec.summaryCol]))}`];
	if (old) {
		old.status = "superseded";
		old.superseded_by = newId;
		old.updated_at = now;
		changes.push(`  替换旧${label} #${old.id}：${clip(rowSummary(kind, old))}`);
	}
	return { ok: true, message: `${old ? "替换" : "新增"}${label} #${newId}`, rows: next, changes, id: newId };
}

// ---------------------------------------------------------------------------
// Guidance formatting shown to models on search.

export function formatPitfallGuidance(rows: ReadonlyArray<WithHits<PitfallRow>>): string {
	if (rows.length === 0) return "未检索到匹配的历史踩坑记录。";
	const header = [
		"【历史踩坑（参考基线，不是规定动作）】",
		"- `root_cause` 是当时验证过的根因；`historical_fix` 只是当时的解法。",
		"- 结合当前代码和你现在的能力，先想有没有更简单、更原生的做法；找到更优解就提一份 `supersede` 草稿替换旧条目。",
		"- 用过且确认旧解法仍是最优的，收尾时提一份 `verify` 草稿。",
		"",
	].join("\n");
	const items = rows.map(r => {
		const lines = [
			`[Pitfall #${r.id} | ${r.project}${r.tags ? ` | tags=${r.tags}` : ""}${r.verified_at ? ` | 最近确认 ${r.verified_at.slice(0, 10)}` : ""}]`,
			`  现象: ${r.symptom}`,
			`  根因: ${r.root_cause}`,
			`  当时解法: ${r.historical_fix}`,
			`  重思提示: ${r.rethink_hint}`,
		];
		if (r.evidence) lines.push(`  溯源: ${r.evidence}`);
		return lines.join("\n");
	});
	return `${header}${items.join("\n\n")}`;
}

export function formatDecisionGuidance(rows: ReadonlyArray<WithHits<DecisionRow>>): string {
	if (rows.length === 0) return "未检索到匹配的历史关键决定。";
	const header = [
		"【历史关键决定】",
		"- `decision` + `rationale` 说明当时为什么这样选；若 `assumptions` 已不成立或触发了 `revisit_when`，提一份 `supersede` 草稿。",
		"",
	].join("\n");
	const items = rows.map(r => {
		const lines = [
			`[Decision #${r.id} | ${r.project}${r.topic ? ` | topic=${r.topic}` : ""}${r.verified_at ? ` | 最近确认 ${r.verified_at.slice(0, 10)}` : ""}]`,
			`  决定: ${r.decision}`,
			`  原因: ${r.rationale}`,
		];
		if (r.assumptions) lines.push(`  前提: ${r.assumptions}`);
		if (r.revisit_when) lines.push(`  推翻条件: ${r.revisit_when}`);
		if (r.evidence) lines.push(`  溯源: ${r.evidence}`);
		return lines.join("\n");
	});
	return `${header}${items.join("\n\n")}`;
}

export function formatNoteGuidance(rows: ReadonlyArray<WithHits<NoteRow>>): string {
	if (rows.length === 0) return "未检索到匹配的记忆条目。";
	return [
		"【记忆条目】",
		...rows.map(
			r =>
				`[Note #${r.id} | ${r.project}${r.tags ? ` | tags=${r.tags}` : ""}] ${r.content}${r.evidence ? `（溯源: ${r.evidence}）` : ""}`,
		),
	].join("\n");
}
