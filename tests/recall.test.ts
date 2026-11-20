import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getRecentProjectSessionAnchors,
	indexRecallSessions,
	recallSessions,
	redactSecrets,
	showSessionWindow,
} from "../src/recall/index.ts";

let fakeHome: string;
let recallDb: string;

beforeEach(() => {
	fakeHome = mkdtempSync(join(tmpdir(), "clue-recall-test-"));
	recallDb = join(fakeHome, "recall.db");
});

afterEach(() => {
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("cross-harness recall & redaction", () => {
	test("redacts secrets before indexing", () => {
		const cleaned = redactSecrets("use key sk-proj-1234567890abcdefghijklmnop and ghp_1234567890abcdefghijklmnopqrstuvwxyz");
		expect(cleaned).not.toContain("sk-proj-");
		expect(cleaned).not.toContain("ghp_");
		expect(cleaned).toContain("[REDACTED]");
	});

	test("indexes AGY, Claude, and zstd-compressed Codex transcripts incrementally and supports --around show", () => {
		// 1) AGY transcript
		const agyDir = join(fakeHome, ".gemini", "antigravity", "brain", "conv-agy-1", ".system_generated", "logs");
		mkdirSync(agyDir, { recursive: true });
		writeFileSync(
			join(agyDir, "transcript.jsonl"),
			[
				JSON.stringify({
					step_index: 0,
					source: "USER_EXPLICIT",
					type: "USER_INPUT",
					created_at: "2026-11-18T10:00:00Z",
					content: "<USER_REQUEST>\n我们讨论一下 Acme Billing webhook 签名验证方案\n</USER_REQUEST>",
				}),
				JSON.stringify({
					step_index: 1,
					source: "MODEL",
					type: "PLANNER_RESPONSE",
					created_at: "2026-11-18T10:00:05Z",
					content: "Acme Billing webhook 需要验签，秘钥 sk-proj-1234567890abcdefghijklmnop 绝不能明文保存。",
				}),
			].join("\n"),
			"utf8",
		);

		// 2) Codex zstd-compressed session
		const codexDir = join(fakeHome, ".codex", "sessions", "2026", "11", "18");
		mkdirSync(codexDir, { recursive: true });
		const codexJsonl = [
			JSON.stringify({
				timestamp: "2026-11-18T11:00:00Z",
				type: "session_meta",
				payload: { session_id: "codex-demo-99", cwd: "/Users/alice/workspace/acme-fix" },
			}),
			JSON.stringify({
				timestamp: "2026-11-18T11:00:01Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "如何修复弹窗隐藏后 focus trap 仍然拦截点击的问题" }],
				},
			}),
			JSON.stringify({
				timestamp: "2026-11-18T11:00:08Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "给隐藏容器移除子树指针事件即可阻断命中测试。" }],
				},
			}),
		].join("\n");
		writeFileSync(join(codexDir, "rollout-demo.jsonl.zst"), Bun.zstdCompressSync(Buffer.from(codexJsonl)));

		// First index run
		const s1 = indexRecallSessions(recallDb, { homeDir: fakeHome });
		expect(s1.indexedSessions).toBe(2);
		expect(s1.byHarness.agy?.sessions).toBe(1);
		expect(s1.byHarness.codex?.sessions).toBe(1);

		// Second index run should skip unchanged files completely
		const s2 = indexRecallSessions(recallDb, { homeDir: fakeHome });
		expect(s2.indexedSessions).toBe(0);
		expect(s2.skippedUnchanged).toBe(2);

		// Recall AGY session & verify secret was redacted
		const billingHits = recallSessions(recallDb, { query: "Acme Billing" });
		expect(billingHits.length).toBe(1);
		expect(billingHits[0]!.harness).toBe("agy");

		const window = showSessionWindow(recallDb, { idPrefix: "agy:conv-agy-1", around: 1, window: 2 });
		expect(window.ok).toBe(true);
		expect(window.message).toContain("[REDACTED]");
		expect(window.message).not.toContain("sk-proj-");

		// Recall Codex zstd session & verify worktree normalization (acme-fix -> acme)
		const codexHits = recallSessions(recallDb, { query: "focus trap" });
		expect(codexHits.length).toBe(1);
		expect(codexHits[0]!.harness).toBe("codex");
		expect(codexHits[0]!.project).toBe("acme");

		// Empty query with --role assistant should return assistant messages cleanly
		const assistantOnly = recallSessions(recallDb, { query: "", role: "assistant" });
		expect(assistantOnly.length).toBe(2);
		expect(assistantOnly[0]!.role).toBe("assistant");

		// Recent project anchors include firstUserMsg and lastUserMsg
		const anchors = getRecentProjectSessionAnchors(recallDb, "acme", { limit: 2 });
		expect(anchors.length).toBe(1);
		expect(anchors[0]!.firstUserMsg).toContain("focus trap");
	});

	test("filters noise sessions unless includeNoise is true and incrementally syncs OpenCode SQLite", () => {
		const ocDir = join(fakeHome, ".local", "share", "opencode");
		mkdirSync(ocDir, { recursive: true });
		const ocDbPath = join(ocDir, "opencode.db");
		const ocDb = new Database(ocDbPath);
		ocDb.exec(`
			CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT);
			CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
			CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
		`);
		const t1 = Date.parse("2026-11-18T10:00:00Z");
		const t2 = Date.parse("2026-11-18T11:00:00Z");
		ocDb.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run("s1", "/Users/alice/workspace/acme", "Main chat", t1, t1, null);
		ocDb.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run("s2", "/Users/alice/workspace/acme", "Subagent", t2, t2, "s1");
		ocDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", "s1", t1, JSON.stringify({ role: "user" }));
		ocDb.query("INSERT INTO part VALUES (?, ?, ?, ?)").run("p1", "m1", t1, JSON.stringify({ type: "text", text: "alpha protocol handshake design" }));
		ocDb.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("m2", "s2", t2, JSON.stringify({ role: "user" }));
		ocDb.query("INSERT INTO part VALUES (?, ?, ?, ?)").run("p2", "m2", t2, JSON.stringify({ type: "text", text: "alpha protocol subagent noise" }));
		ocDb.close();

		const run1 = indexRecallSessions(recallDb, { homeDir: fakeHome, harness: "opencode" });
		expect(run1.indexedSessions).toBe(2);

		// Default recall hides noise subagent session
		const cleanHits = recallSessions(recallDb, { query: "alpha protocol" });
		expect(cleanHits.length).toBe(1);
		expect(cleanHits[0]!.sessionId).toBe("opencode:s1");

		// includeNoise: true returns both
		const allHits = recallSessions(recallDb, { query: "alpha protocol", includeNoise: true });
		expect(allHits.length).toBe(2);

		// Add a 3rd session in opencode.db; incremental sync should only index the 1 new session (skip s1 & s2)
		const ocDb2 = new Database(ocDbPath);
		const t3 = Date.parse("2026-11-19T12:00:00Z");
		ocDb2.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run("s3", "/Users/alice/workspace/acme", "Second chat", t3, t3, null);
		ocDb2.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("m3", "s3", t3, JSON.stringify({ role: "user" }));
		ocDb2.query("INSERT INTO part VALUES (?, ?, ?, ?)").run("p3", "m3", t3, JSON.stringify({ type: "text", text: "beta incremental check" }));
		ocDb2.close();

		const run2 = indexRecallSessions(recallDb, { homeDir: fakeHome, harness: "opencode" });
		expect(run2.indexedSessions).toBe(1);
		expect(run2.skippedUnchanged).toBe(2);
	});
});
