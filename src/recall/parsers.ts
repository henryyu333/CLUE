import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

const REDACT_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	/\b(?:sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,})\b/g,
	/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gho_[A-Za-z0-9]{30,})\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
	/\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const re of REDACT_PATTERNS) {
		out = out.replace(re, "[REDACTED]");
	}
	return out;
}

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

export function deriveProjectFromPath(cwdOrDir: string): string {
	const raw = cwdOrDir.trim();
	if (!raw) return "global";
	// Handle Claude/OMP encoded folder names like -Users-alice-workspace-acme-fix
	let seg = basename(raw.replace(/\/+$/, ""));
	if (seg.startsWith("-") && seg.includes("workspace-")) {
		seg = seg.split("workspace-").pop() ?? seg;
	} else if (seg.startsWith("--") && seg.endsWith("--")) {
		seg = seg.slice(2, -2).split("-").pop() ?? seg;
	}
	const lower = seg.trim().toLowerCase();
	if (!lower || lower === "workspace" || lower === basename(homedir()).toLowerCase()) {
		return "global";
	}
	// Collapse common worktree suffixes like acme-fix / acme-wt1 -> acme
	const m = lower.match(/^([a-z0-9_]+)-(?:fix|rv[a-z0-9]*|ship[0-9]*|windows|wt[0-9]*)$/);
	return m ? m[1]! : lower;
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

export function parseFileSession(file: DiscoveredFile): ParsedSession | null {
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
	let startedAt = "";
	let updatedAt = "";
	let isNoise = false;

	const recordMsg = (role: "user" | "assistant", rawText: string, ts: string) => {
		const text = cleanMessageText(rawText);
		if (!text) return;
		if (!startedAt && ts) startedAt = ts;
		if (ts) updatedAt = ts;
		if (!title && role === "user") {
			title = text.replace(/\s+/g, " ").slice(0, 90);
		}
		messages.push({ seq: messages.length + 1, role, ts: ts || "", content: text });
	};

	if (file.harness === "agy") {
		// Path: ~/.gemini/antigravity/brain/<conv-id>/.system_generated/logs/transcript.jsonl
		const parts = file.path.split("/");
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
		// Subagent logs under a session directory often have non-timestamp filenames
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
		project: file.harness === "agy" ? (cwd ? deriveProjectFromPath(cwd) : "global") : deriveProjectFromPath(cwd || basename(join(file.path, ".."))),
		cwd,
		title: title || basename(file.path),
		sourcePath: file.path,
		startedAt: startedAt || fallbackIso,
		updatedAt: updatedAt || fallbackIso,
		isNoise,
		mtimeMs: file.mtimeMs,
		sizeBytes: file.sizeBytes,
		messages,
	};
}

export function loadOpenCodeSessions(homeDir = homedir()): {
	dbPath: string;
	mtimeMs: number;
	sizeBytes: number;
	sessions: ParsedSession[];
} | null {
	const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
	if (!existsSync(dbPath)) return null;
	const st = statSync(dbPath);
	const db = new Database(dbPath, { readonly: true });
	try {
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

		const msgStmt = db.query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC");
		const partStmt = db.query("SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC");

		const sessions: ParsedSession[] = [];
		for (const s of rawSessions) {
			const rawMsgs = msgStmt.all(s.id) as Array<{ id: string; time_created: number; data: string }>;
			const messages: ParsedMessage[] = [];
			for (const m of rawMsgs) {
				let meta: Record<string, unknown>;
				try {
					meta = JSON.parse(m.data) as Record<string, unknown>;
				} catch {
					continue;
				}
				const role = meta.role;
				if (role !== "user" && role !== "assistant") continue;
				const parts = partStmt.all(m.id) as Array<{ data: string }>;
				const texts: string[] = [];
				for (const p of parts) {
					try {
						const pd = JSON.parse(p.data) as Record<string, unknown>;
						if (pd.type === "text" && typeof pd.text === "string") texts.push(pd.text);
					} catch {
						// ignore
					}
				}
				const cleaned = cleanMessageText(texts.join("\n"));
				if (!cleaned) continue;
				const ts = m.time_created ? new Date(m.time_created).toISOString() : "";
				messages.push({ seq: messages.length + 1, role, ts, content: cleaned });
			}
			if (messages.length === 0) continue;
			sessions.push({
				sourceKey: `opencode:${s.id}`,
				id: `opencode:${s.id}`,
				harness: "opencode",
				project: deriveProjectFromPath(s.directory || ""),
				cwd: s.directory || "",
				title: s.title || messages[0]!.content.slice(0, 80),
				sourcePath: dbPath,
				startedAt: s.time_created ? new Date(s.time_created).toISOString() : new Date(st.mtimeMs).toISOString(),
				updatedAt: s.time_updated ? new Date(s.time_updated).toISOString() : new Date(st.mtimeMs).toISOString(),
				isNoise: Boolean(s.parent_id),
				mtimeMs: Math.floor(st.mtimeMs),
				sizeBytes: st.size,
				messages,
			});
		}
		return { dbPath, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, sessions };
	} finally {
		db.close();
	}
}

export function loadHermesSessions(homeDir = homedir()): {
	dbPath: string;
	mtimeMs: number;
	sizeBytes: number;
	sessions: ParsedSession[];
} | null {
	const dbPath = join(homeDir, ".hermes", "state.db");
	if (!existsSync(dbPath)) return null;
	const st = statSync(dbPath);
	const db = new Database(dbPath, { readonly: true });
	try {
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

		const msgStmt = db.query(
			`SELECT role, content, timestamp FROM messages
			 WHERE session_id = ? AND role IN ('user', 'assistant') AND COALESCE(_compressed_summary, 0) = 0
			 ORDER BY id ASC`,
		);

		const noiseSources = new Set(["cron", "subagent", "kanban", "tool"]);
		const sessions: ParsedSession[] = [];
		for (const s of rawSessions) {
			const rawMsgs = msgStmt.all(s.id) as Array<{ role: "user" | "assistant"; content: string | null; timestamp: number }>;
			const messages: ParsedMessage[] = [];
			for (const m of rawMsgs) {
				if (!m.content) continue;
				const cleaned = cleanMessageText(m.content);
				if (!cleaned) continue;
				const ts = m.timestamp ? new Date(m.timestamp * 1000).toISOString() : "";
				messages.push({ seq: messages.length + 1, role: m.role, ts, content: cleaned });
			}
			if (messages.length === 0) continue;
			const startedIso = s.started_at ? new Date(s.started_at * 1000).toISOString() : new Date(st.mtimeMs).toISOString();
			const updatedIso = s.ended_at ? new Date(s.ended_at * 1000).toISOString() : startedIso;
			sessions.push({
				sourceKey: `hermes:${s.id}`,
				id: `hermes:${s.id}`,
				harness: "hermes",
				project: deriveProjectFromPath(s.cwd || ""),
				cwd: s.cwd || "",
				title: s.display_name || messages[0]!.content.slice(0, 80),
				sourcePath: dbPath,
				startedAt: startedIso,
				updatedAt: updatedIso,
				isNoise: noiseSources.has(String(s.source || "").toLowerCase()) || Boolean(s.parent_session_id),
				mtimeMs: Math.floor(st.mtimeMs),
				sizeBytes: st.size,
				messages,
			});
		}
		return { dbPath, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, sessions };
	} finally {
		db.close();
	}
}
