import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const SLEEP_STEP_MS = 25;

function sleepSync(ms: number): void {
	const buf = new SharedArrayBuffer(4);
	const view = new Int32Array(buf);
	Atomics.wait(view, 0, 0, ms);
}

/**
 * Lightweight cross-process exclusive lock using atomic mkdir.
 * Automatically reclaims stale locks left by crashed processes.
 */
export function withMemoryLock<T>(lockDir: string, fn: () => T): T {
	mkdirSync(dirname(lockDir), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let acquired = false;

	while (!acquired) {
		try {
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "owner"), `${process.pid}\n${Date.now()}\n`, "utf8");
			acquired = true;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST") throw err;
			try {
				const st = statSync(lockDir);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
					rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				// Lock disappeared between EEXIST and stat; retry immediately
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`无法获取记忆目录写入锁（${lockDir}），可能有另一个进程正在写入，请稍后重试。`);
			}
			sleepSync(SLEEP_STEP_MS);
		}
	}

	try {
		return fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

export function setFileReadOnly(filePath: string): void {
	if (!existsSync(filePath)) return;
	try {
		chmodSync(filePath, 0o444);
	} catch {
		// Ignore permission errors on filesystems that don't support POSIX modes
	}
}

export function setFileWritable(filePath: string): void {
	if (!existsSync(filePath)) return;
	try {
		chmodSync(filePath, 0o644);
	} catch {
		// Ignore permission errors on filesystems that don't support POSIX modes
	}
}

export function lockFilesReadOnly(files: readonly string[]): string[] {
	const locked: string[] = [];
	for (const f of files) {
		if (!existsSync(f)) continue;
		setFileReadOnly(f);
		locked.push(f);
	}
	return locked;
}

export function unlockFilesWritable(files: readonly string[]): string[] {
	const unlocked: string[] = [];
	for (const f of files) {
		if (!existsSync(f)) continue;
		setFileWritable(f);
		unlocked.push(f);
	}
	return unlocked;
}

/**
 * Atomic file write via temp file + rename in the same directory.
 * Optionally marks the destination file read-only (0444) to deter direct edits bypassing clue.
 */
export function atomicWriteFileSync(targetPath: string, content: string, opts?: { readOnly?: boolean }): void {
	mkdirSync(dirname(targetPath), { recursive: true });
	const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, content, "utf8");
	if (existsSync(targetPath)) {
		// Ensure replacement works cleanly on platforms where overwriting a read-only target fails
		setFileWritable(targetPath);
	}
	renameSync(tmpPath, targetPath);
	if (opts?.readOnly) {
		setFileReadOnly(targetPath);
	}
}
