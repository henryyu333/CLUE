import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TRUTH_FILENAMES } from "./git.ts";
import { migrateLegacyStore } from "./migrate.ts";

export interface ClueLimits {
	profileChars: number;
	globalProjectChars: number;
	singleProjectChars: number;
	intentCardChars: number;
	entryChars: number;
	noteChars: number;
	dreamWarnPct: number;
	dreamMaxDays: number;
	dreamMaxWrites: number;
	coldDays: number;
}

export type IntentSlot = "goal" | "approach" | "nonGoals" | "checkpoint";

export interface ProjectWorkflowRule {
	name: string;
	/** Relative file path checked in cwd or primary git worktree root (e.g. "docs/STATUS.md"). */
	detectFile: string;
	/** Optional reminder added on start ritual; supports {dir} and {file} placeholders. */
	startHint?: string;
	/** Optional reminder added on wrap-up ritual; supports {dir} and {file} placeholders. */
	wrapUpHint?: string;
	/** Intent-card slots owned by this workflow's own files; clue refuses to write them for matching projects. */
	intentSkipSlots?: readonly IntentSlot[];
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
	pitfallsPath: string;
	decisionsPath: string;
	notesPath: string;
	draftsPath: string;
	statsPath: string;
	recallDbPath: string;
	recallLockPath: string;
	metaPath: string;
	lockPath: string;
	gitignorePath: string;
	legacyDbPath: string;
}

export const DEFAULT_LIMITS: ClueLimits = {
	profileChars: 1500,
	globalProjectChars: 900,
	singleProjectChars: 900,
	intentCardChars: 450,
	entryChars: 160,
	noteChars: 300,
	dreamWarnPct: 80,
	dreamMaxDays: 14,
	dreamMaxWrites: 10,
	coldDays: 60,
};

export const DEFAULT_PROFILE_SECTIONS = ["技术底座", "认知与审美偏好", "个人与协作习惯"] as const;
export const DEFAULT_GLOBAL_PROJECT_HEADING = "全局工程习惯";
export const DEFAULT_WORKTREE_SUFFIXES = ["fix", "wt", "worktree", "dev", "tmp"] as const;
export const DEFAULT_WORKSPACE_ROOTS = ["workspace", "projects", "code", "dev", "src"] as const;

const INTENT_SLOTS: readonly IntentSlot[] = ["goal", "approach", "nonGoals", "checkpoint"];

/** Files that are local caches or scratch state and must never be committed. */
const GITIGNORE_LINES = [
	"*.db-wal",
	"*.db-shm",
	"recall.db",
	"recall.db-*",
	"pitfalls.db",
	"stats.json",
	"drafts.jsonl",
	".clue.lock/",
	".recall.lock/",
];

export function resolveClueHome(explicitHome?: string): string {
	if (explicitHome?.trim()) return resolve(explicitHome.trim());
	const envHome = process.env.CLUE_HOME?.trim();
	if (envHome) return resolve(envHome);
	return join(homedir(), ".clue");
}

/** Read-only execution panes (e.g. delegated workers) set CLUE_ROLE=worker: they read memory but never draft or write. */
export function isWorkerRole(): boolean {
	return (process.env.CLUE_ROLE ?? "").trim().toLowerCase() === "worker";
}

export interface InvokerInfo {
	harness: string;
	session: string;
}

/** Best-effort detection of which harness/session is running clue, used for commit provenance. */
export function detectInvoker(): InvokerInfo {
	const env = process.env;
	const explicit = env.CLUE_HARNESS?.trim();
	let harness = "";
	if (explicit) harness = explicit;
	else if (env.OMPCODE) harness = "omp";
	else if (env.PI_SESSION_ID || env.PI_SESSION_FILE) harness = "pi";
	else if (env.CLAUDECODE) harness = "claude";
	else if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM) harness = "codex";
	else if (env.OPENCODE) harness = "opencode";
	else if (env.HERMES_SESSION_ID || env.HERMES_HOME) harness = "hermes";
	const session = (env.CLUE_SESSION ?? env.PI_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? env.CODEX_THREAD_ID ?? "").trim();
	return { harness: harness || "cli", session };
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
				projectWorkflows: Array<ProjectWorkflowRule & { intentSkipSlots?: string[] }>;
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
						intentSkipSlots: Array.isArray(w.intentSkipSlots)
							? INTENT_SLOTS.filter(s => w.intentSkipSlots!.includes(s))
							: undefined,
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
		pitfallsPath: join(home, "pitfalls.jsonl"),
		decisionsPath: join(home, "decisions.jsonl"),
		notesPath: join(home, "notes.jsonl"),
		draftsPath: join(home, "drafts.jsonl"),
		statsPath: join(home, "stats.json"),
		recallDbPath: join(home, "recall.db"),
		recallLockPath: join(home, ".recall.lock"),
		metaPath: join(home, "clue.meta.json"),
		lockPath: join(home, ".clue.lock"),
		gitignorePath: join(home, ".gitignore"),
		legacyDbPath: join(home, "pitfalls.db"),
	};
}

export function getReadOnlyGuardedFiles(paths: CluePaths): string[] {
	return TRUTH_FILENAMES.map(f => join(paths.home, f));
}

function ensureGitignore(path: string): void {
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const have = new Set(current.split(/\r?\n/).map(l => l.trim()));
	const missing = GITIGNORE_LINES.filter(l => !have.has(l));
	if (missing.length === 0) return;
	const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
	writeFileSync(path, `${prefix}${missing.join("\n")}\n`, "utf8");
}

export function ensureClueStorage(config: ClueConfig): CluePaths {
	const paths = getCluePaths(config.home);
	mkdirSync(config.home, { recursive: true });
	ensureGitignore(paths.gitignorePath);
	if (!existsSync(paths.profilePath)) {
		writeFileSync(paths.profilePath, `${config.profileSections.map(sec => `# ${sec}\n`).join("\n")}`, "utf8");
	}
	if (!existsSync(paths.projectsPath)) {
		writeFileSync(paths.projectsPath, `# ${config.globalProjectHeading}\n`, "utf8");
	}
	if (existsSync(paths.legacyDbPath)) {
		migrateLegacyStore(paths, config.readOnlyGuard);
	}
	return paths;
}
