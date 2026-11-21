import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import type { CluePaths } from "./config.ts";
import { commitMemoryGit } from "./git.ts";
import { normalizeLedgerRow, readLedger, writeLedger, type LedgerKind } from "./ledger.ts";
import { withMemoryLock } from "./lock.ts";
import { mergeLegacyHits, type HitStat } from "./stats.ts";

/**
 * One-time migration from the v0.5 layout, where `pitfalls.db` (SQLite) was committed to git and
 * lagged one write behind. The jsonl exports become the only source of truth, hit telemetry moves
 * to `stats.json`, and the database is untracked and deleted.
 */
export function migrateLegacyStore(paths: CluePaths, readOnly: boolean): void {
	withMemoryLock(paths.lockPath, () => {
		if (!existsSync(paths.legacyDbPath)) return;
		const legacyHits: Record<string, HitStat> = {};
		const legacyRows: Partial<Record<LedgerKind, Record<string, unknown>[]>> = {};
		const db = new Database(paths.legacyDbPath, { readonly: true });
		try {
			for (const [kind, table] of [
				["pitfall", "pitfalls"],
				["decision", "decisions"],
			] as const) {
				const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
				if (!exists) continue;
				const rows = db.query(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
				legacyRows[kind] = rows;
				for (const r of rows) {
					const count = Number(r.hit_count ?? 0);
					if (count > 0) legacyHits[`${kind}:${r.id}`] = { count, lastAt: String(r.last_hit_at ?? "") };
				}
			}
		} finally {
			db.close();
		}

		mergeLegacyHits(paths, legacyHits);

		for (const kind of ["pitfall", "decision"] as const) {
			// The jsonl export is what git history (and any past `clue undo`) reflects, so it wins.
			// Only fall back to database rows if the export never existed.
			const fromJsonl = readLedger(paths, kind);
			const source = fromJsonl.length > 0 ? fromJsonl : (legacyRows[kind] ?? []).map(r => normalizeLedgerRow(kind, r));
			if (source.length > 0) writeLedger(paths, kind, source, readOnly);
		}

		try {
			execFileSync("git", ["-C", paths.home, "rm", "--cached", "--quiet", "pitfalls.db"], { stdio: "ignore" });
		} catch {
			// not tracked (fresh public installs)
		}
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${paths.legacyDbPath}${suffix}`, { force: true });
		commitMemoryGit(paths.home, "chore: migrate ledgers to jsonl source of truth (v0.6)");
	});
}
