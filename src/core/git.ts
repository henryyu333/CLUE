import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lockFilesReadOnly, unlockFilesWritable } from "./lock.ts";

/** Git-tracked memory files: the single source of truth that undo/restore/integrity checks operate on. */
export const TRUTH_FILENAMES = [
	"PROFILE.md",
	"PROJECTS.md",
	"INTENTS.json",
	"pitfalls.jsonl",
	"decisions.jsonl",
	"notes.jsonl",
] as const;

const TRUTH_SET = new Set<string>(TRUTH_FILENAMES);

export interface UnauthorizedChangeReport {
	dirty: boolean;
	files: string[];
	diffSummary: string;
}

function git(memDir: string, args: string[]): string {
	// trimEnd only: porcelain status lines start with a significant space (" M file").
	return execFileSync("git", ["-C", memDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
}

export function ensureMemoryGit(memDir: string): void {
	if (existsSync(join(memDir, ".git"))) return;
	execFileSync("git", ["-C", memDir, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", memDir, "config", "user.name", "clue-memory"], { stdio: "ignore" });
	execFileSync("git", ["-C", memDir, "config", "user.email", "clue@local"], { stdio: "ignore" });
}

/**
 * Commit everything in the memory dir. `trailers` (e.g. Clue-Harness / Clue-Session) record which
 * tool and conversation produced the change, so drift can be traced back to its writer.
 */
export function commitMemoryGit(
	memDir: string,
	subject: string,
	body: readonly string[] = [],
	trailers: Record<string, string> = {},
): string | null {
	try {
		ensureMemoryGit(memDir);
		execFileSync("git", ["-C", memDir, "add", "-A"], { stdio: "ignore" });
		if (!git(memDir, ["status", "--porcelain"])) return null;
		const trailerLines = Object.entries(trailers)
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}: ${v}`);
		const message = [subject, ...(body.length > 0 ? ["", ...body] : []), ...(trailerLines.length > 0 ? ["", ...trailerLines] : [])].join(
			"\n",
		);
		execFileSync("git", ["-C", memDir, "commit", "-q", "-F", "-"], { input: message, stdio: ["pipe", "ignore", "ignore"] });
		return git(memDir, ["rev-parse", "--short", "HEAD"]);
	} catch {
		return null;
	}
}

function hasHead(memDir: string): boolean {
	try {
		git(memDir, ["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Fast sentinel: truth files edited (or deleted) outside clue show up as uncommitted git changes.
 */
export function detectUnauthorizedChanges(memDir: string): UnauthorizedChangeReport {
	try {
		if (!existsSync(join(memDir, ".git")) || !hasHead(memDir)) {
			return { dirty: false, files: [], diffSummary: "" };
		}
		const raw = git(memDir, ["status", "--porcelain", "--", ...TRUTH_FILENAMES]);
		if (!raw) return { dirty: false, files: [], diffSummary: "" };
		const dirtyFiles = raw
			.split("\n")
			.map(line => line.slice(3).trim().replace(/^"|"$/g, ""))
			.filter(f => TRUTH_SET.has(f));
		if (dirtyFiles.length === 0) return { dirty: false, files: [], diffSummary: "" };
		let diffSummary = "";
		try {
			diffSummary = git(memDir, ["diff", "--stat", "HEAD", "--", ...dirtyFiles]);
		} catch {
			// ignore
		}
		return { dirty: true, files: dirtyFiles, diffSummary };
	} catch {
		return { dirty: false, files: [], diffSummary: "" };
	}
}

/** Discard edits made to truth files outside clue, returning them to the last committed state. */
export function restoreTruthFiles(memDir: string, readOnly: boolean): { ok: boolean; message: string } {
	const report = detectUnauthorizedChanges(memDir);
	if (!report.dirty) return { ok: true, message: "记忆文件与最近一次提交一致，无需还原。" };
	const abs = report.files.map(f => join(memDir, f));
	unlockFilesWritable(abs);
	try {
		execFileSync("git", ["-C", memDir, "checkout", "HEAD", "--", ...report.files], { stdio: "ignore" });
	} catch (err) {
		return { ok: false, message: `还原失败：${err instanceof Error ? err.message : String(err)}` };
	} finally {
		if (readOnly) lockFilesReadOnly(abs);
	}
	return { ok: true, message: `已还原 ${report.files.join(", ")} 到最近一次提交。\n${report.diffSummary}` };
}

/** Commit edits the user deliberately made by hand, so the integrity warning clears. */
export function acceptManualEdits(memDir: string, reason: string, readOnly: boolean): { ok: boolean; message: string } {
	const report = detectUnauthorizedChanges(memDir);
	if (!report.dirty) return { ok: true, message: "没有待接受的手动改动。" };
	const sha = commitMemoryGit(memDir, `manual: ${reason.trim() || "accept hand edits"}`, [report.diffSummary], {
		"Clue-Harness": "manual",
	});
	if (readOnly) lockFilesReadOnly(report.files.map(f => join(memDir, f)));
	return sha
		? { ok: true, message: `已接受手动改动（commit ${sha}）：${report.files.join(", ")}` }
		: { ok: false, message: "提交失败，请检查 git 状态。" };
}

export function getRecentMemoryCommits(memDir: string, limit = 5): string[] {
	try {
		if (!existsSync(join(memDir, ".git"))) return [];
		const out = git(memDir, ["log", "--oneline", `-${Math.max(1, limit)}`]);
		return out ? out.split("\n") : [];
	} catch {
		return [];
	}
}

export function getHeadSha(memDir: string): string {
	try {
		return git(memDir, ["rev-parse", "HEAD"]);
	} catch {
		return "";
	}
}

/**
 * Full messages of memory commits made after `sinceSha` (oldest first). Harness extensions use this
 * to display a system-generated receipt at turn end, independent of what the model chose to say.
 */
export function describeCommitsSince(memDir: string, sinceSha: string): string {
	if (!sinceSha) return "";
	try {
		return git(memDir, ["log", "--reverse", "--format=commit %h%n%B", `${sinceSha}..HEAD`]);
	} catch {
		return "";
	}
}

export function countCommitsSince(memDir: string, sinceIso: string | null): number {
	try {
		if (!existsSync(join(memDir, ".git"))) return 0;
		const args = ["rev-list", "--count", "HEAD"];
		if (sinceIso) args.splice(1, 0, `--since=${sinceIso}`);
		const n = Number.parseInt(git(memDir, args), 10);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

export function undoLastMemoryCommit(
	memDir: string,
	options?: { guardedFiles?: readonly string[]; restoreReadOnly?: boolean },
): { ok: boolean; message: string; commit?: string } {
	const guarded = options?.guardedFiles ?? [];
	try {
		if (!existsSync(join(memDir, ".git"))) {
			return { ok: false, message: "记忆目录尚未初始化 Git，无可撤回记录。" };
		}
		if (countCommitsSince(memDir, null) <= 1) {
			return { ok: false, message: "当前仅剩初始提交，为防止清空记忆，不允许继续 undo。" };
		}
		if (guarded.length > 0) unlockFilesWritable(guarded);
		const lastLine = getRecentMemoryCommits(memDir, 1)[0] ?? "";
		execFileSync("git", ["-C", memDir, "revert", "--no-edit", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
		const newSha = git(memDir, ["rev-parse", "--short", "HEAD"]);
		return {
			ok: true,
			commit: newSha,
			message: `已撤回上一条记忆提交（${lastLine}），生成回滚提交 ${newSha}（历史完整保留）。`,
		};
	} catch (err: unknown) {
		try {
			execFileSync("git", ["-C", memDir, "revert", "--abort"], { stdio: "ignore" });
		} catch {
			// ignore
		}
		return { ok: false, message: `撤回失败：${err instanceof Error ? err.message : String(err)}` };
	} finally {
		if (options?.restoreReadOnly && guarded.length > 0) lockFilesReadOnly(guarded);
	}
}
