import { existsSync, readFileSync } from "node:fs";
import type { ClueConfig, CluePaths } from "./config.ts";
import { commitMemoryGit } from "./git.ts";
import { atomicWriteFileSync, withMemoryLock } from "./lock.ts";
import { charCount } from "./markdown.ts";
import { scanMemoryContent } from "./security.ts";

export interface ProjectIntentCard {
	project: string;
	goal: string;
	approach: string;
	nonGoals: string;
	checkpoint: string;
	evidence: string;
	updatedAt: string;
}

export type IntentStore = Record<string, ProjectIntentCard>;

export interface IntentMutationRequest {
	op?: "set" | "clear" | "view";
	project?: string;
	goal?: string;
	approach?: string;
	nonGoals?: string;
	checkpoint?: string;
	evidence?: string;
	reason?: string;
	dryRun?: boolean;
}

export interface IntentMutationResult {
	ok: boolean;
	message: string;
	card?: ProjectIntentCard | null;
	commit?: string | null;
	changes?: string[];
}

const SLOT_LABELS: Record<"goal" | "approach" | "nonGoals" | "checkpoint", string> = {
	goal: "目标方向",
	approach: "已定思路",
	nonGoals: "明确不做",
	checkpoint: "当前停点",
};

export function readIntentStore(intentsPath: string): IntentStore {
	if (!existsSync(intentsPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(intentsPath, "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as IntentStore;
	} catch {
		return {};
	}
}

export function getProjectIntent(intentsPath: string, projectKey: string | null): ProjectIntentCard | null {
	if (!projectKey) return null;
	const store = readIntentStore(intentsPath);
	return store[projectKey.toLowerCase()] ?? null;
}

export function formatIntentCard(card: ProjectIntentCard): string {
	const lines: string[] = [];
	if (card.goal) lines.push(`- ${SLOT_LABELS.goal}：${card.goal}`);
	if (card.approach) lines.push(`- ${SLOT_LABELS.approach}：${card.approach}`);
	if (card.nonGoals) lines.push(`- ${SLOT_LABELS.nonGoals}：${card.nonGoals}`);
	if (card.checkpoint) lines.push(`- ${SLOT_LABELS.checkpoint}：${card.checkpoint}`);
	if (card.evidence) lines.push(`- 溯源：${card.evidence}`);
	return lines.join("\n");
}

function cardCharCount(card: ProjectIntentCard): number {
	return charCount([card.goal, card.approach, card.nonGoals, card.checkpoint].filter(Boolean).join(""));
}

function cleanSlot(value: string): { ok: true; text: string } | { ok: false; err: string } {
	const text = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	const sec = scanMemoryContent(text);
	if (!sec.ok) return { ok: false, err: `安全安检拦截（${sec.rule}）：${sec.reason}` };
	return { ok: true, text };
}

/**
 * Slot-based partial update for a project's 4-slot intent card.
 * Untouched slots are preserved verbatim so weaker models cannot accidentally erase prior context.
 */
export function mutateProjectIntent(
	config: ClueConfig,
	paths: CluePaths,
	req: IntentMutationRequest,
	defaultProject: string | null,
): IntentMutationResult {
	const proj = (req.project?.trim().toLowerCase() || defaultProject?.trim().toLowerCase() || "").replace(/^project:\s*/, "");
	const op = req.op ?? "set";

	if (op === "view") {
		const store = readIntentStore(paths.intentsPath);
		if (proj) {
			const card = store[proj] ?? null;
			return {
				ok: true,
				card,
				message: card
					? `=== [${proj}] 项目意图卡 (${cardCharCount(card)}/${config.limits.intentCardChars} 字, 更新于 ${card.updatedAt.slice(0, 16)}) ===\n${formatIntentCard(card)}`
					: `项目 [${proj}] 尚未建立 4 格意图卡。`,
			};
		}
		const keys = Object.keys(store).sort();
		if (keys.length === 0) return { ok: true, card: null, message: "尚未建立任何项目意图卡。" };
		const blocks = keys.map(k => {
			const c = store[k]!;
			return `=== [${k}] (${cardCharCount(c)}/${config.limits.intentCardChars} 字, ${c.updatedAt.slice(0, 10)}) ===\n${formatIntentCard(c)}`;
		});
		return { ok: true, card: null, message: blocks.join("\n\n") };
	}

	if (!proj) {
		return { ok: false, message: "更新项目意图卡必须指定 project（或在项目仓库目录内执行）。" };
	}

	return withMemoryLock(paths.lockPath, () => {
		const store = readIntentStore(paths.intentsPath);
		const prev = store[proj] ?? null;

		if (op === "clear") {
			if (!prev) {
				return { ok: true, card: null, message: `项目 [${proj}] 本就没有意图卡，无需清空。` };
			}
			delete store[proj];
			if (req.dryRun) {
				return { ok: true, card: null, message: `[DRY-RUN] 将清空项目 [${proj}] 意图卡。` };
			}
			atomicWriteFileSync(paths.intentsPath, `${JSON.stringify(store, null, 2)}\n`, { readOnly: config.readOnlyGuard });
			const sha = commitMemoryGit(paths.home, `intent: clear ${proj}`);
			return {
				ok: true,
				card: null,
				commit: sha,
				message: `已清空项目 [${proj}] 意图卡${sha ? ` (commit ${sha})` : ""}。`,
			};
		}

		const next: ProjectIntentCard = {
			project: proj,
			goal: prev?.goal ?? "",
			approach: prev?.approach ?? "",
			nonGoals: prev?.nonGoals ?? "",
			checkpoint: prev?.checkpoint ?? "",
			evidence: prev?.evidence ?? "",
			updatedAt: new Date().toISOString(),
		};

		const changes: string[] = [];
		const slotKeys: Array<"goal" | "approach" | "nonGoals" | "checkpoint"> = ["goal", "approach", "nonGoals", "checkpoint"];
		for (const key of slotKeys) {
			if (req[key] === undefined) continue;
			const cleaned = cleanSlot(req[key]!);
			if (!cleaned.ok) return { ok: false, message: `${SLOT_LABELS[key]}校验失败：${cleaned.err}` };
			if (cleaned.text !== next[key]) {
				const oldVal = next[key];
				next[key] = cleaned.text;
				changes.push(
					oldVal
						? `${SLOT_LABELS[key]}：「${oldVal}」→「${cleaned.text || "(已清空)"}」`
						: `${SLOT_LABELS[key]}：设为「${cleaned.text}」`,
				);
			}
		}

		if (req.evidence !== undefined) {
			const cleanedEv = cleanSlot(req.evidence);
			if (!cleanedEv.ok) return { ok: false, message: `溯源校验失败：${cleanedEv.err}` };
			next.evidence = cleanedEv.text;
		}

		if (!next.goal && !next.approach && !next.nonGoals && !next.checkpoint) {
			return { ok: false, message: "意图卡至少需要填写一个槽位（goal / approach / nonGoals / checkpoint）。" };
		}

		const totalChars = cardCharCount(next);
		if (totalChars > config.limits.intentCardChars) {
			return {
				ok: false,
				message: `项目 [${proj}] 意图卡超出硬上限（当前 ${totalChars}/${config.limits.intentCardChars} 字，超出 ${totalChars - config.limits.intentCardChars} 字），请精简各槽位表述后重试。`,
			};
		}

		if (changes.length === 0 && prev) {
			return {
				ok: true,
				card: prev,
				changes: [],
				message: `项目 [${proj}] 意图卡无实质变动。`,
			};
		}

		if (req.dryRun) {
			return {
				ok: true,
				card: next,
				changes,
				message: `[DRY-RUN] 项目 [${proj}] 意图卡预检通过 (${totalChars}/${config.limits.intentCardChars} 字)\n${changes.map(c => `- ${c}`).join("\n")}`,
			};
		}

		store[proj] = next;
		atomicWriteFileSync(paths.intentsPath, `${JSON.stringify(store, null, 2)}\n`, { readOnly: config.readOnlyGuard });
		const sha = commitMemoryGit(paths.home, `intent(${proj}): ${req.reason?.trim() || "update intent card"}`);
		return {
			ok: true,
			card: next,
			commit: sha,
			changes,
			message:
				`已刷新 [${proj}] 项目意图卡 (${totalChars}/${config.limits.intentCardChars} 字)${sha ? ` (commit ${sha})` : ""}\n` +
				changes.map(c => `- ${c}`).join("\n"),
		};
	});
}
