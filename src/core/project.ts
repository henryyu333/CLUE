import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_WORKSPACE_ROOTS, type ClueConfig, type IntentSlot, type ProjectWorkflowRule } from "./config.ts";

/**
 * Resolve a stable lowercase project key from cwd.
 * Collapses git worktrees (e.g. Foo-fix, Foo-wt1) back to the primary repo name.
 */
export function resolveProjectKey(cwd: string, workspaceRoots: readonly string[] = DEFAULT_WORKSPACE_ROOTS): string | null {
	const home = resolve(homedir());
	const resolvedCwd = resolve(cwd);
	const rootNames = new Set(workspaceRoots.map(r => r.toLowerCase()));
	if (resolvedCwd === home) return null;
	for (const r of rootNames) {
		if (resolvedCwd === join(home, r)) return null;
	}

	try {
		const commonDir = execFileSync("git", ["-C", resolvedCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (commonDir) {
			const primaryRoot = basename(commonDir) === ".git" ? dirname(commonDir) : dirname(dirname(commonDir));
			const name = basename(primaryRoot).trim().toLowerCase();
			if (name && !rootNames.has(name)) return name;
		}
	} catch {
		// Fall back to directory name normalization outside git
	}

	const rawBase = basename(resolvedCwd).trim().toLowerCase();
	if (!rawBase || rootNames.has(rawBase)) return null;
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

export interface MatchedWorkflow {
	wf: ProjectWorkflowRule;
	hit: { file: string; dir: string };
}

export function matchProjectWorkflows(config: ClueConfig, cwd: string): MatchedWorkflow[] {
	const out: MatchedWorkflow[] = [];
	for (const wf of config.projectWorkflows) {
		const hit = detectProjectFile(cwd, wf.detectFile);
		if (hit) out.push({ wf, hit });
	}
	return out;
}

/** Intent-card slots owned by a matching project workflow (e.g. a handoff file keeps the current checkpoint). */
export function skippedIntentSlots(config: ClueConfig, cwd: string): IntentSlot[] {
	return [...new Set(matchProjectWorkflows(config, cwd).flatMap(m => m.wf.intentSkipSlots ?? []))];
}
