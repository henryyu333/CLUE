import { existsSync, readFileSync } from "node:fs";
import type { ClueConfig, CluePaths } from "./config.ts";
import { commitMemoryGit } from "./git.ts";
import { atomicWriteFileSync, withMemoryLock } from "./lock.ts";
import { scanMemoryContent } from "./security.ts";

export type SectionMap = Map<string, string[]>;

export interface CurateOperation {
	action: "add" | "patch" | "remove";
	section?: string;
	oldText?: string;
	/** Mandatory full-line pin for patch/remove: refuses mutation if the matched entry drifted since preview. */
	expectedEntry?: string;
	/** Explicit override required to patch or remove an entry tagged with [pin]. */
	forcePin?: boolean;
	content?: string;
}

export interface CurateRequest {
	target: "profile" | "projects" | "view";
	scope?: string;
	operations?: CurateOperation[];
	reason?: string;
	dryRun?: boolean;
}

export interface CurateResult {
	ok: boolean;
	message: string;
	commit?: string | null;
	details?: Record<string, unknown>;
}

export function charCount(text: string): number {
	return [...text.trim()].length;
}

export function isPinnedEntry(entry: string): boolean {
	return /^(?:\[pin\]\s*)|(?:\s*\[pin\])$/i.test(entry.trim());
}

export function parseSectionedMarkdown(raw: string): SectionMap {
	const map: SectionMap = new Map();
	let current = "";
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("# ")) {
			current = line.slice(2).trim();
			if (!map.has(current)) map.set(current, []);
			continue;
		}
		if (current && line.startsWith("- ")) {
			map.get(current)!.push(line.slice(2).trim());
		}
	}
	return map;
}

export function serializeProfile(map: SectionMap, sections: readonly string[]): string {
	const blocks: string[] = [];
	const seen = new Set<string>();
	for (const sec of sections) {
		seen.add(sec);
		const items = map.get(sec) ?? [];
		const body = items.map(item => `- ${item}`).join("\n");
		blocks.push(body ? `# ${sec}\n${body}` : `# ${sec}`);
	}
	// Preserve any custom sections that might already exist on disk
	for (const [sec, items] of map.entries()) {
		if (seen.has(sec) || items.length === 0) continue;
		blocks.push(`# ${sec}\n${items.map(item => `- ${item}`).join("\n")}`);
	}
	return `${blocks.join("\n\n")}\n`;
}

export function serializeProjects(map: SectionMap, globalHeading: string): string {
	const blocks: string[] = [];
	const globalItems = map.get(globalHeading) ?? [];
	blocks.push(
		globalItems.length > 0
			? `# ${globalHeading}\n${globalItems.map(i => `- ${i}`).join("\n")}`
			: `# ${globalHeading}`,
	);
	for (const [heading, items] of map.entries()) {
		if (heading === globalHeading) continue;
		if (items.length === 0) continue;
		blocks.push(`# ${heading}\n${items.map(i => `- ${i}`).join("\n")}`);
	}
	return `${blocks.join("\n\n")}\n`;
}

export interface ScopedProjectsView {
	text: string;
	globalChars: number;
	projectChars: number;
	allProjects: Array<{ heading: string; chars: number; count: number }>;
}

export function renderScopedProjectsView(
	projectsRaw: string,
	projectKey: string | null,
	globalHeading: string,
): ScopedProjectsView {
	const map = parseSectionedMarkdown(projectsRaw);
	const parts: string[] = [];
	const globalItems = map.get(globalHeading) ?? [];
	const globalBlock =
		globalItems.length > 0 ? `# ${globalHeading}\n${globalItems.map(i => `- ${i}`).join("\n")}` : "";
	if (globalBlock) parts.push(globalBlock);

	let projectBlock = "";
	const allProjects: Array<{ heading: string; chars: number; count: number }> = [];

	for (const [heading, items] of map.entries()) {
		const block = items.length > 0 ? `# ${heading}\n${items.map(i => `- ${i}`).join("\n")}` : "";
		allProjects.push({ heading, chars: charCount(block), count: items.length });
		if (projectKey && heading.toLowerCase() === `project: ${projectKey.toLowerCase()}` && items.length > 0) {
			projectBlock = `# Project: ${projectKey.toLowerCase()}\n${items.map(i => `- ${i}`).join("\n")}`;
			parts.push(projectBlock);
		}
	}

	return {
		text: parts.join("\n\n"),
		globalChars: charCount(globalBlock),
		projectChars: charCount(projectBlock),
		allProjects,
	};
}

export function validateEntryText(content: string, entryLimit: number): string | null {
	const trimmed = content.trim().replace(/^-\s+/, "");
	if (!trimmed) return "条目内容不能为空。";
	if (/[\r\n]/.test(trimmed)) return "单条记忆禁止换行或包含子列表，请压缩为单行原子短句。";
	if (/^#{1,6}\s/.test(trimmed)) return "单条记忆禁止包含 Markdown 标题符号。";
	const sec = scanMemoryContent(trimmed);
	if (!sec.ok) return `安全安检拦截（${sec.rule}）：${sec.reason}`;
	const len = charCount(trimmed);
	if (len > entryLimit) {
		return `单条记忆超出硬上限（当前 ${len} 字，上限 ${entryLimit} 字），请删掉修饰语、压缩成高密度短句后重试。`;
	}
	return null;
}

export function readHotMemoryView(config: ClueConfig, paths: CluePaths, projectKey: string | null): {
	profileRaw: string;
	projectsRaw: string;
	profileChars: number;
	profilePct: number;
	scoped: ScopedProjectsView;
	formatted: string;
} {
	const profileRaw = existsSync(paths.profilePath) ? readFileSync(paths.profilePath, "utf8") : "";
	const projectsRaw = existsSync(paths.projectsPath) ? readFileSync(paths.projectsPath, "utf8") : "";
	const profileChars = charCount(profileRaw);
	const profilePct = Math.round((profileChars / config.limits.profileChars) * 100);
	const scoped = renderScopedProjectsView(projectsRaw, projectKey, config.globalProjectHeading);
	const formatted = [
		`=== PROFILE.md [${profileChars}/${config.limits.profileChars} 字 (${profilePct}%)] ===`,
		profileRaw.trim() || "(空)",
		"",
		`=== PROJECTS.md [全局 ${scoped.globalChars}/${config.limits.globalProjectChars} 字 | 当前项目(${projectKey ?? "none"}) ${scoped.projectChars}/${config.limits.singleProjectChars} 字] ===`,
		projectsRaw.trim() || "(空)",
	].join("\n");
	return { profileRaw, projectsRaw, profileChars, profilePct, scoped, formatted };
}

export function curateHotMemory(
	config: ClueConfig,
	paths: CluePaths,
	req: CurateRequest,
	projectKey: string | null,
): CurateResult {
	if (req.target === "view" || !req.operations || req.operations.length === 0) {
		const view = readHotMemoryView(config, paths, projectKey);
		return { ok: true, message: view.formatted, details: { target: "view" } };
	}

	return withMemoryLock(paths.lockPath, () => {
		const profileRaw = existsSync(paths.profilePath) ? readFileSync(paths.profilePath, "utf8") : "";
		const projectsRaw = existsSync(paths.projectsPath) ? readFileSync(paths.projectsPath, "utf8") : "";
		const isProfile = req.target === "profile";
		const map = parseSectionedMarkdown(isProfile ? profileRaw : projectsRaw);
		const appliedDiff: string[] = [];

		const resolveHeading = (opSection?: string): { ok: true; heading: string } | { ok: false; err: string } => {
			const rawSec = (opSection ?? req.scope ?? "").trim();
			if (isProfile) {
				if (!config.profileSections.includes(rawSec)) {
					return {
						ok: false,
						err: `PROFILE 分区无效（收到 "${rawSec}"）。必须指定为以下之一：${config.profileSections.join(" / ")}`,
					};
				}
				if (!map.has(rawSec)) map.set(rawSec, []);
				return { ok: true, heading: rawSec };
			}
			const norm =
				!rawSec || rawSec.toLowerCase() === "global" || rawSec === config.globalProjectHeading
					? config.globalProjectHeading
					: rawSec.toLowerCase().startsWith("project:")
						? `Project: ${rawSec.slice(8).trim().toLowerCase()}`
						: `Project: ${rawSec.toLowerCase()}`;
			if (!map.has(norm)) map.set(norm, []);
			return { ok: true, heading: norm };
		};

		for (const op of req.operations!) {
			if (op.action === "add") {
				const resolved = resolveHeading(op.section);
				if (!resolved.ok) return { ok: false, message: resolved.err };
				const err = validateEntryText(op.content ?? "", config.limits.entryChars);
				if (err) return { ok: false, message: err };
				const clean = (op.content ?? "").trim().replace(/^-\s+/, "");
				const items = map.get(resolved.heading)!;
				if (!items.includes(clean)) {
					items.push(clean);
					appliedDiff.push(`+ [${resolved.heading}] ${clean}`);
				}
			} else if (op.action === "patch" || op.action === "remove") {
				const needle = (op.oldText ?? "").trim();
				if (!needle) {
					return { ok: false, message: `${op.action} 操作必须提供 oldText 子串以唯一定位目标条目。` };
				}
				const expectedClean = op.expectedEntry?.trim().replace(/^-\s+/, "") ?? "";
				if (!expectedClean) {
					return {
						ok: false,
						message: `行级锁拦截：${op.action} 操作必须提供完整的 expectedEntry 原文核对，防止看错行改错条目。请先运行 \`clue view\` 核对原文。`,
					};
				}
				const matches: Array<{ heading: string; idx: number; item: string }> = [];
				const targetFilter = op.section ? resolveHeading(op.section) : null;
				if (targetFilter && !targetFilter.ok) {
					return { ok: false, message: targetFilter.err };
				}
				for (const [heading, items] of map.entries()) {
					if (targetFilter && targetFilter.ok && heading !== targetFilter.heading) continue;
					items.forEach((item, idx) => {
						if (item.includes(needle)) matches.push({ heading, idx, item });
					});
				}
				if (matches.length === 0) {
					return {
						ok: false,
						message: `未找到包含 "${needle}" 的条目。请先运行 \`clue view\` 核对原文后再提交。`,
					};
				}
				if (matches.length > 1) {
					return {
						ok: false,
						message: `oldText "${needle}" 匹配到了 ${matches.length} 条记录，请提供更具体的唯一子串：\n${matches.map(m => `- [${m.heading}] ${m.item}`).join("\n")}`,
					};
				}
				const hit = matches[0]!;
				if (hit.item !== expectedClean) {
					return {
						ok: false,
						message: `行级锁拦截：目标条目在你预览草稿后已发生变化。\n期望原文：${expectedClean}\n当前原文：${hit.item}\n请重新查看后再确认写入。`,
					};
				}
				if (isPinnedEntry(hit.item) && op.forcePin !== true) {
					return {
						ok: false,
						message: `锁钉拦截：该条目带有 [pin] 保护标记，禁止常规 ${op.action} 操作。\n目标条目：${hit.item}\n如确需改动，请向用户确认后传入 forcePin: true。`,
					};
				}
				const list = map.get(hit.heading)!;
				if (op.action === "remove") {
					list.splice(hit.idx, 1);
					appliedDiff.push(`- [${hit.heading}] ${hit.item}`);
				} else {
					const err = validateEntryText(op.content ?? "", config.limits.entryChars);
					if (err) return { ok: false, message: err };
					const clean = (op.content ?? "").trim().replace(/^-\s+/, "");
					list[hit.idx] = clean;
					appliedDiff.push(`- [${hit.heading}] ${hit.item}`, `+ [${hit.heading}] ${clean}`);
				}
			} else {
				return { ok: false, message: `不支持的操作类型：${String((op as { action?: unknown }).action)}` };
			}
		}

		if (isProfile) {
			const prevChars = charCount(profileRaw);
			const nextText = serializeProfile(map, config.profileSections);
			const nextChars = charCount(nextText);
			const delta = nextChars - prevChars;
			const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
			if (nextChars > config.limits.profileChars) {
				const overflow = nextChars - config.limits.profileChars;
				return {
					ok: false,
					message:
						`写入被硬上限拦截：PROFILE.md 变更后将达到 ${nextChars}/${config.limits.profileChars} 字（超出 ${overflow} 字）。\n` +
						`请在同一批 operations 中先 remove 过时条目或将相似条目 patch 合并精简（至少腾出 ${overflow} 字），再添加新条目。\n\n` +
						`当前 PROFILE.md 全文：\n${profileRaw.trim()}`,
					details: { overflow, nextChars, limit: config.limits.profileChars },
				};
			}
			const pct = Math.round((nextChars / config.limits.profileChars) * 100);
			if (req.dryRun) {
				return {
					ok: true,
					message: `[DRY-RUN] PROFILE.md 预检通过 [${nextChars}/${config.limits.profileChars} 字 (${pct}%), 净变动 ${deltaStr} 字]\n${appliedDiff.join("\n") || "无实质条目变动"}`,
					details: { dryRun: true, chars: nextChars, delta, limit: config.limits.profileChars },
				};
			}
			atomicWriteFileSync(paths.profilePath, nextText, { readOnly: config.readOnlyGuard });
			const sha = commitMemoryGit(paths.home, `profile: ${req.reason?.trim() || "curate entries"}`);
			return {
				ok: true,
				commit: sha,
				message:
					`PROFILE.md 已更新 [${nextChars}/${config.limits.profileChars} 字 (${pct}%), 净变动 ${deltaStr} 字]${sha ? ` (commit ${sha})` : ""}\n` +
					(appliedDiff.join("\n") || "无实质条目变动"),
				details: { chars: nextChars, delta, limit: config.limits.profileChars, commit: sha },
			};
		}

		for (const [heading, items] of map.entries()) {
			const blockText = items.length > 0 ? `# ${heading}\n${items.map(i => `- ${i}`).join("\n")}` : "";
			const bChars = charCount(blockText);
			const cap =
				heading === config.globalProjectHeading
					? config.limits.globalProjectChars
					: config.limits.singleProjectChars;
			if (bChars > cap) {
				const overflow = bChars - cap;
				return {
					ok: false,
					message:
						`写入被硬上限拦截：PROJECTS.md 的 [${heading}] 分区将达到 ${bChars}/${cap} 字（超出 ${overflow} 字）。\n` +
						`请在同一批 operations 中合并或淘汰该分区内的过时条目后再写入。\n\n当前分区内容：\n${blockText}`,
					details: { heading, overflow, chars: bChars, limit: cap },
				};
			}
		}

		const nextProjects = serializeProjects(map, config.globalProjectHeading);
		const scopedAfter = renderScopedProjectsView(nextProjects, projectKey, config.globalProjectHeading);
		if (req.dryRun) {
			return {
				ok: true,
				message:
					`[DRY-RUN] PROJECTS.md 预检通过 [全局 ${scopedAfter.globalChars}/${config.limits.globalProjectChars} 字 | 当前项目 ${scopedAfter.projectChars}/${config.limits.singleProjectChars} 字]\n` +
					(appliedDiff.join("\n") || "无实质条目变动"),
				details: { dryRun: true },
			};
		}
		atomicWriteFileSync(paths.projectsPath, nextProjects, { readOnly: config.readOnlyGuard });
		const sha = commitMemoryGit(paths.home, `projects: ${req.reason?.trim() || "curate entries"}`);
		return {
			ok: true,
			commit: sha,
			message:
				`PROJECTS.md 已更新 [全局 ${scopedAfter.globalChars}/${config.limits.globalProjectChars} 字 | 当前项目 ${scopedAfter.projectChars}/${config.limits.singleProjectChars} 字]${sha ? ` (commit ${sha})` : ""}\n` +
				(appliedDiff.join("\n") || "无实质条目变动"),
			details: { commit: sha },
		};
	});
}
