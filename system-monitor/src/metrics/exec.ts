import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { Runner } from "./types";

/** Runs a command without a shell, never rejecting. */
export const run: Runner = (file, args, timeout) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), missing: code === "ENOENT" });
		});
	});

/** Reads a small text file, or `undefined` if it can't be read. */
export async function readText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Parses a number, treating blanks and placeholders like `[N/A]` as missing. */
export function toNumber(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return undefined;
	}
	return Number(trimmed);
}

export const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));
