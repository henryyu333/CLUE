import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function ensureMemoryGit(memDir: string): void {
	if (existsSync(join(memDir, ".git"))) return;
	execFileSync("git", ["-C", memDir, "init", "-b", "main"], { stdio: "ignore" });
	execFileSync("git", ["-C", memDir, "config", "user.name", "clue-memory"], { stdio: "ignore" });
	execFileSync("git", ["-C", memDir, "config", "user.email", "clue@local"], { stdio: "ignore" });
}

export function commitMemoryGit(memDir: string, message: string): string | null {
	try {
		ensureMemoryGit(memDir);
		execFileSync("git", ["-C", memDir, "add", "-A"], { stdio: "ignore" });
		const status = execFileSync("git", ["-C", memDir, "status", "--porcelain"], { encoding: "utf8" }).trim();
		if (!status) return null;
		execFileSync("git", ["-C", memDir, "commit", "-m", message], { stdio: "ignore" });
		return execFileSync("git", ["-C", memDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

export function getRecentMemoryCommits(memDir: string, limit = 5): string[] {
	try {
		if (!existsSync(join(memDir, ".git"))) return [];
		const out = execFileSync("git", ["-C", memDir, "log", "--oneline", `-${Math.max(1, limit)}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out ? out.split("\n") : [];
	} catch {
		return [];
	}
}

export function countCommitsSince(memDir: string, sinceIso: string | null): number {
	try {
		if (!existsSync(join(memDir, ".git"))) return 0;
		const args = ["-C", memDir, "rev-list", "--count", "HEAD"];
		if (sinceIso) args.splice(3, 0, `--since=${sinceIso}`);
		const out = execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const n = Number.parseInt(out, 10);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

export function undoLastMemoryCommit(memDir: string): { ok: boolean; message: string; commit?: string } {
	try {
		if (!existsSync(join(memDir, ".git"))) {
			return { ok: false, message: "记忆目录尚未初始化 Git，无可撤回记录。" };
		}
		const count = countCommitsSince(memDir, null);
		if (count <= 1) {
			return { ok: false, message: "当前仅剩初始提交，为防止清空记忆，不允许继续 undo。" };
		}
		const lastLine = getRecentMemoryCommits(memDir, 1)[0] ?? "";
		execFileSync("git", ["-C", memDir, "revert", "--no-edit", "HEAD"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const newSha = execFileSync("git", ["-C", memDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
		return {
			ok: true,
			commit: newSha,
			message: `已安全撤回上一条提交（${lastLine}），生成回滚提交 ${newSha}（历史完整保留）。`,
		};
	} catch (err: unknown) {
		try {
			execFileSync("git", ["-C", memDir, "revert", "--abort"], { stdio: "ignore" });
		} catch {
			// ignore
		}
		return {
			ok: false,
			message: `撤回失败：${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
