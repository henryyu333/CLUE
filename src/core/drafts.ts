import { existsSync, readFileSync } from "node:fs";
import { isWorkerRole, type ClueConfig, type CluePaths, type IntentSlot } from "./config.ts";
import { commitMemoryGit, detectUnauthorizedChanges, restoreTruthFiles } from "./git.ts";
import { mutateProjectIntent, type IntentMutationRequest } from "./intents.ts";
import {
	LEDGER_KINDS,
	ledgerLabel,
	planLedgerMutation,
	readLedger,
	writeLedger,
	type LedgerKind,
	type LedgerMutationRequest,
} from "./ledger.ts";
import { atomicWriteFileSync, withMemoryLock } from "./lock.ts";
import { curateHotMemory, type CurateRequest } from "./markdown.ts";

/**
 * Draft box: models propose memory changes at any time; nothing is written until the user
 * confirms and `applyDrafts` commits the chosen drafts as ONE git commit with a system receipt.
 * Drafts are local scratch state (gitignored) shared by every harness on this machine.
 */
export type DraftKind = LedgerKind | "intent" | "profile" | "projects";
export const DRAFT_KINDS: readonly DraftKind[] = [...LEDGER_KINDS, "intent", "profile", "projects"];

type DraftRequest = LedgerMutationRequest | IntentMutationRequest | CurateRequest;

export interface Draft {
	id: number;
	kind: DraftKind;
	request: DraftRequest;
	preview: string[];
	skipSlots: IntentSlot[];
	harness: string;
	session: string;
	createdAt: string;
}

export interface DraftContext {
	projectKey: string | null;
	harness: string;
	session: string;
	skipSlots: IntentSlot[];
}

export interface DraftResult {
	ok: boolean;
	message: string;
	draft?: Draft;
}

export interface ApplyResult {
	ok: boolean;
	message: string;
	commit?: string | null;
	applied?: number[];
}

const KIND_LABEL: Record<DraftKind, string> = {
	pitfall: ledgerLabel("pitfall"),
	decision: ledgerLabel("decision"),
	note: ledgerLabel("note"),
	intent: "意图卡",
	profile: "个人名片",
	projects: "项目习惯",
};

const WORKER_REFUSAL = "当前是只读执行窗格（CLUE_ROLE=worker），不能起草或写入记忆。";

/**
 * Shared reporting constraints (BLUF + Controlled Language + Information Mapping + Progressive Disclosure / COGA)
 * so every model presents drafts and dream audits in crisp, scannable, non-jargon language.
 */
export const PLAIN_REPORT_RULES = [
	"汇报给用户拍板时，严格遵守 4 条表达约束：",
	"  - 结论前置：开头 1 句话报整体状态和草稿总数。",
	"  - 零黑话与零隐含前提：正文禁止直出内部字段名（如 project/evidence/verified_at）、代码函数名、文件路径或提交号；提旧记忆编号必须自带 10 字以内的人话标题。",
	"  - 固定三段积木：每条按草稿编号写清「哪条记忆（新增/改旧）→ 怎么改 → 为什么改」，限 2~3 行。",
	"  - 细节后置与低摩擦结尾：技术依据默认不展开（用户追问再给）；结尾直接给简短回复选项（如「全过 / 报编号 / 不改」）。",
].join("\n");

export function readDrafts(paths: CluePaths): Draft[] {
	if (!existsSync(paths.draftsPath)) return [];
	const out: Draft[] = [];
	for (const line of readFileSync(paths.draftsPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Draft);
		} catch {
			// skip corrupt scratch lines
		}
	}
	return out.sort((a, b) => a.id - b.id);
}

function writeDrafts(paths: CluePaths, drafts: readonly Draft[]): void {
	atomicWriteFileSync(paths.draftsPath, drafts.length > 0 ? `${drafts.map(d => JSON.stringify(d)).join("\n")}\n` : "");
}

function isLedgerKind(kind: DraftKind): kind is LedgerKind {
	return (LEDGER_KINDS as readonly string[]).includes(kind);
}

/** Execute (or dry-run) one draft against the current truth files. */
function runDraft(
	config: ClueConfig,
	paths: CluePaths,
	kind: DraftKind,
	request: DraftRequest,
	projectKey: string | null,
	skipSlots: readonly IntentSlot[],
	dryRun: boolean,
): { ok: boolean; message: string; changes: string[] } {
	if (isLedgerKind(kind)) {
		// The draft kind fixes the request shape; it was validated by the same planner when drafted.
		const req = request as LedgerMutationRequest;
		const plan = planLedgerMutation(kind, readLedger(paths, kind), req, projectKey, config.limits);
		if (!plan.ok) return { ok: false, message: plan.message, changes: [] };
		if (!dryRun) writeLedger(paths, kind, plan.rows!, config.readOnlyGuard);
		const changes = plan.changes ?? [];
		const isNew = req.op === "add" || req.op === "supersede";
		return {
			ok: true,
			message: plan.message,
			changes: dryRun && isNew ? changes.map(c => c.replace(`#${plan.id}`, "#新")) : changes,
		};
	}
	if (kind === "intent") {
		const res = mutateProjectIntent(config, paths, { ...(request as IntentMutationRequest), dryRun }, projectKey, skipSlots);
		return { ok: res.ok, message: res.message, changes: res.changes ?? [] };
	}
	const res = curateHotMemory(config, paths, { ...(request as CurateRequest), target: kind, dryRun }, projectKey);
	if (res.ok && (res.changes ?? []).length === 0) return { ok: false, message: "没有实质条目变动。", changes: [] };
	return { ok: res.ok, message: res.message, changes: res.changes ?? [] };
}

/** Validate a proposed change and park it in the draft box. Nothing in memory changes. */
export function addDraft(
	config: ClueConfig,
	paths: CluePaths,
	kind: DraftKind,
	request: DraftRequest,
	ctx: DraftContext,
): DraftResult {
	if (isWorkerRole()) return { ok: false, message: WORKER_REFUSAL };
	if (!DRAFT_KINDS.includes(kind)) return { ok: false, message: `未知草稿类型：${String(kind)}` };
	// Pin the project now for new entries/intent cards so applying from another directory targets the same project.
	// Existing-row ops (update/supersede/verify/delete/revert) keep the target row's project unless explicitly passed.
	const pinned = { ...request } as DraftRequest & { project?: string; op?: string };
	const needsDefaultProject = kind === "intent" || (isLedgerKind(kind) && (!pinned.op || pinned.op === "add"));
	if (needsDefaultProject && !pinned.project?.trim()) {
		pinned.project = kind === "note" ? "global" : (ctx.projectKey ?? (kind === "intent" ? undefined : "global"));
	}
	const check = runDraft(config, paths, kind, pinned, ctx.projectKey, ctx.skipSlots, true);
	if (!check.ok) return { ok: false, message: `草稿未通过校验：${check.message}` };

	return withMemoryLock(paths.lockPath, () => {
		const drafts = readDrafts(paths);
		const draft: Draft = {
			id: drafts.reduce((m, d) => Math.max(m, d.id), 0) + 1,
			kind,
			request: pinned,
			preview: check.changes,
			skipSlots: ctx.skipSlots,
			harness: ctx.harness,
			session: ctx.session,
			createdAt: new Date().toISOString(),
		};
		writeDrafts(paths, [...drafts, draft]);
		return {
			ok: true,
			draft,
			message: `已放进待确认草稿箱 #${draft.id}（未写入记忆）：\n${formatDraft(draft)}`,
		};
	});
}

export function formatDraft(d: Draft): string {
	const reason = d.request.reason?.trim();
	return [`#${d.id} [${KIND_LABEL[d.kind]}]${reason ? ` ${reason}` : ""}`, ...d.preview.map(l => `   ${l}`)].join("\n");
}

export function formatDraftList(drafts: readonly Draft[]): string {
	if (drafts.length === 0) return "待确认草稿箱是空的。";
	return [`待确认草稿 ${drafts.length} 条：`, ...drafts.map(formatDraft)].join("\n");
}

function selectDrafts(all: readonly Draft[], selector: string): { picked: Draft[]; missing: number[] } {
	const s = selector.trim().toLowerCase();
	if (!s || s === "all" || s === "全部") return { picked: [...all], missing: [] };
	const ids = [...new Set(s.split(/[\s,，、#]+/).filter(Boolean).map(Number).filter(Number.isInteger))];
	const byId = new Map(all.map(d => [d.id, d]));
	return {
		picked: ids.filter(id => byId.has(id)).map(id => byId.get(id)!),
		missing: ids.filter(id => !byId.has(id)),
	};
}

export function dropDrafts(paths: CluePaths, selector: string): { ok: boolean; message: string } {
	if (isWorkerRole()) return { ok: false, message: WORKER_REFUSAL };
	return withMemoryLock(paths.lockPath, () => {
		const all = readDrafts(paths);
		const { picked, missing } = selectDrafts(all, selector);
		if (picked.length === 0) return { ok: false, message: `没有匹配的草稿${missing.length ? `（不存在：#${missing.join(" #")}）` : ""}。` };
		const dropIds = new Set(picked.map(d => d.id));
		writeDrafts(paths, all.filter(d => !dropIds.has(d.id)));
		return { ok: true, message: `已丢弃草稿 #${[...dropIds].join(" #")}。` };
	});
}

/**
 * Apply the user-confirmed drafts in id order as a single commit. All-or-nothing: if any draft no longer
 * validates against current memory, every partial write is rolled back and no draft is consumed.
 */
export function applyDrafts(
	config: ClueConfig,
	paths: CluePaths,
	selector: string,
	invoker: { harness: string; session: string },
): ApplyResult {
	if (isWorkerRole()) return { ok: false, message: WORKER_REFUSAL };
	const tampering = detectUnauthorizedChanges(paths.home);
	if (tampering.dirty) {
		return {
			ok: false,
			message: `记忆文件有绕过 clue 的改动（${tampering.files.join(", ")}），先运行 \`clue restore\`（丢弃）或 \`clue accept "<原因>"\`（保留）再写入。`,
		};
	}
	const all = readDrafts(paths);
	const { picked, missing } = selectDrafts(all, selector);
	if (picked.length === 0) {
		return { ok: false, message: `没有可写入的草稿${missing.length ? `（不存在：#${missing.join(" #")}）` : ""}。` };
	}

	const receipt: string[] = [];
	for (const d of picked) {
		const res = runDraft(config, paths, d.kind, d.request, null, d.skipSlots, false);
		if (!res.ok) {
			restoreTruthFiles(paths.home, config.readOnlyGuard);
			return {
				ok: false,
				message: `草稿 #${d.id} 写入失败，本批全部回滚、未写入任何记忆：${res.message}\n（可改完重新起草，或 \`clue drop ${d.id}\` 丢弃它）`,
			};
		}
		receipt.push(`草稿 #${d.id} [${KIND_LABEL[d.kind]}]`, ...res.changes.map(c => `  ${c}`));
	}

	const harnesses = [...new Set([invoker.harness, ...picked.map(d => d.harness)].filter(Boolean))];
	const sessions = [...new Set([invoker.session, ...picked.map(d => d.session)].filter(Boolean))];
	const sha = commitMemoryGit(
		paths.home,
		`memory: 写入草稿 #${picked.map(d => d.id).join(" #")}`,
		receipt,
		{ "Clue-Harness": harnesses.join(", "), "Clue-Session": sessions.join(", ") },
	);

	const appliedIds = new Set(picked.map(d => d.id));
	withMemoryLock(paths.lockPath, () => {
		writeDrafts(paths, readDrafts(paths).filter(d => !appliedIds.has(d.id)));
	});

	return {
		ok: true,
		commit: sha,
		applied: [...appliedIds],
		message: [
			`【clue 记忆回执】${sha ? `commit ${sha}` : "（无文件变化）"} · 说「撤回记忆」或运行 \`clue undo\` 可整批撤回`,
			...receipt,
			...(missing.length ? [`（未找到的草稿编号：#${missing.join(" #")}）`] : []),
		].join("\n"),
	};
}
