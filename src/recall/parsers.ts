import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DEFAULT_WORKSPACE_ROOTS, DEFAULT_WORKTREE_SUFFIXES } from "../core/config.ts";
import { redactSecrets } from "../core/security.ts";

export { redactSecrets };

export type RecallHarness = "agy" | "claude" | "codex" | "omp" | "pi" | "opencode" | "hermes";

export interface ParsedMessage {
	seq: number;
	role: "user" | "assistant";
	ts: string;
	content: string;
}

export interface ParsedSession {
	sourceKey: string;
	id: string;
	harness: RecallHarness;
	project: string;
	cwd: string;
	title: string;
	firstUserMsg: string;
	lastUserMsg: string;
	sourcePath: string;
	startedAt: string;
	updatedAt: string;
	isNoise: boolean;
	mtimeMs: number;
	sizeBytes: number;
	messages: ParsedMessage[];
}

export interface DiscoveredFile {
	sourceKey: string;
	harness: RecallHarness;
	path: string;
	mtimeMs: number;
	sizeBytes: number;
}

const MAX_STORED_MSG_CHARS = 8000;
const ANCHOR_MSG_CAP = 120;

function cleanMessageText(raw: string): string {
	let text = raw
		.replace(/^<USER_REQUEST>\s*/i, "")
		.replace(/\s*<\/USER_REQUEST>$/i, "")
		.trim();
	if (!text) return "";
	// Drop injected system wrappers & compaction summaries so FTS stays high-signal
	if (
		text.startsWith("[CONTEXT COMPACTION") ||
		text.startsWith("[CONTEXT SUMMARY]:") ||
		text.startsWith("# AGENTS.md instructions") ||
		text.startsWith("<environment_context>") ||
		text.startsWith("<local-command-caveat>") ||
		text.startsWith("<command-name>") ||
		text.startsWith("<SYSTEM_MESSAGE>")
	) {
		return "";
	}
	text = redactSecrets(text);
	if (text.length > MAX_STORED_MSG_CHARS) {
		text = `${text.slice(0, MAX_STORED_MSG_CHARS)}…[truncated]`;
	}
	return text;
}

function makeAnchorExcerpt(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= ANCHOR_MSG_CAP) return flat;
	return `${flat.slice(0, ANCHOR_MSG_CAP)}…`;
}

function buildWorktreeSuffixRegex(suffixes: readonly string[]): RegExp {
	const escaped = suffixes.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new RegExp(`^([a-z0-9_]+)-(?:${escaped})[0-9]*$`);
}

export function deriveProjectFromPath(
	cwdOrDir: string,
	worktreeSuffixes: readonly string[] = DEFAULT_WORKTREE_SUFFIXES,
	workspaceRoots: readonly string[] = DEFAULT_WORKSPACE_ROOTS,
): string {
	const raw = cwdOrDir.trim();
	if (!raw) return "global";
	let seg = basename(raw.replace(/[/\\]+$/, ""));
	const rootNames = new Set(workspaceRoots.map(r => r.toLowerCase()));
	if (seg.startsWith("-")) {
		for (const root of rootNames) {
			const marker = `${root}-`;
			if (seg.toLowerCase().includes(marker)) {
				const idx = seg.toLowerCase().lastIndexOf(marker);
				seg = seg.slice(idx + marker.length);
				break;
			}
		}
	} else if (seg.startsWith("--") && seg.endsWith("--")) {
		seg = seg.slice(2, -2).split("-").pop() ?? seg;
	}
	const lower = seg.trim().toLowerCase();
	if (!lower || rootNames.has(lower) || lower === basename(homedir()).toLowerCase()) {
		return "global";
	}
	const suffixRe = buildWorktreeSuffixRegex(worktreeSuffixes);
	const m = lower.match(suffixRe);
	if (m) return m[1]!;
	// Ad-hoc worktrees like `Rakko-hermes` or `Rakko-issue6` next to the primary `Rakko` checkout.
	const dash = seg.indexOf("-");
	if (dash > 0 && isAbsolute(raw) && existsSync(join(dirname(raw.replace(/[/\\]+$/, "")), seg.slice(0, dash)))) {
		return seg.slice(0, dash).toLowerCase();
	}
	return lower;
}

/**
 * AGY transcripts carry no cwd. Infer the project from the workspace path the conversation mentions
 * most (at least 3 times), e.g. `/Users/me/workspace/clue/src/...` → `clue`.
 */
function inferProjectFromMentions(
	messages: readonly ParsedMessage[],
	worktreeSuffixes: readonly string[] | undefined,
	workspaceRoots: readonly string[] = DEFAULT_WORKSPACE_ROOTS,
): string {
	const rootAlt = workspaceRoots.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const re = new RegExp(`(?:/Users|/home)/[^/\\s]+/(?:${rootAlt})/[^/\\s"'\`)<>]+`, "g");
	const counts = new Map<string, number>();
	for (const msg of messages) {
		for (const m of msg.content.matchAll(re)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
	}
	const byProject = new Map<string, number>();
	for (const [path, n] of counts) {
		const key = deriveProjectFromPath(path, worktreeSuffixes, workspaceRoots);
		byProject.set(key, (byProject.get(key) ?? 0) + n);
	}
	const [best, n] = [...byProject].sort((a, b) => b[1] - a[1])[0] ?? ["global", 0];
	return n >= 3 ? best : "global";
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
		} else if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if ((b.type === "text" || b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
				parts.push(b.text);
			}
		}
	}
	return parts.join("\n");
}

function walkFiles(dir: string, matcher: (name: string) => boolean, maxDepth = 5, depth = 0): string[] {
	if (depth > maxDepth || !existsSync(dir)) return [];
	const out: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		const full = join(dir, ent.name);
		if (ent.isDirectory()) {
			out.push(...walkFiles(full, matcher, maxDepth, depth + 1));
		} else if (ent.isFile() && matcher(ent.name)) {
			out.push(full);
		}
	}
	return out;
}

export function discoverFileSources(homeDir = homedir(), filterHarness?: RecallHarness): DiscoveredFile[] {
	const files: DiscoveredFile[] = [];
	const pushFile = (harness: RecallHarness, filePath: string) => {
		try {
			const st = statSync(filePath);
			if (!st.isFile() || st.size === 0) return;
			files.push({
				sourceKey: `${harness}:${filePath}`,
				harness,
				path: filePath,
				mtimeMs: Math.floor(st.mtimeMs),
				sizeBytes: st.size,
			});
		} catch {
			// skip unreadable
		}
	};

	if (!filterHarness || filterHarness === "agy") {
		const brainDir = join(homeDir, ".gemini", "antigravity", "brain");
		if (existsSync(brainDir)) {
			try {
				for (const ent of readdirSync(brainDir, { withFileTypes: true })) {
					if (!ent.isDirectory()) continue;
					const tr = join(brainDir, ent.name, ".system_generated", "logs", "transcript.jsonl");
					if (existsSync(tr)) pushFile("agy", tr);
				}
			} catch {
				// ignore
			}
		}
	}

	if (!filterHarness || filterHarness === "claude") {
		for (const f of walkFiles(join(homeDir, ".claude", "projects"), n => n.endsWith(".jsonl"), 3)) {
			pushFile("claude", f);
		}
	}

	if (!filterHarness || filterHarness === "codex") {
		const isCodexFile = (n: string) => n.endsWith(".jsonl") || n.endsWith(".jsonl.zst");
		for (const f of walkFiles(join(homeDir, ".codex", "sessions"), isCodexFile, 5)) {
			pushFile("codex", f);
		}
		for (const f of walkFiles(join(homeDir, ".codex", "archived_sessions"), isCodexFile, 2)) {
			pushFile("codex", f);
		}
	}

	if (!filterHarness || filterHarness === "omp") {
		for (const f of walkFiles(join(homeDir, ".omp", "agent", "sessions"), n => n.endsWith(".jsonl"), 4)) {
			pushFile("omp", f);
		}
	}

	if (!filterHarness || filterHarness === "pi") {
		for (const f of walkFiles(join(homeDir, ".pi", "agent", "sessions"), n => n.endsWith(".jsonl"), 4)) {
			pushFile("pi", f);
		}
	}

	return files;
}

function readLinesFlexible(filePath: string): string[] {
	const buf = readFileSync(filePath);
	const raw = filePath.endsWith(".zst")
		? new TextDecoder().decode(Bun.zstdDecompressSync(buf))
		: buf.toString("utf8");
	return raw.split("\n");
}

export function parseFileSession(
	file: DiscoveredFile,
	opts?: { worktreeSuffixes?: readonly string[]; workspaceRoots?: readonly string[] },
): ParsedSession | null {
	let lines: string[];
	try {
		lines = readLinesFlexible(file.path);
	} catch {
		return null;
	}

	const messages: ParsedMessage[] = [];
	let sessionId = "";
	let cwd = "";
	let title = "";
	let firstUserMsg = "";
	let lastUserMsg = "";
	let startedAt = "";
	let updatedAt = "";
	let isNoise = false;

	const recordMsg = (role: "user" | "assistant", rawText: string, ts: string) => {
		const text = cleanMessageText(rawText);
		if (!text) return;
		if (!startedAt && ts) startedAt = ts;
		if (ts) updatedAt = ts;
		if (role === "user") {
			const excerpt = makeAnchorExcerpt(text);
			if (!firstUserMsg) firstUserMsg = excerpt;
			lastUserMsg = excerpt;
			if (!title) title = text.replace(/\s+/g, " ").slice(0, 90);
		}
		messages.push({ seq: messages.length + 1, role, ts: ts || "", content: text });
	};

	if (file.harness === "agy") {
		const parts = file.path.split(/[/\\]+/);
		const brainIdx = parts.lastIndexOf("brain");
		sessionId = `agy:${brainIdx >= 0 && parts[brainIdx + 1] ? parts[brainIdx + 1] : basename(file.path)}`;
		for (const line of lines) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const type = String(obj.type ?? "");
			const ts = String(obj.created_at ?? "");
			if (type === "USER_INPUT" && obj.source === "USER_EXPLICIT") {
				recordMsg("user", String(obj.content ?? ""), ts);
			} else if (type === "PLANNER_RESPONSE" && typeof obj.content === "string" && obj.content.trim()) {
				recordMsg("assistant", obj.content, ts);
			}
		}
	} else if (file.harness === "claude") {
		sessionId = `claude:${basename(file.path, ".jsonl")}`;
		cwd = basename(join(file.path, ".."));
		for (const line of lines) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (obj.isSidechain === true) isNoise = true;
			if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
			const type = String(obj.type ?? "");
			if (type !== "user" && type !== "assistant") continue;
			const msg = (obj.message ?? {}) as Record<string, unknown>;
			const role = msg.role === "user" || type === "user" ? "user" : "assistant";
			const text = extractTextFromContent(msg.content);
			recordMsg(role, text, String(obj.timestamp ?? ""));
		}
	} else if (file.harness === "codex") {
		sessionId = `codex:${basename(file.path).replace(/\.jsonl(\.zst)?$/, "")}`;
		for (const line of lines) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const type = String(obj.type ?? "");
			const ts = String(obj.timestamp ?? "");
			const payload = (obj.payload ?? {}) as Record<string, unknown>;
			if (type === "session_meta") {
				if (typeof payload.session_id === "string" && payload.session_id) {
					sessionId = `codex:${payload.session_id}`;
				}
				if (typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
			} else if (type === "response_item" && payload.type === "message") {
				const role = payload.role;
				if (role !== "user" && role !== "assistant") continue;
				const text = extractTextFromContent(payload.content);
				recordMsg(role, text, ts);
			}
		}
	} else if (file.harness === "omp" || file.harness === "pi") {
		const baseId = basename(file.path, ".jsonl");
		sessionId = `${file.harness}:${baseId}`;
		if (file.harness === "omp" && !/^\d{4}-\d{2}-\d{2}T/.test(baseId)) {
			isNoise = true;
		}
		for (const line of lines) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const type = String(obj.type ?? "");
			if (type === "session") {
				if (typeof obj.id === "string" && obj.id) sessionId = `${file.harness}:${obj.id}`;
				if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
				if (typeof obj.timestamp === "string" && obj.timestamp && !startedAt) startedAt = obj.timestamp;
			} else if (type === "title" && typeof obj.title === "string" && obj.title.trim()) {
				title = obj.title.trim();
			} else if (type === "message") {
				const msg = (obj.message ?? {}) as Record<string, unknown>;
				const role = msg.role;
				if (role !== "user" && role !== "assistant") continue;
				const text = extractTextFromContent(msg.content);
				recordMsg(role, text, String(obj.timestamp ?? ""));
			}
		}
	}

	if (messages.length === 0) return null;

	const fallbackIso = new Date(file.mtimeMs).toISOString();
	return {
		sourceKey: file.sourceKey,
		id: sessionId,
		harness: file.harness,
		project:
			file.harness === "agy" && !cwd
				? inferProjectFromMentions(messages, opts?.worktreeSuffixes, opts?.workspaceRoots)
				: deriveProjectFromPath(cwd || basename(join(file.path, "..")), opts?.worktreeSuffixes, opts?.workspaceRoots),
		cwd,
		title: title || basename(file.path),
		firstUserMsg,
		lastUserMsg,
		sourcePath: file.path,
		startedAt: startedAt || fallbackIso,
		updatedAt: updatedAt || fallbackIso,
		isNoise,
		mtimeMs: file.mtimeMs,
		sizeBytes: file.sizeBytes,
		messages,
	};
}

export function loadOpenCodeSessions(
	homeDir = homedir(),
	existingUpdated?: Map<string, string>,
	opts?: { worktreeSuffixes?: readonly string[]; workspaceRoots?: readonly string[] },
): {
	dbPath: string;
	mtimeMs: number;
	sizeBytes: number;
	sessions: ParsedSession[];
	skippedSessions: number;
} | null {
	const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
	if (!existsSync(dbPath)) return null;
	const st = statSync(dbPath);
	const db = new Database(dbPath, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 3000;");
		const rawSessions = db
			.query("SELECT id, directory, title, time_created, time_updated, parent_id FROM session ORDER BY time_updated DESC")
			.all() as Array<{
			id: string;
			directory: string;
			title: string;
			time_created: number;
			time_updated: number;
			parent_id: string | null;
		}>;

		const changedSessions: typeof rawSessions = [];
		let skippedSessions = 0;
		for (const s of rawSessions) {
			const updatedIso = s.time_updated ? new Date(s.time_updated).toISOString() : new Date(st.mtimeMs).toISOString();
			const prev = existingUpdated?.get(`opencode:${s.id}`);
			if (prev && prev === updatedIso) {
				skippedSessions++;
				continue;
			}
			changedSessions.push(s);
		}
		if (changedSessions.length === 0) {
			return { dbPath, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, sessions: [], skippedSessions };
		}

		const msgStmt = db.query(
			`SELECT m.id, m.time_created, m.data as msg_data, p.data as part_data
			 FROM message m
			 LEFT JOIN part p ON p.message_id = m.id
			 WHERE m.session_id = ?
			 ORDER BY m.time_created ASC, p.time_created ASC`,
		);

		const sessions: ParsedSession[] = [];
		for (const s of changedSessions) {
			const joinedRows = msgStmt.all(s.id) as Array<{
				id: string;
				time_created: number;
				msg_data: string;
				part_data: string | null;
			}>;
			const grouped = new Map<string, { role: "user" | "assistant"; time_created: number; texts: string[] }>();
			for (const row of joinedRows) {
				let entry = grouped.get(row.id);
				if (!entry) {
					let meta: Record<string, unknown>;
					try {
						meta = JSON.parse(row.msg_data) as Record<string, unknown>;
					} catch {
						continue;
					}
					if (meta.role !== "user" && meta.role !== "assistant") continue;
					entry = { role: meta.role, time_created: row.time_created, texts: [] };
					grouped.set(row.id, entry);
				}
				if (row.part_data) {
					try {
						const pd = JSON.parse(row.part_data) as Record<string, unknown>;
						if (pd.type === "text" && typeof pd.text === "string") entry.texts.push(pd.text);
					} catch {
						// ignore
					}
				}
			}

			const messages: ParsedMessage[] = [];
			let firstUserMsg = "";
			let lastUserMsg = "";
			for (const entry of grouped.values()) {
				const cleaned = cleanMessageText(entry.texts.join("\n"));
				if (!cleaned) continue;
				if (entry.role === "user") {
					const ex = makeAnchorExcerpt(cleaned);
					if (!firstUserMsg) firstUserMsg = ex;
					lastUserMsg = ex;
				}
				const ts = entry.time_created ? new Date(entry.time_created).toISOString() : "";
				messages.push({ seq: messages.length + 1, role: entry.role, ts, content: cleaned });
			}
			if (messages.length === 0) continue;
			sessions.push({
				sourceKey: `opencode:${s.id}`,
				id: `opencode:${s.id}`,
				harness: "opencode",
				project: deriveProjectFromPath(s.directory || "", opts?.worktreeSuffixes, opts?.workspaceRoots),
				cwd: s.directory || "",
				title: s.title || messages[0]!.content.slice(0, 80),
				firstUserMsg,
				lastUserMsg,
				sourcePath: dbPath,
				startedAt: s.time_created ? new Date(s.time_created).toISOString() : new Date(st.mtimeMs).toISOString(),
				updatedAt: s.time_updated ? new Date(s.time_updated).toISOString() : new Date(st.mtimeMs).toISOString(),
				isNoise: Boolean(s.parent_id),
				mtimeMs: Math.floor(st.mtimeMs),
				sizeBytes: st.size,
				messages,
			});
		}
		return { dbPath, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, sessions, skippedSessions };
	} finally {
		db.close();
	}
}

export function loadHermesSessions(
	homeDir = homedir(),
	existingUpdated?: Map<string, string>,
	opts?: { worktreeSuffixes?: readonly string[]; workspaceRoots?: readonly string[] },
): {
	dbPath: string;
	mtimeMs: number;
	sizeBytes: number;
	sessions: ParsedSession[];
	skippedSessions: number;
} | null {
	const dbPath = join(homeDir, ".hermes", "state.db");
	if (!existsSync(dbPath)) return null;
	const st = statSync(dbPath);
	const db = new Database(dbPath, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 3000;");
		const rawSessions = db
			.query(
				`SELECT id, source, display_name, cwd, started_at, ended_at, parent_session_id
				 FROM sessions ORDER BY started_at DESC`,
			)
			.all() as Array<{
			id: string;
			source: string;
			display_name: string | null;
			cwd: string | null;
			started_at: number;
			ended_at: number | null;
			parent_session_id: string | null;
		}>;

		const changedSessions: Array<{ row: (typeof rawSessions)[number]; startedIso: string; updatedIso: string }> = [];
		let skippedSessions = 0;
		for (const s of rawSessions) {
			const startedIso = s.started_at ? new Date(s.started_at * 1000).toISOString() : new Date(st.mtimeMs).toISOString();
			const updatedIso = s.ended_at ? new Date(s.ended_at * 1000).toISOString() : startedIso;
			const prev = existingUpdated?.get(`hermes:${s.id}`);
			if (prev && prev === updatedIso && s.ended_at !== null) {
				skippedSessions++;
				continue;
			}
			changedSessions.push({ row: s, startedIso, updatedIso });
		}
		if (changedSessions.length === 0) {
			return { dbPath, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, sessions: [], skippedSessions };
		}

		const msgStmt = db.query(
			`SELECT role, content, timestamp FROM messages
			 WHERE session_id = ? AND role IN ('user', 'assistant') AND COALESCE(_compressed_summary, 0) = 0
			 ORDER BY id ASC`,
		);

		const noiseSources = new Set(["cron", "subagent", "kanban", "tool"]);
		const sessions: ParsedSession[] = [];
		for (const { row: s, startedIso, updatedIso } of changedSessions) {
			const rawMsgs = msgStmt.all(s.id) as Array<{ role: "user" | "assistant"; content: string | null; timestamp: number }>;
			const messages: ParsedMessage[] = [];
			let firstUserMsg = "";
			let lastUserMsg = "";
			for (const m of rawMsgs) {
				if (!m.content) continue;
				const cleaned = cleanMessageText(m.content);
				if (!cleaned) continue;
				if (m.role === "user") {
					const ex = makeAnchorExcerpt(cleaned);
					if (!firstUserMsg) firstUserMsg = ex;
					lastUserMsg = ex;
				}
				const ts = m.timestamp ? new Date(m.timestamp * 1000).toISOString() : "";
				messages.push({ seq: messages.length + 1, role: m.role, ts, content: cleaned });
			}
			if (messages.length === 0) continue;
			sessions.push({
				sourceKey: `hermes:${s.id}`,
				id: `hermes:${s.id}`,
				harness: "hermes",
				project: deriveProjectFromPath(s.cwd || "", opts?.worktreeSuffixes, opts?.workspaceRoots),
				cwd: s.cwd || "",
				title: s.display_name || messages[0]!.content.slice(0, 80),
				firstUserMsg,
				lastUserMsg,
				sourcePath: dbPath,
				startedAt: startedIso,
				updatedAt: updatedIso,
				isNoise: noiseSources.has(String(s.source || "").toLowerCase()) || Boolean(s.parent_session_id),
				mtimeMs: Math.floor(st.mtimeMs),
				sizeBytes: st.size,
				messages,
			});
		}
		return { dbPath, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, sessions, skippedSessions };
	} finally {
		db.close();
	}
}
