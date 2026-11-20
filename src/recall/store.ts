import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { withMemoryLock } from "../core/lock.ts";
import {
	discoverFileSources,
	loadHermesSessions,
	loadOpenCodeSessions,
	parseFileSession,
	type ParsedSession,
	type RecallHarness,
} from "./parsers.ts";

export interface IndexSummary {
	scannedFiles: number;
	indexedSessions: number;
	skippedUnchanged: number;
	indexedMessages: number;
	byHarness: Record<string, { sessions: number; messages: number }>;
	elapsedMs: number;
}

export interface RecallOptions {
	query: string;
	harness?: RecallHarness;
	project?: string | null;
	role?: "user" | "assistant";
	since?: string;
	limit?: number;
	includeNoise?: boolean;
}

export interface RecallHit {
	sessionId: string;
	harness: string;
	project: string;
	title: string;
	seq: number;
	role: string;
	ts: string;
	isNoise: boolean;
	snippet: string;
}

export interface RecentSessionAnchor {
	id: string;
	harness: string;
	project: string;
	title: string;
	firstUserMsg: string;
	lastUserMsg: string;
	updatedAt: string;
	msgCount: number;
}

export interface ShowOptions {
	idPrefix: string;
	around?: number;
	window?: number;
	offset?: number;
	limit?: number;
	full?: boolean;
}

const SNIPPET_CAP = 360;
const SHOW_MSG_CAP = 2000;

function hasColumn(db: Database, table: string, col: string): boolean {
	const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return cols.some(c => c.name === col);
}

export function openRecallDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS index_sources (
			source_key TEXT PRIMARY KEY,
			harness TEXT NOT NULL,
			path TEXT NOT NULL,
			mtime_ms INTEGER NOT NULL,
			size_bytes INTEGER NOT NULL,
			indexed_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			source_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			project TEXT NOT NULL,
			cwd TEXT NOT NULL,
			title TEXT NOT NULL,
			first_user_msg TEXT NOT NULL DEFAULT '',
			last_user_msg TEXT NOT NULL DEFAULT '',
			source_path TEXT NOT NULL,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			is_noise INTEGER NOT NULL DEFAULT 0,
			msg_count INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_harness ON sessions(harness);
		CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
		CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project, is_noise, updated_at DESC);
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			ts TEXT NOT NULL,
			content TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			content,
			content='messages',
			content_rowid='id',
			tokenize='trigram'
		);
		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
			INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
			INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
		END;
	`);

	if (!hasColumn(db, "sessions", "first_user_msg")) {
		db.exec("ALTER TABLE sessions ADD COLUMN first_user_msg TEXT NOT NULL DEFAULT '';");
	}
	if (!hasColumn(db, "sessions", "last_user_msg")) {
		db.exec("ALTER TABLE sessions ADD COLUMN last_user_msg TEXT NOT NULL DEFAULT '';");
	}

	return db;
}

function parseRelativeSince(since?: string): string | null {
	if (!since?.trim()) return null;
	const m = since.trim().match(/^(\d+)\s*(h|d|w|m)$/i);
	if (!m) return since.trim();
	const n = Number.parseInt(m[1]!, 10);
	const unit = m[2]!.toLowerCase();
	const secMap: Record<string, number> = { h: 3600, d: 86400, w: 604800, m: 2592000 };
	return new Date(Date.now() - n * (secMap[unit] ?? 86400) * 1000).toISOString();
}

export function indexRecallSessions(
	dbPath: string,
	options: {
		harness?: RecallHarness;
		rebuild?: boolean;
		homeDir?: string;
		lockPath?: string;
		worktreeSuffixes?: readonly string[];
		workspaceRoots?: readonly string[];
	} = {},
): IndexSummary {
	const lockPath = options.lockPath ?? `${dbPath}.lock`;
	return withMemoryLock(lockPath, () => {
		const started = Date.now();
		const homeDir = options.homeDir ?? homedir();
		if (options.rebuild) {
			rmSync(dbPath, { force: true });
			rmSync(`${dbPath}-wal`, { force: true });
			rmSync(`${dbPath}-shm`, { force: true });
		}

		const db = openRecallDb(dbPath);
		let scannedFiles = 0;
		let indexedSessions = 0;
		let skippedUnchanged = 0;
		let indexedMessages = 0;

		try {
			const getSource = db.query("SELECT mtime_ms, size_bytes FROM index_sources WHERE source_key = ?");
			const upsertSource = db.query(
				`INSERT INTO index_sources (source_key, harness, path, mtime_ms, size_bytes, indexed_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(source_key) DO UPDATE SET mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, indexed_at=excluded.indexed_at`,
			);
			const deleteOldMsgs = db.query("DELETE FROM messages WHERE session_id = ?");
			const upsertSession = db.query(
				`INSERT INTO sessions (id, source_key, harness, project, cwd, title, first_user_msg, last_user_msg, source_path, started_at, updated_at, is_noise, msg_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   project=excluded.project, cwd=excluded.cwd, title=excluded.title,
				   first_user_msg=excluded.first_user_msg, last_user_msg=excluded.last_user_msg,
				   started_at=excluded.started_at, updated_at=excluded.updated_at,
				   is_noise=excluded.is_noise, msg_count=excluded.msg_count`,
			);
			const insertMsg = db.query("INSERT INTO messages (session_id, seq, role, ts, content) VALUES (?, ?, ?, ?, ?)");

			const writeSessionBatch = db.transaction((sessions: ParsedSession[]) => {
				const now = new Date().toISOString();
				for (const s of sessions) {
					deleteOldMsgs.run(s.id);
					upsertSession.run(
						s.id,
						s.sourceKey,
						s.harness,
						s.project,
						s.cwd,
						s.title,
						s.firstUserMsg,
						s.lastUserMsg,
						s.sourcePath,
						s.startedAt,
						s.updatedAt,
						s.isNoise ? 1 : 0,
						s.messages.length,
					);
					for (const m of s.messages) {
						insertMsg.run(s.id, m.seq, m.role, m.ts, m.content);
					}
					upsertSource.run(s.sourceKey, s.harness, s.sourcePath, s.mtimeMs, s.sizeBytes, now);
					indexedSessions++;
					indexedMessages += s.messages.length;
				}
			});

			const parseOpts = {
				worktreeSuffixes: options.worktreeSuffixes,
				workspaceRoots: options.workspaceRoots,
			};

			// 1) File-based harnesses: AGY, Claude Code, Codex, OMP, pi
			const discovered = discoverFileSources(homeDir, options.harness);
			const pendingBatch: ParsedSession[] = [];
			const now = new Date().toISOString();

			for (const f of discovered) {
				scannedFiles++;
				const existing = getSource.get(f.sourceKey) as { mtime_ms: number; size_bytes: number } | null;
				if (existing && existing.mtime_ms === f.mtimeMs && existing.size_bytes === f.sizeBytes) {
					skippedUnchanged++;
					continue;
				}
				const parsed = parseFileSession(f, parseOpts);
				if (!parsed) {
					upsertSource.run(f.sourceKey, f.harness, f.path, f.mtimeMs, f.sizeBytes, now);
					continue;
				}
				pendingBatch.push(parsed);
				if (pendingBatch.length >= 25) {
					writeSessionBatch(pendingBatch);
					pendingBatch.length = 0;
				}
			}
			if (pendingBatch.length > 0) {
				writeSessionBatch(pendingBatch);
				pendingBatch.length = 0;
			}

			// 2) SQLite-backed harnesses: true per-session incremental sync for OpenCode & Hermes
			const getExistingUpdatedMap = (harness: RecallHarness): Map<string, string> => {
				const rows = db
					.query("SELECT id, updated_at FROM sessions WHERE harness = ?")
					.all(harness) as Array<{ id: string; updated_at: string }>;
				const map = new Map<string, string>();
				for (const r of rows) map.set(r.id, r.updated_at);
				return map;
			};

			const syncDbSource = (
				dbKey: string,
				harness: RecallHarness,
				loader: (existing: Map<string, string>) => {
					dbPath: string;
					mtimeMs: number;
					sizeBytes: number;
					sessions: ParsedSession[];
					skippedSessions: number;
				} | null,
			) => {
				if (options.harness && options.harness !== harness) return;
				const existing = getSource.get(dbKey) as { mtime_ms: number; size_bytes: number } | null;
				const existingMap = getExistingUpdatedMap(harness);
				const loaded = loader(existingMap);
				if (!loaded) return;
				scannedFiles++;
				if (existing && existing.mtime_ms === loaded.mtimeMs && existing.size_bytes === loaded.sizeBytes) {
					skippedUnchanged++;
					return;
				}
				if (loaded.sessions.length > 0) {
					writeSessionBatch(loaded.sessions);
				}
				skippedUnchanged += loaded.skippedSessions;
				upsertSource.run(dbKey, harness, loaded.dbPath, loaded.mtimeMs, loaded.sizeBytes, new Date().toISOString());
			};

			syncDbSource("db:opencode", "opencode", map => loadOpenCodeSessions(homeDir, map, parseOpts));
			syncDbSource("db:hermes", "hermes", map => loadHermesSessions(homeDir, map, parseOpts));

			const statsRows = db
				.query("SELECT harness, COUNT(*) as sessions, COALESCE(SUM(msg_count), 0) as messages FROM sessions GROUP BY harness")
				.all() as Array<{ harness: string; sessions: number; messages: number }>;
			const byHarness: Record<string, { sessions: number; messages: number }> = {};
			for (const r of statsRows) {
				byHarness[r.harness] = { sessions: r.sessions, messages: r.messages };
			}

			return {
				scannedFiles,
				indexedSessions,
				skippedUnchanged,
				indexedMessages,
				byHarness,
				elapsedMs: Date.now() - started,
			};
		} finally {
			db.close();
		}
	});
}

export function getRecallSources(dbPath: string): Array<{
	harness: string;
	sessions: number;
	messages: number;
	latestUpdated: string;
}> {
	if (!existsSync(dbPath)) return [];
	const db = openRecallDb(dbPath);
	try {
		return db
			.query(
				`SELECT harness, COUNT(*) as sessions, COALESCE(SUM(msg_count), 0) as messages, MAX(updated_at) as latestUpdated
				 FROM sessions GROUP BY harness ORDER BY sessions DESC`,
			)
			.all() as Array<{ harness: string; sessions: number; messages: number; latestUpdated: string }>;
	} finally {
		db.close();
	}
}

/**
 * Fast (~2ms) query returning recent non-noise sessions for a project after an optional ISO watermark.
 * Used as an automatic continuity fallback when a user closed a session without explicit wrap-up.
 */
export function getRecentProjectSessionAnchors(
	dbPath: string,
	projectKey: string,
	options: { afterIso?: string | null; limit?: number } = {},
): RecentSessionAnchor[] {
	if (!existsSync(dbPath) || !projectKey) return [];
	const db = openRecallDb(dbPath);
	try {
		const limit = Math.max(1, Math.min(8, options.limit ?? 2));
		const afterIso = options.afterIso?.trim() || "";
		const rows = (
			afterIso
				? db
						.query(
							`SELECT id, harness, project, title, first_user_msg, last_user_msg, updated_at, msg_count
							 FROM sessions
							 WHERE project = ? AND is_noise = 0 AND msg_count >= 2 AND updated_at > ?
							 ORDER BY updated_at DESC
							 LIMIT ?`,
						)
						.all(projectKey.toLowerCase(), afterIso, limit)
				: db
						.query(
							`SELECT id, harness, project, title, first_user_msg, last_user_msg, updated_at, msg_count
							 FROM sessions
							 WHERE project = ? AND is_noise = 0 AND msg_count >= 2
							 ORDER BY updated_at DESC
							 LIMIT ?`,
						)
						.all(projectKey.toLowerCase(), limit)
		) as Array<{
			id: string;
			harness: string;
			project: string;
			title: string;
			first_user_msg: string;
			last_user_msg: string;
			updated_at: string;
			msg_count: number;
		}>;

		return rows.map(r => ({
			id: r.id,
			harness: r.harness,
			project: r.project,
			title: r.title,
			firstUserMsg: r.first_user_msg || r.title,
			lastUserMsg: r.last_user_msg || "",
			updatedAt: r.updated_at,
			msgCount: r.msg_count,
		}));
	} catch {
		return [];
	} finally {
		db.close();
	}
}

function makeSnippet(content: string, terms: string[]): string {
	const flat = content.replace(/\s+/g, " ").trim();
	if (flat.length <= SNIPPET_CAP) return flat;
	const lower = flat.toLowerCase();
	let hitIdx = -1;
	for (const t of terms) {
		const idx = lower.indexOf(t.toLowerCase());
		if (idx >= 0) {
			hitIdx = idx;
			break;
		}
	}
	if (hitIdx < 0) return `${flat.slice(0, SNIPPET_CAP)}…`;
	const start = Math.max(0, hitIdx - 110);
	const end = Math.min(flat.length, start + SNIPPET_CAP);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function recallSessions(dbPath: string, opts: RecallOptions): RecallHit[] {
	if (!existsSync(dbPath)) return [];
	const db = openRecallDb(dbPath);
	try {
		const limit = Math.max(1, Math.min(30, opts.limit ?? 8));
		const sinceIso = parseRelativeSince(opts.since);
		const whereParts: string[] = [];
		const filterParams: (string | number)[] = [];

		if (opts.harness) {
			whereParts.push("s.harness = ?");
			filterParams.push(opts.harness);
		}
		if (opts.role) {
			whereParts.push("m.role = ?");
			filterParams.push(opts.role);
		}
		if (sinceIso) {
			whereParts.push("s.updated_at >= ?");
			filterParams.push(sinceIso);
		}
		if (!opts.includeNoise) {
			whereParts.push("s.is_noise = 0");
		}

		const terms = opts.query
			.trim()
			.split(/\s+/)
			.filter(t => [...t].length >= 2)
			.slice(0, 8);

		if (terms.length === 0) {
			if (opts.role) {
				const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
				const rows = db
					.query(
						`SELECT m.session_id as sessionId, s.harness, s.project, s.title, m.seq, m.role,
						        COALESCE(NULLIF(m.ts, ''), s.updated_at) as ts, s.is_noise as isNoise, m.content
						 FROM messages m
						 JOIN sessions s ON s.id = m.session_id
						 ${whereSql}
						 ORDER BY s.is_noise ASC, s.updated_at DESC, m.seq DESC
						 LIMIT ?`,
					)
					.all(...filterParams, limit * 4) as Array<{
					sessionId: string;
					harness: string;
					project: string;
					title: string;
					ts: string;
					isNoise: number;
					seq: number;
					role: string;
					content: string;
				}>;
				const dedup = new Map<string, RecallHit>();
				for (const r of rows) {
					if (dedup.has(r.sessionId)) continue;
					dedup.set(r.sessionId, {
						sessionId: r.sessionId,
						harness: r.harness,
						project: r.project,
						title: r.title,
						seq: r.seq,
						role: r.role,
						ts: r.ts,
						isNoise: r.isNoise === 1,
						snippet: makeSnippet(r.content, []),
					});
					if (dedup.size >= limit) break;
				}
				return [...dedup.values()];
			}

			const sessionWhereParts = whereParts.filter(p => !p.startsWith("m."));
			const whereSql = sessionWhereParts.length > 0 ? `WHERE ${sessionWhereParts.join(" AND ")}` : "";
			const rows = db
				.query(
					`SELECT s.id as sessionId, s.harness, s.project, s.title, s.updated_at as ts, s.is_noise as isNoise,
					        1 as seq, 'user' as role, s.title as content
					 FROM sessions s
					 ${whereSql}
					 ORDER BY s.is_noise ASC, s.updated_at DESC
					 LIMIT ?`,
				)
				.all(...filterParams, limit) as Array<{
				sessionId: string;
				harness: string;
				project: string;
				title: string;
				ts: string;
				isNoise: number;
				seq: number;
				role: string;
				content: string;
			}>;
			return rows.map(r => ({
				sessionId: r.sessionId,
				harness: r.harness,
				project: r.project,
				title: r.title,
				seq: r.seq,
				role: r.role,
				ts: r.ts,
				isNoise: r.isNoise === 1,
				snippet: makeSnippet(r.content, []),
			}));
		}

		const ftsTerms = terms.filter(t => [...t].length >= 3);
		const projKey = opts.project?.trim().toLowerCase() ?? "";
		const hitsBySession = new Map<string, RecallHit>();

		if (ftsTerms.length > 0) {
			const hasOr = /\bOR\b/i.test(opts.query);
			const ftsExpr = ftsTerms
				.filter(t => t.toUpperCase() !== "OR")
				.map(t => `"${t.replaceAll('"', '""')}"`)
				.join(hasOr ? " OR " : " AND ");

			const runFts = (expr: string) => {
				const conds = ["messages_fts MATCH ?", ...whereParts];
				const sql = `
					SELECT m.session_id as sessionId, s.harness, s.project, s.title, m.seq, m.role,
					       COALESCE(NULLIF(m.ts, ''), s.updated_at) as ts, s.is_noise as isNoise, m.content
					FROM messages_fts f
					JOIN messages m ON m.id = f.rowid
					JOIN sessions s ON s.id = m.session_id
					WHERE ${conds.join(" AND ")}
					ORDER BY
						s.is_noise ASC,
						(CASE WHEN s.project = ? THEN 0 ELSE 1 END) ASC,
						bm25(messages_fts) ASC,
						s.updated_at DESC
					LIMIT ?
				`;
				return db.query(sql).all(expr, ...filterParams, projKey, limit * 8) as Array<{
					sessionId: string;
					harness: string;
					project: string;
					title: string;
					seq: number;
					role: string;
					ts: string;
					isNoise: number;
					content: string;
				}>;
			};

			try {
				let rows = runFts(ftsExpr);
				if (rows.length === 0 && !hasOr && ftsTerms.length > 1) {
					const relaxed = ftsTerms.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
					rows = runFts(relaxed);
				}
				for (const r of rows) {
					if (hitsBySession.has(r.sessionId)) continue;
					hitsBySession.set(r.sessionId, {
						sessionId: r.sessionId,
						harness: r.harness,
						project: r.project,
						title: r.title,
						seq: r.seq,
						role: r.role,
						ts: r.ts,
						isNoise: r.isNoise === 1,
						snippet: makeSnippet(r.content, terms),
					});
					if (hitsBySession.size >= limit) break;
				}
			} catch {
				// fall through to LIKE fallback
			}
		}

		// Fallback LIKE search for 2-char CJK words or when FTS returned fewer than limit
		if (hitsBySession.size < limit) {
			const cleanTerms = terms.filter(t => t.toUpperCase() !== "OR");
			const likeExpr = cleanTerms.map(() => "m.content LIKE ?").join(" OR ");
			const conds = [`(${likeExpr})`, ...whereParts];
			const params: (string | number)[] = [...cleanTerms.map(t => `%${t}%`), ...filterParams, projKey, limit * 6];
			const rows = db
				.query(
					`SELECT m.session_id as sessionId, s.harness, s.project, s.title, m.seq, m.role,
					        COALESCE(NULLIF(m.ts, ''), s.updated_at) as ts, s.is_noise as isNoise, m.content
					 FROM messages m
					 JOIN sessions s ON s.id = m.session_id
					 WHERE ${conds.join(" AND ")}
					 ORDER BY
					   s.is_noise ASC,
					   (CASE WHEN s.project = ? THEN 0 ELSE 1 END) ASC,
					   s.updated_at DESC
					 LIMIT ?`,
				)
				.all(...params) as Array<{
				sessionId: string;
				harness: string;
				project: string;
				title: string;
				seq: number;
				role: string;
				ts: string;
				isNoise: number;
				content: string;
			}>;
			for (const r of rows) {
				if (hitsBySession.has(r.sessionId)) continue;
				hitsBySession.set(r.sessionId, {
					sessionId: r.sessionId,
					harness: r.harness,
					project: r.project,
					title: r.title,
					seq: r.seq,
					role: r.role,
					ts: r.ts,
					isNoise: r.isNoise === 1,
					snippet: makeSnippet(r.content, cleanTerms),
				});
				if (hitsBySession.size >= limit) break;
			}
		}

		return [...hitsBySession.values()];
	} finally {
		db.close();
	}
}

export function showSessionWindow(dbPath: string, opts: ShowOptions): {
	ok: boolean;
	message: string;
	session?: Record<string, unknown>;
	messages?: Array<{ seq: number; role: string; ts: string; content: string }>;
} {
	if (!existsSync(dbPath)) {
		return { ok: false, message: "尚未建立会话索引，请先运行 `clue index`。" };
	}
	const db = openRecallDb(dbPath);
	try {
		const prefix = opts.idPrefix.trim();
		const matches = db
			.query("SELECT * FROM sessions WHERE id = ? OR id LIKE ? OR id LIKE ? ORDER BY updated_at DESC LIMIT 5")
			.all(prefix, `${prefix}%`, `%:${prefix}%`) as Array<{
			id: string;
			harness: string;
			project: string;
			cwd: string;
			title: string;
			started_at: string;
			updated_at: string;
			msg_count: number;
		}>;

		if (matches.length === 0) {
			return { ok: false, message: `未找到匹配 "${prefix}" 的历史会话。` };
		}
		if (matches.length > 1 && matches[0]!.id !== prefix) {
			return {
				ok: false,
				message: `前缀 "${prefix}" 匹配到多个会话，请提供更长前缀：\n${matches.map(m => `- ${m.id} (${m.updated_at.slice(0, 10)}) ${m.title}`).join("\n")}`,
			};
		}

		const s = matches[0]!;
		let rows: Array<{ seq: number; role: string; ts: string; content: string }>;
		if (typeof opts.around === "number" && Number.isFinite(opts.around)) {
			const win = Math.max(1, Math.min(20, opts.window ?? 4));
			const lo = Math.max(1, opts.around - win);
			const hi = opts.around + win;
			rows = db
				.query("SELECT seq, role, ts, content FROM messages WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC")
				.all(s.id, lo, hi) as Array<{ seq: number; role: string; ts: string; content: string }>;
		} else {
			const offset = Math.max(0, opts.offset ?? 0);
			const limit = Math.max(1, Math.min(50, opts.limit ?? 12));
			rows = db
				.query("SELECT seq, role, ts, content FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?")
				.all(s.id, limit, offset) as Array<{ seq: number; role: string; ts: string; content: string }>;
		}

		const capped = rows.map(r => ({
			...r,
			content:
				!opts.full && r.content.length > SHOW_MSG_CAP
					? `${r.content.slice(0, SHOW_MSG_CAP)}…[truncated; pass --full for complete text]`
					: r.content,
		}));

		const header = [
			`=== Session ${s.id} ===`,
			`Harness: ${s.harness} | Project: ${s.project} | Messages: ${s.msg_count} | Updated: ${s.updated_at}`,
			`Title: ${s.title}`,
			"",
		].join("\n");
		const body = capped
			.map(m => `[#${m.seq} ${m.role.toUpperCase()}${m.ts ? ` @ ${m.ts.slice(0, 19)}` : ""}]\n${m.content}`)
			.join("\n\n---\n\n");

		return { ok: true, message: `${header}${body}`, session: s, messages: capped };
	} finally {
		db.close();
	}
}
