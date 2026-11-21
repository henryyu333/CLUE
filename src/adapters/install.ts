import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveClueHome } from "../core/config.ts";

export const ADAPTER_TARGETS = ["agy", "claude", "codex", "hermes", "omp", "pi", "opencode"] as const;
export type InstallTarget = (typeof ADAPTER_TARGETS)[number];

export interface HarnessAdapterStatus {
	harness: InstallTarget;
	detected: boolean;
	hookWired: boolean;
	skillWired: boolean;
	nativeMemoryDisabled: boolean | null;
	detail: string;
}

export interface InstallOptions {
	target: InstallTarget;
	clueBin?: string;
	homeDir?: string;
	clueHome?: string;
	dryRun?: boolean;
}

export interface InstallResult {
	ok: boolean;
	target: InstallTarget;
	changes: string[];
	notes: string[];
}

const SRC_DIR = resolve(dirname(import.meta.path), "..");
const TEMPLATE_DIR = join(dirname(import.meta.path), "templates");
const EXTENSION_FILE = "clue-memory";

function backupFile(filePath: string, dryRun: boolean): string | null {
	if (!existsSync(filePath)) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const bak = `${filePath}.clue-bak-${stamp}`;
	if (!dryRun) copyFileSync(filePath, bak);
	return bak;
}

function installSkillFile(destPath: string, dryRun: boolean): string {
	const src = join(dirname(import.meta.path), "SKILL.md");
	// A skill dir or file the user links to a shared location (or back to this repo) is user-managed: never write through it.
	const linked = [dirname(destPath), destPath].find(p => existsSync(p) && lstatSync(p).isSymbolicLink());
	if (linked) return `skip skill (symlinked, managed by you): ${linked}`;
	if (!dryRun) {
		mkdirSync(dirname(destPath), { recursive: true });
		copyFileSync(src, destPath);
	}
	return `install skill -> ${destPath}`;
}

function renderTemplate(name: string, vars: Record<string, string>): string {
	let text = readFileSync(join(TEMPLATE_DIR, name), "utf8");
	for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`__${k}__`, v);
	return text;
}

/** Other files in an extension dir that also wire clue (e.g. hand-written predecessors) would double-inject. */
function otherClueExtensions(dir: string, ownFile: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (!ent.isFile() || ent.name === ownFile || !/\.(?:ts|js|mjs)$/.test(ent.name)) continue;
		const text = readFileSync(join(dir, ent.name), "utf8");
		if (text.includes("buildBootSnapshot") || text.includes("<clue-memory") || /clue\b.*\bhook prompt/.test(text)) {
			out.push(join(dir, ent.name));
		}
	}
	return out;
}

/** Hook config shape shared by Claude Code and Codex: `{ hooks: { <Event>: [{ matcher?, hooks: [{ command }] }] } }`. */
interface HookGroup {
	hooks?: Array<{ command?: unknown; [key: string]: unknown }>;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hookGroups(value: unknown): HookGroup[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function groupCommands(g: HookGroup): string[] {
	return Array.isArray(g.hooks) ? g.hooks.map(h => String(h?.command ?? "")) : [];
}

/** Drop hook entries that call the removed `clue hook guard` subcommand; returns how many were removed. */
function stripGuardHooks(hooks: Record<string, unknown>): number {
	let removed = 0;
	for (const [event, value] of Object.entries(hooks)) {
		if (!Array.isArray(value)) continue;
		const groups = hookGroups(value)
			.map(g => {
				if (!Array.isArray(g.hooks)) return g;
				const kept = g.hooks.filter(h => !String(h?.command ?? "").includes("clue hook guard"));
				removed += g.hooks.length - kept.length;
				return { ...g, hooks: kept };
			})
			.filter(g => !Array.isArray(g.hooks) || g.hooks.length > 0);
		if (groups.length === 0) delete hooks[event];
		else hooks[event] = groups;
	}
	return removed;
}

function mergeJsonHooks(
	path: string,
	wanted: Array<{ event: string; command: string }>,
	dryRun: boolean,
	extra?: (cfg: Record<string, unknown>) => void,
): string[] {
	const changes: string[] = [];
	const bak = backupFile(path, dryRun);
	if (bak) changes.push(`backup ${bak}`);
	const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	const cfg = isRecord(parsed) ? parsed : {};
	const hooks = isRecord(cfg.hooks) ? cfg.hooks : {};
	cfg.hooks = hooks;
	const removed = stripGuardHooks(hooks);
	if (removed > 0) changes.push(`remove ${removed} obsolete \`clue hook guard\` entr${removed === 1 ? "y" : "ies"}`);
	for (const { event, command } of wanted) {
		const groups = hookGroups(hooks[event]);
		if (!groups.some(g => groupCommands(g).some(c => c.includes("clue hook")))) {
			groups.push({ hooks: [{ type: "command", command, timeout: 5 }] } as HookGroup);
		}
		hooks[event] = groups;
	}
	extra?.(cfg);
	if (!dryRun) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	}
	changes.push(`update ${path}`);
	return changes;
}

export function installHarnessAdapter(opts: InstallOptions): InstallResult {
	const home = opts.homeDir ?? homedir();
	const clueBin = opts.clueBin ?? "~/.local/bin/clue";
	const absClueBin = clueBin.startsWith("~/") ? join(home, clueBin.slice(2)) : clueBin;
	const clueHome = opts.clueHome ?? resolveClueHome();
	const dryRun = opts.dryRun === true;
	const changes: string[] = [];
	const notes: string[] = [];
	const target = opts.target;

	if (target === "agy") {
		const pluginDir = join(home, ".gemini", "config", "plugins", "clue");
		const hooksContent = {
			"clue-memory": {
				SessionStart: [{ type: "command", command: `${clueBin} hook session-start --harness agy`, timeout: 5 }],
				PreInvocation: [{ type: "command", command: `${clueBin} hook prompt --harness agy`, timeout: 5 }],
			},
		};
		if (!dryRun) {
			mkdirSync(pluginDir, { recursive: true });
			writeFileSync(join(pluginDir, "plugin.json"), `${JSON.stringify({ name: "clue" }, null, 2)}\n`, "utf8");
			writeFileSync(join(pluginDir, "hooks.json"), `${JSON.stringify(hooksContent, null, 2)}\n`, "utf8");
		}
		changes.push(`write ${pluginDir}/plugin.json + hooks.json`, installSkillFile(join(pluginDir, "skills", "clue", "SKILL.md"), dryRun));
		notes.push("Verify with `agy plugin list`.");
	} else if (target === "claude") {
		changes.push(
			...mergeJsonHooks(
				join(home, ".claude", "settings.json"),
				[
					{ event: "SessionStart", command: `${clueBin} hook session-start --harness claude` },
					{ event: "UserPromptSubmit", command: `${clueBin} hook prompt --harness claude` },
				],
				dryRun,
				cfg => {
					if (cfg.autoMemoryEnabled === undefined) cfg.autoMemoryEnabled = false;
				},
			),
			installSkillFile(join(home, ".claude", "skills", "clue", "SKILL.md"), dryRun),
		);
	} else if (target === "codex") {
		changes.push(
			...mergeJsonHooks(
				join(home, ".codex", "hooks.json"),
				[{ event: "UserPromptSubmit", command: `${clueBin} hook prompt --harness codex --with-boot` }],
				dryRun,
			),
			installSkillFile(join(home, ".codex", "skills", "clue", "SKILL.md"), dryRun),
		);
	} else if (target === "hermes") {
		changes.push(installSkillFile(join(home, ".hermes", "skills", "clue", "SKILL.md"), dryRun));
		notes.push(
			"Add to ~/.hermes/config.yaml (and remove any old `clue hook guard` pre_tool_call entry):",
			`memory:\n  memory_enabled: false\n  user_profile_enabled: false\nhooks:\n  pre_llm_call:\n    - command: ${absClueBin} hook prompt --harness hermes --with-boot\n      timeout: 5`,
		);
	} else {
		const vars = {
			CLUE_CORE: join(SRC_DIR, "core", "index.ts"),
			CLUE_BIN: absClueBin,
			CLUE_HOME: clueHome,
			HARNESS: target,
		};
		const spec =
			target === "opencode"
				? { dir: join(home, ".config", "opencode", "plugins"), file: `${EXTENSION_FILE}.js`, template: "opencode-plugin.js.tmpl" }
				: { dir: join(home, target === "omp" ? ".omp" : ".pi", "agent", "extensions"), file: `${EXTENSION_FILE}.ts`, template: "pi-extension.ts.tmpl" };
		const dest = join(spec.dir, spec.file);
		const bak = backupFile(dest, dryRun);
		if (bak) changes.push(`backup ${bak}`);
		if (!dryRun) {
			mkdirSync(spec.dir, { recursive: true });
			writeFileSync(dest, renderTemplate(spec.template, vars), "utf8");
		}
		changes.push(`write ${dest}`);
		const dupes = otherClueExtensions(spec.dir, spec.file);
		if (dupes.length > 0) {
			notes.push(`⚠️ These files also wire clue and will double-inject memory; remove them: ${dupes.join(", ")}`);
		}
	}
	return { ok: true, target, changes, notes };
}

function fileContains(path: string, needle: string): boolean {
	try {
		return existsSync(path) && readFileSync(path, "utf8").includes(needle);
	} catch {
		return false;
	}
}

/** Inspect every supported harness on this machine: detected, hook wired, skill present, native memory state. */
export function inspectHarnessAdapters(homeDir = homedir()): HarnessAdapterStatus[] {
	const status = (
		harness: InstallTarget,
		detected: boolean,
		hookWired: boolean,
		skillWired: boolean,
		nativeMemoryDisabled: boolean | null,
		staleGuard: boolean,
	): HarnessAdapterStatus => ({
		harness,
		detected,
		hookWired,
		skillWired,
		nativeMemoryDisabled,
		detail: !detected
			? "not installed"
			: !hookWired
				? `not wired (run \`clue install ${harness}\`)`
				: [
						"wired",
						skillWired ? "skill OK" : "",
						nativeMemoryDisabled === false ? "warning: native memory is ON" : "",
						staleGuard ? `obsolete guard hook present (re-run \`clue install ${harness}\`)` : "",
					]
						.filter(Boolean)
						.join(" · "),
	});

	const agyHooks = join(homeDir, ".gemini", "config", "plugins", "clue", "hooks.json");
	const claudeSettings = join(homeDir, ".claude", "settings.json");
	let claudeNativeOff: boolean | null = null;
	try {
		const cfg = JSON.parse(readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
		if (typeof cfg.autoMemoryEnabled === "boolean") claudeNativeOff = cfg.autoMemoryEnabled === false;
	} catch {
		// missing or unreadable settings
	}
	const codexHooks = join(homeDir, ".codex", "hooks.json");
	const hermesCfg = join(homeDir, ".hermes", "config.yaml");
	let hermesNativeOff: boolean | null = null;
	if (existsSync(hermesCfg)) {
		const raw = readFileSync(hermesCfg, "utf8");
		if (/memory_enabled:\s*false/.test(raw)) hermesNativeOff = true;
		else if (/memory_enabled:\s*true/.test(raw)) hermesNativeOff = false;
	}
	const ompExt = join(homeDir, ".omp", "agent", "extensions", `${EXTENSION_FILE}.ts`);
	const piExt = join(homeDir, ".pi", "agent", "extensions", `${EXTENSION_FILE}.ts`);
	const ocPlugin = join(homeDir, ".config", "opencode", "plugins", `${EXTENSION_FILE}.js`);

	return [
		status(
			"agy",
			existsSync(join(homeDir, ".gemini")),
			fileContains(agyHooks, "clue hook"),
			existsSync(join(homeDir, ".gemini", "config", "plugins", "clue", "skills", "clue", "SKILL.md")),
			null,
			fileContains(agyHooks, "hook guard"),
		),
		status(
			"claude",
			existsSync(join(homeDir, ".claude")),
			fileContains(claudeSettings, "clue hook"),
			existsSync(join(homeDir, ".claude", "skills", "clue", "SKILL.md")),
			claudeNativeOff,
			fileContains(claudeSettings, "hook guard"),
		),
		status(
			"codex",
			existsSync(join(homeDir, ".codex")),
			fileContains(codexHooks, "clue hook"),
			existsSync(join(homeDir, ".codex", "skills", "clue", "SKILL.md")),
			null,
			fileContains(codexHooks, "hook guard"),
		),
		status(
			"hermes",
			existsSync(join(homeDir, ".hermes")),
			fileContains(hermesCfg, "clue hook"),
			existsSync(join(homeDir, ".hermes", "skills", "clue", "SKILL.md")),
			hermesNativeOff,
			fileContains(hermesCfg, "hook guard"),
		),
		status("omp", existsSync(join(homeDir, ".omp")), existsSync(ompExt), existsSync(ompExt), null, false),
		status("pi", existsSync(join(homeDir, ".pi")), existsSync(piExt), existsSync(piExt), null, false),
		status(
			"opencode",
			existsSync(join(homeDir, ".config", "opencode")) || existsSync(join(homeDir, ".local", "share", "opencode")),
			existsSync(ocPlugin),
			existsSync(ocPlugin),
			null,
			false,
		),
	];
}
