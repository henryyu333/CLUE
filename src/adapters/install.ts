import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type InstallTarget = "agy" | "claude" | "codex" | "hermes";

export interface HarnessAdapterStatus {
	harness: "agy" | "claude" | "codex" | "omp" | "pi" | "opencode" | "hermes";
	detected: boolean;
	hookWired: boolean;
	guardWired: boolean;
	skillWired: boolean;
	nativeMemoryDisabled: boolean | null;
	detail: string;
}

export interface InstallOptions {
	target: InstallTarget;
	clueBin?: string;
	homeDir?: string;
	dryRun?: boolean;
}

export interface InstallResult {
	ok: boolean;
	target: InstallTarget;
	changes: string[];
	notes: string[];
}

function getBundledSkillPath(): string {
	return resolve(dirname(import.meta.path), "SKILL.md");
}

function backupFile(filePath: string, dryRun: boolean): string | null {
	if (!existsSync(filePath)) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const bak = `${filePath}.clue-bak-${stamp}`;
	if (!dryRun) copyFileSync(filePath, bak);
	return bak;
}

function installSkillFile(destPath: string, dryRun: boolean): string {
	const src = getBundledSkillPath();
	if (!dryRun) {
		mkdirSync(dirname(destPath), { recursive: true });
		copyFileSync(src, destPath);
	}
	return `install skill -> ${destPath}`;
}

export function installHarnessAdapter(opts: InstallOptions): InstallResult {
	const home = opts.homeDir ?? homedir();
	const clueBin = opts.clueBin ?? "~/.local/bin/clue";
	const absClueBin = clueBin.startsWith("~/") ? join(home, clueBin.slice(2)) : clueBin;
	const dryRun = opts.dryRun === true;
	const changes: string[] = [];
	const notes: string[] = [];

	if (opts.target === "agy") {
		const pluginDir = join(home, ".gemini", "config", "plugins", "clue");
		const pluginJson = join(pluginDir, "plugin.json");
		const hooksJson = join(pluginDir, "hooks.json");
		const skillPath = join(pluginDir, "skills", "clue", "SKILL.md");

		const hooksContent = {
			"clue-memory": {
				SessionStart: [{ type: "command", command: `${clueBin} hook session-start --harness agy`, timeout: 5 }],
				PreInvocation: [{ type: "command", command: `${clueBin} hook prompt --harness agy`, timeout: 5 }],
				PreToolUse: [
					{
						matcher: "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|run_command",
						hooks: [{ type: "command", command: `${clueBin} hook guard --harness agy`, timeout: 5 }],
					},
				],
			},
		};

		if (!dryRun) {
			mkdirSync(pluginDir, { recursive: true });
			writeFileSync(pluginJson, `${JSON.stringify({ name: "clue" }, null, 2)}\n`, "utf8");
			writeFileSync(hooksJson, `${JSON.stringify(hooksContent, null, 2)}\n`, "utf8");
		}
		changes.push(`write ${pluginJson}`, `write ${hooksJson}`, installSkillFile(skillPath, dryRun));
		notes.push("Verify with `agy plugin list` (should show `clue (enabled) — 1 skill, 1 hook`).");
		return { ok: true, target: "agy", changes, notes };
	}

	if (opts.target === "claude") {
		const settingsPath = join(home, ".claude", "settings.json");
		const skillPath = join(home, ".claude", "skills", "clue", "SKILL.md");
		const bak = backupFile(settingsPath, dryRun);
		if (bak) changes.push(`backup ${bak}`);

		const cfg: Record<string, any> = existsSync(settingsPath)
			? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>)
			: {};
		cfg.hooks = cfg.hooks ?? {};

		const ensureGroup = (event: string, command: string, matcher?: string) => {
			cfg.hooks[event] = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
			const exists = cfg.hooks[event].some(
				(g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => String(h?.command ?? "").includes("clue hook")),
			);
			if (!exists) {
				const entry = { type: "command", command, timeout: 5 };
				cfg.hooks[event].push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] });
			}
		};

		ensureGroup("SessionStart", `${clueBin} hook session-start --harness claude`);
		ensureGroup("UserPromptSubmit", `${clueBin} hook prompt --harness claude`);
		ensureGroup("PreToolUse", `${clueBin} hook guard --harness claude`, "Write|Edit|MultiEdit|Bash");
		if (cfg.autoMemoryEnabled === undefined) {
			cfg.autoMemoryEnabled = false;
		}

		if (!dryRun) {
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
		}
		changes.push(`update ${settingsPath}`, installSkillFile(skillPath, dryRun));
		return { ok: true, target: "claude", changes, notes };
	}

	if (opts.target === "codex") {
		const hooksPath = join(home, ".codex", "hooks.json");
		const skillPath = join(home, ".codex", "skills", "clue", "SKILL.md");
		const bak = backupFile(hooksPath, dryRun);
		if (bak) changes.push(`backup ${bak}`);

		const cfg: Record<string, any> = existsSync(hooksPath)
			? (JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, any>)
			: {};
		cfg.hooks = cfg.hooks ?? {};
		cfg.hooks.UserPromptSubmit = Array.isArray(cfg.hooks.UserPromptSubmit) ? cfg.hooks.UserPromptSubmit : [];
		const exists = cfg.hooks.UserPromptSubmit.some(
			(g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => String(h?.command ?? "").includes("clue hook")),
		);
		if (!exists) {
			cfg.hooks.UserPromptSubmit.push({
				hooks: [{ type: "command", command: `${clueBin} hook prompt --harness codex --with-boot`, timeout: 5 }],
			});
		}

		if (!dryRun) {
			mkdirSync(dirname(hooksPath), { recursive: true });
			writeFileSync(hooksPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
		}
		changes.push(`update ${hooksPath}`, installSkillFile(skillPath, dryRun));
		return { ok: true, target: "codex", changes, notes };
	}

	// hermes: install skill and print exact config.yaml snippet (avoids altering complex user YAML blindly)
	const skillPath = join(home, ".hermes", "skills", "clue", "SKILL.md");
	changes.push(installSkillFile(skillPath, dryRun));
	notes.push(
		"Add to ~/.hermes/config.yaml to disable built-in memory and enable clue shell hooks:",
		"memory:\n  memory_enabled: false\n  user_profile_enabled: false\nhooks:\n  pre_llm_call:\n    - command: " +
			`${absClueBin} hook prompt --harness hermes --with-boot\n      timeout: 5\n  pre_tool_call:\n    - matcher: write_file|patch|terminal\n      command: ${absClueBin} hook guard --harness hermes\n      timeout: 5`,
	);
	return { ok: true, target: "hermes", changes, notes };
}

function fileContains(path: string, needle: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return readFileSync(path, "utf8").includes(needle);
	} catch {
		return false;
	}
}

function dirHasClueFile(dir: string): boolean {
	if (!existsSync(dir)) return false;
	try {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const lower = ent.name.toLowerCase();
			if (lower.includes("clue")) return true;
			if (ent.isFile() && (lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".mjs"))) {
				if (fileContains(join(dir, ent.name), "clue")) return true;
			}
		}
	} catch {
		// ignore
	}
	return false;
}

/**
 * Inspects all 7 supported harnesses on the local machine to verify hook, guard, skill, and native-memory status.
 */
export function inspectHarnessAdapters(homeDir = homedir()): HarnessAdapterStatus[] {
	const results: HarnessAdapterStatus[] = [];

	// 1) AGY
	const agyRoot = join(homeDir, ".gemini");
	const agyPluginDir = join(agyRoot, "config", "plugins", "clue");
	const agyHooksPath = join(agyPluginDir, "hooks.json");
	const agySkillPath = join(agyPluginDir, "skills", "clue", "SKILL.md");
	const agyDetected = existsSync(agyRoot);
	const agyHook = fileContains(agyHooksPath, "clue hook");
	const agyGuard = fileContains(agyHooksPath, "hook guard");
	const agySkill = existsSync(agySkillPath);
	results.push({
		harness: "agy",
		detected: agyDetected,
		hookWired: agyHook,
		guardWired: agyGuard,
		skillWired: agySkill,
		nativeMemoryDisabled: null,
		detail: !agyDetected
			? "not installed"
			: agyHook && agyGuard && agySkill
				? "plugin hooks + guard + skill OK"
				: "missing plugin hooks/guard/skill (run `clue install agy`)",
	});

	// 2) Claude Code
	const claudeDir = join(homeDir, ".claude");
	const claudeSettings = join(claudeDir, "settings.json");
	const claudeSkill = join(claudeDir, "skills", "clue", "SKILL.md");
	const claudeDetected = existsSync(claudeDir);
	let claudeNativeOff: boolean | null = null;
	if (existsSync(claudeSettings)) {
		try {
			const cfg = JSON.parse(readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
			if (typeof cfg.autoMemoryEnabled === "boolean") {
				claudeNativeOff = cfg.autoMemoryEnabled === false;
			}
		} catch {
			// ignore
		}
	}
	const claudeHook = fileContains(claudeSettings, "clue hook");
	const claudeGuard = fileContains(claudeSettings, "hook guard");
	const claudeSkillOk = existsSync(claudeSkill);
	results.push({
		harness: "claude",
		detected: claudeDetected,
		hookWired: claudeHook,
		guardWired: claudeGuard,
		skillWired: claudeSkillOk,
		nativeMemoryDisabled: claudeNativeOff,
		detail: !claudeDetected
			? "not installed"
			: claudeHook && claudeGuard && claudeSkillOk
				? `hooks + guard + skill OK${claudeNativeOff === false ? " (warning: autoMemoryEnabled is true)" : ""}`
				: "incomplete setup (run `clue install claude`)",
	});

	// 3) Codex
	const codexDir = join(homeDir, ".codex");
	const codexHooks = join(codexDir, "hooks.json");
	const codexSkill = join(codexDir, "skills", "clue", "SKILL.md");
	const codexDetected = existsSync(codexDir);
	const codexHook = fileContains(codexHooks, "clue hook");
	const codexGuard = fileContains(codexHooks, "hook guard");
	const codexSkillOk = existsSync(codexSkill);
	results.push({
		harness: "codex",
		detected: codexDetected,
		hookWired: codexHook,
		guardWired: codexGuard,
		skillWired: codexSkillOk,
		nativeMemoryDisabled: null,
		detail: !codexDetected
			? "not installed"
			: codexHook && codexSkillOk
				? `prompt+boot hook + skill OK${codexGuard ? " + guard" : " (protected by OS read-only guard)"}`
				: "incomplete setup (run `clue install codex`)",
	});

	// 4) OMP
	const ompDir = join(homeDir, ".omp");
	const ompDetected = existsSync(ompDir);
	const ompExt =
		dirHasClueFile(join(ompDir, "agent", "extensions")) ||
		dirHasClueFile(join(ompDir, "extensions")) ||
		fileContains(join(ompDir, "agent", "config.json"), "clue");
	const ompSkill = existsSync(join(ompDir, "agent", "skills", "clue", "SKILL.md")) || existsSync(join(ompDir, "skills", "clue", "SKILL.md"));
	results.push({
		harness: "omp",
		detected: ompDetected,
		hookWired: ompExt,
		guardWired: ompExt,
		skillWired: ompSkill || ompExt,
		nativeMemoryDisabled: null,
		detail: !ompDetected ? "not installed" : ompExt ? "extension wired" : "detected without clue extension",
	});

	// 5) pi
	const piDir = join(homeDir, ".pi");
	const piDetected = existsSync(piDir);
	const piExt =
		dirHasClueFile(join(piDir, "agent", "extensions")) ||
		dirHasClueFile(join(piDir, "extensions"));
	const piSkill = existsSync(join(piDir, "agent", "skills", "clue", "SKILL.md")) || existsSync(join(piDir, "skills", "clue", "SKILL.md"));
	results.push({
		harness: "pi",
		detected: piDetected,
		hookWired: piExt,
		guardWired: piExt,
		skillWired: piSkill || piExt,
		nativeMemoryDisabled: null,
		detail: !piDetected ? "not installed" : piExt ? "extension wired" : "detected without clue extension",
	});

	// 6) OpenCode
	const ocConfigDir = join(homeDir, ".config", "opencode");
	const ocShareDir = join(homeDir, ".local", "share", "opencode");
	const ocDetected = existsSync(ocConfigDir) || existsSync(ocShareDir);
	const ocPlugin =
		dirHasClueFile(join(ocConfigDir, "plugin")) ||
		dirHasClueFile(join(ocConfigDir, "plugins")) ||
		fileContains(join(ocConfigDir, "opencode.json"), "clue");
	results.push({
		harness: "opencode",
		detected: ocDetected,
		hookWired: ocPlugin,
		guardWired: ocPlugin,
		skillWired: ocPlugin,
		nativeMemoryDisabled: null,
		detail: !ocDetected ? "not installed" : ocPlugin ? "plugin wired" : "detected without clue plugin",
	});

	// 7) Hermes
	const hermesDir = join(homeDir, ".hermes");
	const hermesCfg = join(hermesDir, "config.yaml");
	const hermesSkill = join(hermesDir, "skills", "clue", "SKILL.md");
	const hermesDetected = existsSync(hermesDir);
	const hermesHook = fileContains(hermesCfg, "clue hook");
	const hermesGuard = fileContains(hermesCfg, "hook guard");
	const hermesSkillOk = existsSync(hermesSkill);
	let hermesNativeOff: boolean | null = null;
	if (existsSync(hermesCfg)) {
		const raw = readFileSync(hermesCfg, "utf8");
		if (/memory_enabled:\s*false/.test(raw)) hermesNativeOff = true;
		else if (/memory_enabled:\s*true/.test(raw)) hermesNativeOff = false;
	}
	results.push({
		harness: "hermes",
		detected: hermesDetected,
		hookWired: hermesHook,
		guardWired: hermesGuard,
		skillWired: hermesSkillOk,
		nativeMemoryDisabled: hermesNativeOff,
		detail: !hermesDetected
			? "not installed"
			: hermesHook && hermesSkillOk
				? `hooks${hermesGuard ? " + guard" : ""} + skill OK${hermesNativeOff === false ? " (warning: native memory enabled)" : ""}`
				: "incomplete setup (run `clue install hermes`)",
	});

	return results;
}
