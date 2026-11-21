import { existsSync, readFileSync } from "node:fs";
import type { CluePaths } from "./config.ts";
import { atomicWriteFileSync } from "./lock.ts";

/**
 * Local telemetry kept OUT of git (`stats.json`): explicit lookup hits per ledger row and
 * the last time each harness actually invoked clue. Losing this file only loses telemetry.
 */
export interface HitStat {
	count: number;
	lastAt: string;
}

interface StatsFile {
	hits: Record<string, HitStat>;
	harnessSeen: Record<string, string>;
}

function readStats(paths: CluePaths): StatsFile {
	if (!existsSync(paths.statsPath)) return { hits: {}, harnessSeen: {} };
	try {
		const raw = JSON.parse(readFileSync(paths.statsPath, "utf8")) as Partial<StatsFile>;
		return { hits: raw.hits ?? {}, harnessSeen: raw.harnessSeen ?? {} };
	} catch {
		return { hits: {}, harnessSeen: {} };
	}
}

function updateStats(paths: CluePaths, mutate: (s: StatsFile) => void): void {
	try {
		const s = readStats(paths);
		mutate(s);
		atomicWriteFileSync(paths.statsPath, `${JSON.stringify(s)}\n`);
	} catch {
		// Telemetry must never break a read path.
	}
}

export function readHitStats(paths: CluePaths): Record<string, HitStat> {
	return readStats(paths).hits;
}

/** Record explicit lookups (search results actually shown to a model). Keys look like `pitfall:3`. */
export function recordHits(paths: CluePaths, keys: readonly string[], at = new Date().toISOString()): void {
	if (keys.length === 0) return;
	updateStats(paths, s => {
		for (const k of keys) {
			const prev = s.hits[k];
			s.hits[k] = { count: (prev?.count ?? 0) + 1, lastAt: at };
		}
	});
}

export function mergeLegacyHits(paths: CluePaths, legacy: Record<string, HitStat>): void {
	updateStats(paths, s => {
		for (const [k, v] of Object.entries(legacy)) {
			if (!v.count) continue;
			const prev = s.hits[k];
			s.hits[k] = {
				count: (prev?.count ?? 0) + v.count,
				lastAt: [prev?.lastAt ?? "", v.lastAt].sort().pop() ?? "",
			};
		}
	});
}

export function noteHarnessSeen(paths: CluePaths, harness: string, at = new Date().toISOString()): void {
	if (!harness) return;
	const prev = readStats(paths).harnessSeen[harness];
	// Throttle writes: one update per 10 minutes is plenty for liveness checks.
	if (prev && Date.parse(at) - Date.parse(prev) < 10 * 60 * 1000) return;
	updateStats(paths, s => {
		s.harnessSeen[harness] = at;
	});
}

export function readHarnessSeen(paths: CluePaths): Record<string, string> {
	return readStats(paths).harnessSeen;
}
