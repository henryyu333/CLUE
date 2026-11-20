import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { CluePaths } from "./config.ts";
import { commitMemoryGit } from "./git.ts";
import { atomicWriteFileSync, withMemoryLock } from "./lock.ts";
import { scanMemoryContent } from "./security.ts";

export interface PitfallRow {
	id: number;
	project: string;
	tags: string;
	symptom: string;
	root_cause: string;
	historical_fix: string;
	rethink_hint: string;
	evidence: string;
	status: string;
	superseded_by: number | null;
	hit_count: number;
	last_hit_at: string;
	verified_at: string;
	created_at: string;
	updated_at: string;
}

export interface PitfallMutationRequest {
	op: "add" | "supersede" | "update" | "delete";
	id?: number;
	project?: string;
	tags?: string;
	symptom?: string;
	rootCause?: string;
	historicalFix?: string;
	rethinkHint?: string;
	evidence?: string;
}

export interface PitfallMutationResult {
	ok: boolean;
	message: string;
	id?: number;
	superseded?: number | null;
	commit?: string | null;
}

function hasColumn(db: Database, table: string, col: string): boolean {
	const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return cols.some(c => c.name === col);
}

export function openPitfallDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS pitfalls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project TEXT NOT NULL DEFAULT 'global',
			tags TEXT NOT NULL DEFAULT '',
			symptom TEXT NOT NULL,
			root_cause TEXT NOT NULL,
			historical_fix TEXT NOT NULL,
			rethink_hint TEXT NOT NULL,
			evidence TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			superseded_by INTEGER,
			hit_count INTEGER NOT NULL DEFAULT 0,
			last_hit_at TEXT NOT NULL DEFAULT '',
			verified_at TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);

	// Safe in-place migration for existing DBs created before newer columns existed
	let needsFtsRebuild = false;
	if (!hasColumn(db, "pitfalls", "evidence")) {
		db.exec("ALTER TABLE pitfalls ADD COLUMN evidence TEXT NOT NULL DEFAULT '';");
		needsFtsRebuild = true;
	}
	if (!hasColumn(db, "pitfalls", "hit_count")) {
		db.exec("ALTER TABLE pitfalls ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;");
	}
	if (!hasColumn(db, "pitfalls", "last_hit_at")) {
		db.exec("ALTER TABLE pitfalls ADD COLUMN last_hit_at TEXT NOT NULL DEFAULT '';");
	}
	if (!hasColumn(db, "pitfalls", "verified_at")) {
		db.exec("ALTER TABLE pitfalls ADD COLUMN verified_at TEXT NOT NULL DEFAULT '';");
	}

	const ftsExists = Boolean(
		db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pitfalls_fts'").get(),
	);
	if (ftsExists && !hasColumn(db, "pitfalls_fts", "evidence")) {
		needsFtsRebuild = true;
	}

	if (!ftsExists || needsFtsRebuild) {
		db.exec(`
			DROP TRIGGER IF EXISTS pitfalls_ai;
			DROP TRIGGER IF EXISTS pitfalls_ad;
			DROP TRIGGER IF EXISTS pitfalls_au;
			DROP TABLE IF EXISTS pitfalls_fts;
			CREATE VIRTUAL TABLE pitfalls_fts USING fts5(
				project, tags, symptom, root_cause, historical_fix, rethink_hint, evidence,
				content='pitfalls', content_rowid='id',
				tokenize='trigram'
			);
			CREATE TRIGGER pitfalls_ai AFTER INSERT ON pitfalls BEGIN
				INSERT INTO pitfalls_fts(rowid, project, tags, symptom, root_cause, historical_fix, rethink_hint, evidence)
				VALUES (new.id, new.project, new.tags, new.symptom, new.root_cause, new.historical_fix, new.rethink_hint, new.evidence);
			END;
			CREATE TRIGGER pitfalls_ad AFTER DELETE ON pitfalls BEGIN
				INSERT INTO pitfalls_fts(pitfalls_fts, rowid, project, tags, symptom, root_cause, historical_fix, rethink_hint, evidence)
				VALUES ('delete', old.id, old.project, old.tags, old.symptom, old.root_cause, old.historical_fix, old.rethink_hint, old.evidence);
			END;
			CREATE TRIGGER pitfalls_au AFTER UPDATE ON pitfalls BEGIN
				INSERT INTO pitfalls_fts(pitfalls_fts, rowid, project, tags, symptom, root_cause, historical_fix, rethink_hint, evidence)
				VALUES ('delete', old.id, old.project, old.tags, old.symptom, old.root_cause, old.historical_fix, old.rethink_hint, old.evidence);
				INSERT INTO pitfalls_fts(rowid, project, tags, symptom, root_cause, historical_fix, rethink_hint, evidence)
				VALUES (new.id, new.project, new.tags, new.symptom, new.root_cause, new.historical_fix, new.rethink_hint, new.evidence);
			END;
			INSERT INTO pitfalls_fts(pitfalls_fts) VALUES('rebuild');
		`);
	}

	return db;
}

export function exportPitfallsJsonl(db: Database, jsonlPath: string, readOnly = true): void {
	const rows = db.query("SELECT * FROM pitfalls ORDER BY id ASC").all() as PitfallRow[];
	const content = rows.length > 0 ? `${rows.map(r => JSON.stringify(r)).join("\n")}\n` : "";
	atomicWriteFileSync(jsonlPath, content, { readOnly });
}

export function listActivePitfalls(dbPath: string, projectKey?: string | null): PitfallRow[] {
	if (!existsSync(dbPath)) return [];
	const db = openPitfallDb(dbPath);
	try {
		if (projectKey) {
			return db
				.query(
					`SELECT * FROM pitfalls
					 WHERE status = 'active' AND (project = ? OR project = 'global')
					 ORDER BY (CASE WHEN project = ? THEN 0 ELSE 1 END), hit_count DESC, updated_at DESC`,
				)
				.all(projectKey.toLowerCase(), projectKey.toLowerCase()) as PitfallRow[];
		}
		return db.query("SELECT * FROM pitfalls WHERE status = 'active' ORDER BY updated_at DESC").all() as PitfallRow[];
	} finally {
		db.close();
	}
}

export function recordPitfallHit(dbPath: string, ids: number[]): void {
	if (ids.length === 0 || !existsSync(dbPath)) return;
	const db = openPitfallDb(dbPath);
	try {
		const now = new Date().toISOString();
		const stmt = db.query("UPDATE pitfalls SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?");
		for (const id of ids) stmt.run(now, id);
	} catch {
		// Never fail read path due to telemetry update
	} finally {
		db.close();
	}
}

export function searchPitfalls(
	dbPath: string,
	query: string,
	projectKey: string | null,
	limit = 4,
	includeSuperseded = false,
): PitfallRow[] {
	if (!existsSync(dbPath)) return [];
	const db = openPitfallDb(dbPath);
	try {
		const statusClause = includeSuperseded ? "1=1" : "p.status = 'active'";
		const rawTokens: string[] = [];
		const seenTokens = new Set<string>();
		const addToken = (tok: string) => {
			const clean = tok.trim().toLowerCase();
			if ([...clean].length < 2 || seenTokens.has(clean)) return;
			seenTokens.add(clean);
			rawTokens.push(clean);
		};

		for (const m of query.matchAll(/[a-zA-Z0-9_.-]{2,}/g)) {
			addToken(m[0]);
		}
		const cjkStop =
			/(?:今天|排查|一下|帮我|看看|怎么|为什么|出现|遇到|问题|处理|修复|解决|关于|时候|还是|依然|不能|无法|一个|这个|那个)/g;
		for (const m of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
			const cleaned = m[0].replace(cjkStop, " ").trim();
			for (const part of cleaned.split(/\s+/).filter(Boolean)) {
				const chars = [...part];
				if (chars.length <= 4) {
					addToken(part);
				} else {
					for (let i = 0; i <= chars.length - 2 && rawTokens.length < 12; i++) {
						addToken(chars.slice(i, i + 2).join(""));
					}
				}
			}
		}
		rawTokens.splice(10);

		if (rawTokens.length === 0) {
			const sql = projectKey
				? `SELECT * FROM pitfalls p WHERE ${statusClause} AND (p.project = ? OR p.project = 'global') ORDER BY p.project = ? DESC, p.updated_at DESC LIMIT ?`
				: `SELECT * FROM pitfalls p WHERE ${statusClause} ORDER BY p.updated_at DESC LIMIT ?`;
			return (
				projectKey ? db.query(sql).all(projectKey, projectKey, limit) : db.query(sql).all(limit)
			) as PitfallRow[];
		}

		const ftsTokens = rawTokens.filter(t => [...t].length >= 3);
		const results = new Map<number, PitfallRow>();

		if (ftsTokens.length > 0) {
			const ftsExpr = ftsTokens.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
			try {
				const ftsRows = db
					.query(
						`SELECT p.* FROM pitfalls_fts f
						 JOIN pitfalls p ON p.id = f.rowid
						 WHERE pitfalls_fts MATCH ? AND ${statusClause}
						 ORDER BY (CASE WHEN p.project = ? THEN 0 WHEN p.project = 'global' THEN 1 ELSE 2 END), bm25(pitfalls_fts)
						 LIMIT ?`,
					)
					.all(ftsExpr, projectKey ?? "", limit) as PitfallRow[];
				for (const r of ftsRows) results.set(r.id, r);
			} catch {
				// fallback to LIKE below
			}
		}

		if (results.size < limit) {
			const likeClauses = rawTokens
				.map(
					() =>
						"(p.tags LIKE ? OR p.symptom LIKE ? OR p.root_cause LIKE ? OR p.historical_fix LIKE ? OR p.evidence LIKE ?)",
				)
				.join(" OR ");
			const params: (string | number)[] = [];
			for (const tok of rawTokens) {
				const pat = `%${tok}%`;
				params.push(pat, pat, pat, pat, pat);
			}
			params.push(projectKey ?? "", limit);
			const likeRows = db
				.query(
					`SELECT p.* FROM pitfalls p
					 WHERE (${likeClauses}) AND ${statusClause}
					 ORDER BY (CASE WHEN p.project = ? THEN 0 WHEN p.project = 'global' THEN 1 ELSE 2 END), p.updated_at DESC
					 LIMIT ?`,
				)
				.all(...params) as PitfallRow[];
			for (const r of likeRows) {
				if (results.size >= limit) break;
				results.set(r.id, r);
			}
		}

		return [...results.values()];
	} finally {
		db.close();
	}
}

export function formatPitfallGuidance(rows: PitfallRow[]): string {
	if (rows.length === 0) return "未检索到匹配的历史踩坑记录。";
	const header = [
		"【历史踩坑线索（防锚定原则）】",
		"- 仅将 `root_cause`（客观根因）视为已验证线索，省去重复排障弯路；",
		"- `historical_fix` 仅代表当时的权宜解法，绝非规定动作！请结合当前代码库现状优先思考更直接简单的解法；",
		"- 若带 `evidence` 溯源锚点，怀疑过时或需要核对细节时请直接查阅原件；",
		"- 若验证了更优解法，收尾草稿中可提议用 `clue pitfall` (`op=\"supersede\"`) 演进替换旧记录。",
		"",
	].join("\n");
	const items = rows.map(r => {
		const lines = [
			`[Pitfall #${r.id} | scope=${r.project} | status=${r.status}${r.tags ? ` | tags=${r.tags}` : ""}]`,
			`  现象: ${r.symptom}`,
			`  根因: ${r.root_cause}`,
			`  当时解法(仅供参考): ${r.historical_fix}`,
			`  重思提示: ${r.rethink_hint}`,
		];
		if (r.evidence?.trim()) {
			lines.push(`  溯源线索: ${r.evidence.trim()}`);
		}
		return lines.join("\n");
	});
	return `${header}${items.join("\n\n")}`;
}

export function mutatePitfall(
	paths: CluePaths,
	params: PitfallMutationRequest,
	defaultProject: string | null,
	readOnlyGuard = true,
): PitfallMutationResult {
	for (const field of [params.tags, params.symptom, params.rootCause, params.historicalFix, params.rethinkHint, params.evidence]) {
		if (!field) continue;
		const sec = scanMemoryContent(field);
		if (!sec.ok) {
			return { ok: false, message: `安全安检拦截（${sec.rule}）：${sec.reason}` };
		}
	}

	return withMemoryLock(paths.lockPath, () => {
		const db = openPitfallDb(paths.dbPath);
		try {
			const now = new Date().toISOString();
			const proj = (params.project?.trim().toLowerCase() || defaultProject || "global").replace(/^project:\s*/, "");

			if (params.op === "delete") {
				if (!params.id) return { ok: false, message: "delete 操作需要提供 id。" };
				const res = db.query("DELETE FROM pitfalls WHERE id = ?").run(params.id);
				exportPitfallsJsonl(db, paths.jsonlPath, readOnlyGuard);
				const sha = commitMemoryGit(paths.home, `pitfall: delete #${params.id}`);
				return {
					ok: true,
					id: params.id,
					commit: sha,
					message:
						res.changes > 0
							? `已删除踩坑记录 #${params.id}${sha ? ` (commit ${sha})` : ""}`
							: `未找到踩坑记录 #${params.id}`,
				};
			}

			if (params.op === "update") {
				if (!params.id) return { ok: false, message: "update 操作需要提供 id。" };
				const existing = db.query("SELECT * FROM pitfalls WHERE id = ?").get(params.id) as PitfallRow | null;
				if (!existing) return { ok: false, message: `未找到踩坑记录 #${params.id}` };
				db.query(
					`UPDATE pitfalls
					 SET project = ?, tags = ?, symptom = ?, root_cause = ?, historical_fix = ?, rethink_hint = ?, evidence = ?, updated_at = ?
					 WHERE id = ?`,
				).run(
					params.project?.trim().toLowerCase() || existing.project,
					params.tags?.trim() ?? existing.tags,
					params.symptom?.trim() || existing.symptom,
					params.rootCause?.trim() || existing.root_cause,
					params.historicalFix?.trim() || existing.historical_fix,
					params.rethinkHint?.trim() || existing.rethink_hint,
					params.evidence?.trim() ?? existing.evidence ?? "",
					now,
					params.id,
				);
				exportPitfallsJsonl(db, paths.jsonlPath, readOnlyGuard);
				const sha = commitMemoryGit(paths.home, `pitfall: update #${params.id}`);
				return {
					ok: true,
					id: params.id,
					commit: sha,
					message: `已更新踩坑记录 #${params.id}${sha ? ` (commit ${sha})` : ""}`,
				};
			}

			if (!params.symptom?.trim() || !params.rootCause?.trim() || !params.historicalFix?.trim() || !params.rethinkHint?.trim()) {
				return {
					ok: false,
					message:
						"新增或演进踩坑记录必须完整填写四个核心字段：symptom（现象）、rootCause（客观根因）、historicalFix（当时解法）、rethinkHint（未来重思提示）；可选填写 evidence（源码/commit/会话溯源锚点）。",
				};
			}
			if (params.op === "supersede" && !params.id) {
				return { ok: false, message: "supersede 操作必须指定被替换的旧记录 id。" };
			}

			const ins = db
				.query(
					`INSERT INTO pitfalls (project, tags, symptom, root_cause, historical_fix, rethink_hint, evidence, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
				)
				.run(
					proj,
					params.tags?.trim() ?? "",
					params.symptom.trim(),
					params.rootCause.trim(),
					params.historicalFix.trim(),
					params.rethinkHint.trim(),
					params.evidence?.trim() ?? "",
					now,
					now,
				);
			const newId = Number(ins.lastInsertRowid);

			if (params.op === "supersede" && params.id) {
				db.query("UPDATE pitfalls SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(
					newId,
					now,
					params.id,
				);
			}

			exportPitfallsJsonl(db, paths.jsonlPath, readOnlyGuard);
			const sha = commitMemoryGit(
				paths.home,
				params.op === "supersede" ? `pitfall: #${newId} supersedes #${params.id}` : `pitfall: add #${newId} (${proj})`,
			);
			return {
				ok: true,
				id: newId,
				superseded: params.id ?? null,
				commit: sha,
				message:
					params.op === "supersede"
						? `已创建新踩坑记录 #${newId} 并将旧记录 #${params.id} 标记为 superseded${sha ? ` (commit ${sha})` : ""}。`
						: `已记录新踩坑 #${newId} [scope=${proj}]${sha ? ` (commit ${sha})` : ""}。`,
			};
		} finally {
			db.close();
		}
	});
}
