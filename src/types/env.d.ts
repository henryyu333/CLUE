declare module "bun:sqlite" {
	export interface Statement<ReturnType = unknown, ParamsType extends unknown[] = unknown[]> {
		all(...params: ParamsType): ReturnType[];
		get(...params: ParamsType): ReturnType | null;
		run(...params: ParamsType): { changes: number; lastInsertRowid: number | bigint };
	}

	export class Database {
		constructor(filename?: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });
		exec(sql: string): this;
		query<ReturnType = unknown, ParamsType extends unknown[] = unknown[]>(sql: string): Statement<ReturnType, ParamsType>;
		transaction<T extends (...args: any[]) => any>(fn: T): T;
		close(throwOnError?: boolean): void;
	}
}

declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function beforeEach(fn: () => void | Promise<void>): void;
	export function afterEach(fn: () => void | Promise<void>): void;
	export interface Matchers<T> {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toBeTruthy(): void;
		toBeFalsy(): void;
		toBeNull(): void;
		toBeUndefined(): void;
		toHaveLength(expected: number): void;
		toContain(expected: unknown): void;
		toBeGreaterThan(expected: number): void;
		toBeGreaterThanOrEqual(expected: number): void;
		toBeLessThan(expected: number): void;
		toBeLessThanOrEqual(expected: number): void;
		not: Matchers<T>;
	}
	export function expect<T>(actual: T): Matchers<T>;
}

declare namespace Bun {
	function zstdCompressSync(data: Uint8Array): Uint8Array;
	function zstdDecompressSync(data: Uint8Array): Uint8Array;
}

interface ImportMeta {
	path: string;
}

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	pid: number;
	platform: string;
	cwd(): string;
	exit(code?: number): never;
	stdin: AsyncIterable<Uint8Array | string> & { isTTY?: boolean };
};

declare class Buffer extends Uint8Array {
	static from(data: string | Uint8Array | ArrayBuffer, encoding?: string): Buffer;
	static concat(list: readonly Uint8Array[]): Buffer;
	static isBuffer(obj: unknown): obj is Buffer;
	toString(encoding?: string): string;
}

declare namespace NodeJS {
	interface ErrnoException extends Error {
		code?: string;
	}
}

declare module "node:child_process" {
	export function execFileSync(
		file: string,
		args?: readonly string[],
		options?: { encoding?: "utf8"; stdio?: unknown; cwd?: string; input?: string; timeout?: number; env?: Record<string, string | undefined> },
	): string;
}

declare module "node:crypto" {
	export function createHash(algorithm: string): {
		update(data: string | Uint8Array): { digest(encoding: "hex"): string };
	};
}

declare module "node:fs" {
	export interface Stats {
		isFile(): boolean;
		isDirectory(): boolean;
		mtimeMs: number;
		size: number;
		mode: number;
	}
	export interface Dirent {
		name: string;
		isFile(): boolean;
		isDirectory(): boolean;
	}
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function readFileSync(path: string): Buffer;
	export function writeFileSync(path: string, data: string | Uint8Array, encoding?: "utf8"): void;
	export function copyFileSync(src: string, dest: string): void;
	export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
	export function mkdtempSync(prefix: string): string;
	export function renameSync(oldPath: string, newPath: string): void;
	export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
	export function statSync(path: string): Stats;
	export function lstatSync(path: string): Stats & { isSymbolicLink(): boolean };
	export function chmodSync(path: string, mode: number): void;
	export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
	export function readdirSync(path: string): string[];
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:path" {
	export const sep: string;
	export function basename(p: string, ext?: string): string;
	export function dirname(p: string): string;
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
	export function isAbsolute(p: string): boolean;
}
