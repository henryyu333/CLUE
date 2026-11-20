import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { CluePaths } from "./config.ts";
import { commitMemoryGit } from "./git.ts";
import { atomicWriteFileSync, withMemoryLock } from "./lock.ts";
import { scanMemoryContent } from "./security.ts";

export interface DecisionRow {
	id: number;
	project: string;
	topic: string;
	decision: string;
	rationale: string;
	assumptions: string;
	revisit_when: string;
	evidence: string;
	status: string;
	superseded_by: number | null;
	hit_count: number;
	last_hit_at: string;
	verified_at: string;
	created_at: string;
	updated_at: string;
}

export interface DecisionMutationRequest {
	op: "add" | "update" | "supersede" | "revert" | "delete";
	id?: number;
	project?: string;
	topic?: string;
	decision?: string;
	rationale?: string;
	assumptions?: string;
	revisitWhen?: string;
	evidence?: string;
}

export interface DecisionMutationResult {
	ok: boolean;
	message: string;
	id?: number;
	superseded?: number | null;
	commit?: string | null;
}

export function openDecisionDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS decisions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project TEXT NOT NULL DEFAULT 'global',
			topic TEXT NOT NULL DEFAULT '',
			decision TEXT NOT NULL,
			rationale TEXT NOT NULL,
			assumptions TEXT NOT NULL DEFAULT '',
			revisit_when TEXT NOT NULL DEFAULT '',
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

	const ftsExists = Boolean(
		db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decisions_fts'").get(),
	);
	if (!ftsExists) {
		db.exec(`
			CREATE VIRTUAL TABLE decisions_fts USING fts5(
				project, topic, decision, rationale, assumptions, revisit_when, evidence,
				content='decisions', content_rowid='id',
				tokenize='trigram'
			);
			CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
				INSERT INTO decisions_fts(rowid, project, topic, decision, rationale, assumptions, revisit_when, evidence)
				VALUES (new.id, new.project, new.topic, new.decision, new.rationale, new.assumptions, new.revisit_when, new.evidence);
			END;
			CREATE TRIGGER decisions_ad AFTER DELETE ON decisions BEGIN
				INSERT INTO decisions_fts(decisions_fts, rowid, project, topic, decision, rationale, assumptions, revisit_when, evidence)
				VALUES ('delete', old.id, old.project, old.topic, old.decision, old.rationale, old.assumptions, old.revisit_when, old.evidence);
			END;
			CREATE TRIGGER decisions_au AFTER UPDATE ON decisions BEGIN
				INSERT INTO decisions_fts(decisions_fts, rowid, project, topic, decision, rationale, assumptions, revisit_when, evidence)
				VALUES ('delete', old.id, old.project, old.topic, old.decision, old.rationale, old.assumptions, old.revisit_when, old.evidence);
				INSERT INTO decisions_fts(rowid, project, topic, decision, rationale, assumptions, revisit_when, evidence)
				VALUES (new.id, new.project, new.topic, new.decision, new.rationale, new.assumptions, new.revisit_when, new.evidence);
			END;
			INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');
		`);
	}

	return db;
}

export function exportDecisionsJsonl(db: Database, jsonlPath: string, readOnly = true): void {
	const rows = db.query("SELECT * FROM decisions ORDER BY id ASC").all() as DecisionRow[];
	const content = rows.length > 0 ? `${rows.map(r => JSON.stringify(r)).join("\n")}\n` : "";
	atomicWriteFileSync(jsonlPath, content, { readOnly });
}

export function listActiveDecisions(dbPath: string, projectKey?: string | null): DecisionRow[] {
	if (!existsSync(dbPath)) return [];
	const db = openDecisionDb(dbPath);
	try {
		if (projectKey) {
			return db
				.query(
					`SELECT * FROM decisions
					 WHERE status = 'active' AND (project = ? OR project = 'global')
					 ORDER BY (CASE WHEN project = ? THEN 0 ELSE 1 END), hit_count DESC, updated_at DESC`,
				)
				.all(projectKey.toLowerCase(), projectKey.toLowerCase()) as DecisionRow[];
		}
		return db.query("SELECT * FROM decisions WHERE status = 'active' ORDER BY updated_at DESC").all() as DecisionRow[];
	} finally {
		db.close();
	}
}

export function recordDecisionHit(dbPath: string, ids: number[]): void {
	if (ids.length === 0 || !existsSync(dbPath)) return;
	const db = openDecisionDb(dbPath);
	try {
		const now = new Date().toISOString();
		const stmt = db.query("UPDATE decisions SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?");
		for (const id of ids) stmt.run(now, id);
	} catch {
		// Never fail read path due to telemetry update
	} finally {
		db.close();
	}
}

export function searchDecisions(
	dbPath: string,
	query: string,
	projectKey: string | null,
	limit = 4,
	includeInactive = false,
): DecisionRow[] {
	if (!existsSync(dbPath)) return [];
	const db = openDecisionDb(dbPath);
	try {
		const statusClause = includeInactive ? "1=1" : "d.status = 'active'";
		const rawTokens: string[] = [];
		const seen = new Set<string>();
		const addToken = (tok: string) => {
			const clean = tok.trim().toLowerCase();
			if ([...clean].length < 2 || seen.has(clean)) return;
			seen.add(clean);
			rawTokens.push(clean);
		};
		for (const m of query.matchAll(/[a-zA-Z0-9_.-]{2,}/g)) addToken(m[0]);
		const cjkStop = /(?:今天|一下|帮我|看看|怎么|为什么|关于|时候|这个|那个|决定|方案)/g;
		for (const m of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
			const cleaned = m[0].replace(cjkStop, " ").trim();
			for (const part of cleaned.split(/\s+/).filter(Boolean)) {
				const chars = [...part];
				if (chars.length <= 4) addToken(part);
				else {
					for (let i = 0; i <= chars.length - 2 && rawTokens.length < 12; i++) {
						addToken(chars.slice(i, i + 2).join(""));
					}
				}
			}
		}
		rawTokens.splice(10);

		if (rawTokens.length === 0) {
			const sql = projectKey
				? `SELECT * FROM decisions d WHERE ${statusClause} AND (d.project = ? OR d.project = 'global') ORDER BY d.project = ? DESC, d.updated_at DESC LIMIT ?`
				: `SELECT * FROM decisions d WHERE ${statusClause} ORDER BY d.updated_at DESC LIMIT ?`;
			return (
				projectKey ? db.query(sql).all(projectKey, projectKey, limit) : db.query(sql).all(limit)
			) as DecisionRow[];
		}

		const ftsTokens = rawTokens.filter(t => [...t].length >= 3);
		const results = new Map<number, DecisionRow>();

		if (ftsTokens.length > 0) {
			const ftsExpr = ftsTokens.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
			try {
				const ftsRows = db
					.query(
						`SELECT d.* FROM decisions_fts f
						 JOIN decisions d ON d.id = f.rowid
						 WHERE decisions_fts MATCH ? AND ${statusClause}
						 ORDER BY (CASE WHEN d.project = ? THEN 0 WHEN d.project = 'global' THEN 1 ELSE 2 END), bm25(decisions_fts)
						 LIMIT ?`,
					)
					.all(ftsExpr, projectKey ?? "", limit) as DecisionRow[];
				for (const r of ftsRows) results.set(r.id, r);
			} catch {
				// fall back to LIKE
			}
		}

		if (results.size < limit) {
			const likeClauses = rawTokens
				.map(() => "(d.topic LIKE ? OR d.decision LIKE ? OR d.rationale LIKE ? OR d.assumptions LIKE ? OR d.revisit_when LIKE ?)")
				.join(" OR ");
			const params: (string | number)[] = [];
			for (const tok of rawTokens) {
				const pat = `%${tok}%`;
				params.push(pat, pat, pat, pat, pat);
			}
			params.push(projectKey ?? "", limit);
			const likeRows = db
				.query(
					`SELECT d.* FROM decisions d
					 WHERE (${likeClauses}) AND ${statusClause}
					 ORDER BY (CASE WHEN d.project = ? THEN 0 WHEN d.project = 'global' THEN 1 ELSE 2 END), d.updated_at DESC
					 LIMIT ?`,
				)
				.all(...params) as DecisionRow[];
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

export function formatDecisionGuidance(rows: DecisionRow[]): string {
	if (rows.length === 0) return "未检索到匹配的历史关键决定。";
	const header = [
		"【历史关键决定（防反复横跳 & 防盲从）】",
		"- `decision` + `rationale` 说明此前为什么这样选、排除了什么；",
		"- 若当前情况已触发 `revisit_when`（推翻条件）或 `assumptions` 不再成立，请主动提议用 `clue decision` (`op=\"supersede\"`) 更新。",
		"",
	].join("\n");
	const items = rows.map(r => {
		const lines = [
			`[Decision #${r.id} | scope=${r.project} | status=${r.status}${r.topic ? ` | topic=${r.topic}` : ""}]`,
			`  决定: ${r.decision}`,
			`  原因: ${r.rationale}`,
		];
		if (r.assumptions?.trim()) lines.push(`  前提: ${r.assumptions.trim()}`);
		if (r.revisit_when?.trim()) lines.push(`  推翻条件: ${r.revisit_when.trim()}`);
		if (r.evidence?.trim()) lines.push(`  溯源: ${r.evidence.trim()}`);
		return lines.join("\n");
	});
	return `${header}${items.join("\n\n")}`;
}

export function mutateDecision(
	paths: CluePaths,
	params: DecisionMutationRequest,
	defaultProject: string | null,
	readOnlyGuard = true,
): DecisionMutationResult {
	for (const field of [params.topic, params.decision, params.rationale, params.assumptions, params.revisitWhen, params.evidence]) {
		if (!field) continue;
		const sec = scanMemoryContent(field);
		if (!sec.ok) return { ok: false, message: `安全安检拦截（${sec.rule}）：${sec.reason}` };
	}

	return withMemoryLock(paths.lockPath, () => {
		const db = openDecisionDb(paths.dbPath);
		try {
			const now = new Date().toISOString();
			const proj = (params.project?.trim().toLowerCase() || defaultProject || "global").replace(/^project:\s*/, "");

			if (params.op === "delete") {
				if (!params.id) return { ok: false, message: "delete 操作需要提供 id。" };
				const res = db.query("DELETE FROM decisions WHERE id = ?").run(params.id);
				exportDecisionsJsonl(db, paths.decisionsJsonlPath, readOnlyGuard);
				const sha = commitMemoryGit(paths.home, `decision: delete #${params.id}`);
				return {
					ok: true,
					id: params.id,
					commit: sha,
					message: res.changes > 0 ? `已删除关键决定 #${params.id}${sha ? ` (commit ${sha})` : ""}` : `未找到决定 #${params.id}`,
				};
			}

			if (params.op === "revert") {
				if (!params.id) return { ok: false, message: "revert 操作需要提供 id。" };
				const existing = db.query("SELECT * FROM decisions WHERE id = ?").get(params.id) as DecisionRow | null;
				if (!existing) return { ok: false, message: `未找到关键决定 #${params.id}` };
				db.query("UPDATE decisions SET status = 'reverted', updated_at = ? WHERE id = ?").run(now, params.id);
				exportDecisionsJsonl(db, paths.decisionsJsonlPath, readOnlyGuard);
				const sha = commitMemoryGit(paths.home, `decision: revert #${params.id}`);
				return {
					ok: true,
					id: params.id,
					commit: sha,
					message: `已将关键决定 #${params.id} 标记为 reverted${sha ? ` (commit ${sha})` : ""}。`,
				};
			}

			if (params.op === "update") {
				if (!params.id) return { ok: false, message: "update 操作需要提供 id。" };
				const existing = db.query("SELECT * FROM decisions WHERE id = ?").get(params.id) as DecisionRow | null;
				if (!existing) return { ok: false, message: `未找到关键决定 #${params.id}` };
				db.query(
					`UPDATE decisions
					 SET project = ?, topic = ?, decision = ?, rationale = ?, assumptions = ?, revisit_when = ?, evidence = ?, updated_at = ?
					 WHERE id = ?`,
				).run(
					params.project?.trim().toLowerCase() || existing.project,
					params.topic?.trim() ?? existing.topic,
					params.decision?.trim() || existing.decision,
					params.rationale?.trim() || existing.rationale,
					params.assumptions?.trim() ?? existing.assumptions,
					params.revisitWhen?.trim() ?? existing.revisit_when,
					params.evidence?.trim() ?? existing.evidence,
					now,
					params.id,
				);
				exportDecisionsJsonl(db, paths.decisionsJsonlPath, readOnlyGuard);
				const sha = commitMemoryGit(paths.home, `decision: update #${params.id}`);
				return {
					ok: true,
					id: params.id,
					commit: sha,
					message: `已更新关键决定 #${params.id}${sha ? ` (commit ${sha})` : ""}`,
				};
			}

			if (!params.decision?.trim() || !params.rationale?.trim()) {
				return {
					ok: false,
					message:
						"新增或演进关键决定必须至少填写 decision（结论）和 rationale（当时原因）；强烈建议填写 topic、assumptions（前提）、revisitWhen（推翻条件）和 evidence（溯源）。",
				};
			}
			if (params.op === "supersede" && !params.id) {
				return { ok: false, message: "supersede 操作必须指定被替代的旧决定 id。" };
			}

			const ins = db
				.query(
					`INSERT INTO decisions (project, topic, decision, rationale, assumptions, revisit_when, evidence, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
				)
				.run(
					proj,
					params.topic?.trim() ?? "",
					params.decision.trim(),
					params.rationale.trim(),
					params.assumptions?.trim() ?? "",
					params.revisitWhen?.trim() ?? "",
					params.evidence?.trim() ?? "",
					now,
					now,
				);
			const newId = Number(ins.lastInsertRowid);

			if (params.op === "supersede" && params.id) {
				db.query("UPDATE decisions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(
					newId,
					now,
					params.id,
				);
			}

			exportDecisionsJsonl(db, paths.decisionsJsonlPath, readOnlyGuard);
			const sha = commitMemoryGit(
				paths.home,
				params.op === "supersede" ? `decision: #${newId} supersedes #${params.id}` : `decision: add #${newId} (${proj})`,
			);
			return {
				ok: true,
				id: newId,
				superseded: params.id ?? null,
				commit: sha,
				message:
					params.op === "supersede"
						? `已创建新关键决定 #${newId} 并替代旧决定 #${params.id}${sha ? ` (commit ${sha})` : ""}。`
						: `已记录关键决定 #${newId} [scope=${proj}]：${params.decision.trim()}${sha ? ` (commit ${sha})` : ""}`,
			};
		} finally {
			db.close();
		}
	});
}
