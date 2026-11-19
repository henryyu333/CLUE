import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve a stable lowercase project key from cwd.
 * Collapses git worktrees (e.g. Foo-fix, Foo-rvcore) back to the primary repo name.
 */
export function resolveProjectKey(cwd: string): string | null {
	const home = resolve(homedir());
	const workspaceRoot = join(home, "workspace");
	const resolvedCwd = resolve(cwd);
	if (resolvedCwd === home || resolvedCwd === workspaceRoot) return null;

	try {
		const commonDir = execFileSync("git", ["-C", resolvedCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (commonDir) {
			const primaryRoot = basename(commonDir) === ".git" ? dirname(commonDir) : dirname(dirname(commonDir));
			const name = basename(primaryRoot).trim().toLowerCase();
			if (name && name !== "workspace") return name;
		}
	} catch {
		// Fall back to directory name normalization outside git
	}

	const rawBase = basename(resolvedCwd).trim().toLowerCase();
	if (!rawBase) return null;
	const dashIdx = rawBase.indexOf("-");
	if (dashIdx > 0) {
		const prefix = rawBase.slice(0, dashIdx);
		const sibling = join(dirname(resolvedCwd), prefix);
		const siblingOrig = join(dirname(resolvedCwd), basename(resolvedCwd).slice(0, dashIdx));
		if (existsSync(sibling) || existsSync(siblingOrig)) {
			return prefix;
		}
	}
	return rawBase;
}

/**
 * Detect a relative marker file (e.g. "docs/STATUS.md") in cwd or its primary git worktree root.
 * Returns { file, dir } if found, otherwise null.
 */
export function detectProjectFile(cwd: string, relativeFile: string): { file: string; dir: string } | null {
	const rel = relativeFile.trim().replace(/^\/+/, "");
	if (!rel) return null;
	const resolvedCwd = resolve(cwd);
	const direct = join(resolvedCwd, rel);
	if (existsSync(direct)) {
		return { file: direct, dir: dirname(direct) };
	}
	try {
		const commonDir = execFileSync("git", ["-C", resolvedCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (commonDir && basename(commonDir) === ".git") {
			const primaryFile = join(dirname(commonDir), rel);
			if (existsSync(primaryFile)) {
				return { file: primaryFile, dir: dirname(primaryFile) };
			}
		}
	} catch {
		// ignore
	}
	return null;
}
