import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type InstallTarget = "agy" | "claude" | "codex" | "hermes";

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
