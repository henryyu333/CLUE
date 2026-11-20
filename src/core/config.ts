import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ClueLimits {
	profileChars: number;
	globalProjectChars: number;
	singleProjectChars: number;
	intentCardChars: number;
	entryChars: number;
	dreamWarnPct: number;
	dreamMaxDays: number;
	dreamMaxWrites: number;
}

export interface ProjectWorkflowRule {
	name: string;
	/** Relative file path checked in cwd or primary git worktree root (e.g. "docs/STATUS.md"). */
	detectFile: string;
	/** Optional reminder added on start ritual; supports {dir} and {file} placeholders. */
	startHint?: string;
	/** Optional reminder added on wrap-up ritual; supports {dir} and {file} placeholders. */
	wrapUpHint?: string;
}

export interface ClueConfig {
	home: string;
	limits: ClueLimits;
	profileSections: readonly string[];
	globalProjectHeading: string;
	projectWorkflows: readonly ProjectWorkflowRule[];
	readOnlyGuard: boolean;
	autoRecall: boolean;
	worktreeSuffixes: readonly string[];
	workspaceRoots: readonly string[];
}

export interface CluePaths {
	home: string;
	profilePath: string;
	projectsPath: string;
	intentsPath: string;
	dbPath: string;
	jsonlPath: string;
	decisionsJsonlPath: string;
	recallDbPath: string;
	recallLockPath: string;
	metaPath: string;
	lockPath: string;
	gitignorePath: string;
}

export const DEFAULT_LIMITS: ClueLimits = {
	profileChars: 1500,
	globalProjectChars: 900,
	singleProjectChars: 900,
	intentCardChars: 450,
	entryChars: 160,
	dreamWarnPct: 80,
	dreamMaxDays: 14,
	dreamMaxWrites: 10,
};

export const DEFAULT_PROFILE_SECTIONS = ["技术底座", "认知与审美偏好", "个人与协作习惯"] as const;
export const DEFAULT_GLOBAL_PROJECT_HEADING = "全局工程习惯";
export const DEFAULT_WORKTREE_SUFFIXES = ["fix", "wt", "worktree", "dev", "tmp"] as const;
export const DEFAULT_WORKSPACE_ROOTS = ["workspace", "projects", "code", "dev", "src"] as const;

export function resolveClueHome(explicitHome?: string): string {
	if (explicitHome?.trim()) return resolve(explicitHome.trim());
	const envHome = process.env.CLUE_HOME?.trim();
	if (envHome) return resolve(envHome);
	return join(homedir(), ".clue");
}

export function loadClueConfig(explicitHome?: string): ClueConfig {
	const home = resolveClueHome(explicitHome);
	const configFile = join(home, "clue.config.json");
	let limits: ClueLimits = { ...DEFAULT_LIMITS };
	let profileSections: readonly string[] = DEFAULT_PROFILE_SECTIONS;
	let globalProjectHeading = DEFAULT_GLOBAL_PROJECT_HEADING;
	let projectWorkflows: readonly ProjectWorkflowRule[] = [];
	let readOnlyGuard = true;
	let autoRecall = true;
	let worktreeSuffixes: readonly string[] = DEFAULT_WORKTREE_SUFFIXES;
	let workspaceRoots: readonly string[] = DEFAULT_WORKSPACE_ROOTS;

	if (existsSync(configFile)) {
		try {
			const raw = JSON.parse(readFileSync(configFile, "utf8")) as Partial<{
				limits: Partial<ClueLimits>;
				profileSections: string[];
				globalProjectHeading: string;
				projectWorkflows: ProjectWorkflowRule[];
				readOnlyGuard: boolean;
				autoRecall: boolean;
				worktreeSuffixes: string[];
				workspaceRoots: string[];
			}>;
			if (raw.limits) {
				limits = { ...limits, ...raw.limits };
			}
			if (Array.isArray(raw.profileSections) && raw.profileSections.length > 0) {
				profileSections = raw.profileSections.map(s => String(s).trim()).filter(Boolean);
			}
			if (typeof raw.globalProjectHeading === "string" && raw.globalProjectHeading.trim()) {
				globalProjectHeading = raw.globalProjectHeading.trim();
			}
			if (Array.isArray(raw.projectWorkflows)) {
				projectWorkflows = raw.projectWorkflows
					.filter(w => w && typeof w.detectFile === "string" && w.detectFile.trim())
					.map(w => ({
						name: String(w.name || "workflow").trim(),
						detectFile: w.detectFile.trim(),
						startHint: typeof w.startHint === "string" ? w.startHint.trim() : undefined,
						wrapUpHint: typeof w.wrapUpHint === "string" ? w.wrapUpHint.trim() : undefined,
					}));
			}
			if (typeof raw.readOnlyGuard === "boolean") {
				readOnlyGuard = raw.readOnlyGuard;
			}
			if (typeof raw.autoRecall === "boolean") {
				autoRecall = raw.autoRecall;
			}
			if (Array.isArray(raw.worktreeSuffixes) && raw.worktreeSuffixes.length > 0) {
				worktreeSuffixes = raw.worktreeSuffixes.map(s => String(s).trim().toLowerCase()).filter(Boolean);
			}
			if (Array.isArray(raw.workspaceRoots) && raw.workspaceRoots.length > 0) {
				workspaceRoots = raw.workspaceRoots.map(s => String(s).trim().toLowerCase()).filter(Boolean);
			}
		} catch {
			// Fall back cleanly to defaults if user config JSON is malformed
		}
	}

	return {
		home,
		limits,
		profileSections,
		globalProjectHeading,
		projectWorkflows,
		readOnlyGuard,
		autoRecall,
		worktreeSuffixes,
		workspaceRoots,
	};
}

export function getCluePaths(home: string): CluePaths {
	return {
		home,
		profilePath: join(home, "PROFILE.md"),
		projectsPath: join(home, "PROJECTS.md"),
		intentsPath: join(home, "INTENTS.json"),
		dbPath: join(home, "pitfalls.db"),
		jsonlPath: join(home, "pitfalls.jsonl"),
		decisionsJsonlPath: join(home, "decisions.jsonl"),
		recallDbPath: join(home, "recall.db"),
		recallLockPath: join(home, ".recall.lock"),
		metaPath: join(home, "clue.meta.json"),
		lockPath: join(home, ".clue.lock"),
		gitignorePath: join(home, ".gitignore"),
	};
}

export function getReadOnlyGuardedFiles(paths: CluePaths): string[] {
	return [paths.profilePath, paths.projectsPath, paths.intentsPath, paths.jsonlPath, paths.decisionsJsonlPath];
}

export function ensureClueStorage(config: ClueConfig): CluePaths {
	const paths = getCluePaths(config.home);
	mkdirSync(config.home, { recursive: true });

	if (!existsSync(paths.gitignorePath)) {
		writeFileSync(
			paths.gitignorePath,
			["*.db-wal", "*.db-shm", "recall.db", "recall.db-*", ".clue.lock/", ".recall.lock/", ""].join("\n"),
			"utf8",
		);
	}
	if (!existsSync(paths.profilePath)) {
		writeFileSync(
			paths.profilePath,
			`${config.profileSections.map(sec => `# ${sec}\n`).join("\n")}`,
			"utf8",
		);
	}
	if (!existsSync(paths.projectsPath)) {
		writeFileSync(paths.projectsPath, `# ${config.globalProjectHeading}\n`, "utf8");
	}
	return paths;
}
