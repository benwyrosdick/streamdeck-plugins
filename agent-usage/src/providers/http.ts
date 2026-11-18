import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { ProviderError } from "./types";

/** `fetch`, swappable in tests. */
export type Fetch = typeof fetch;

const TIMEOUT_MS = 15_000;

/**
 * GET/POST and parse JSON, mapping HTTP failures onto provider errors:
 * 401 → `expired`, 429 → `rateLimited`, anything else → `failed`.
 */
export async function requestJson<T>(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (error) {
		throw new ProviderError("failed", `Request failed: ${(error as Error).message}`);
	}
	if (response.status === 401) {
		throw new ProviderError("expired", "The login was rejected (HTTP 401)");
	}
	if (response.status === 429) {
		throw new ProviderError("rateLimited", "Rate limited (HTTP 429)", retryAt(response.headers.get("retry-after")));
	}
	if (!response.ok) {
		throw new ProviderError("failed", `HTTP ${response.status}`);
	}
	try {
		return (await response.json()) as T;
	} catch {
		throw new ProviderError("failed", "Unexpected response");
	}
}

/** A Retry-After header (seconds, or an HTTP date) as epoch ms; `undefined` when absent or unparseable. */
export function retryAt(header: string | null, now = Date.now()): number | undefined {
	if (!header) {
		return undefined;
	}
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return now + seconds * 1000;
	}
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : date;
}

/** Reads and parses a JSON file, or `undefined` if it's missing or malformed. */
export async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export type RunResult = { ok: boolean; stdout: string };
export type Runner = (file: string, args: string[]) => Promise<RunResult>;

/** Runs a command without a shell, never rejecting. */
export const run: Runner = (file, args) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
	});

/** Epoch ms from an ISO date or epoch seconds; `undefined` when absent or unparseable. */
export function toEpochMs(value: string | number | null | undefined): number | undefined {
	if (typeof value === "number") {
		return value > 0 ? value * 1000 : undefined;
	}
	if (!value) {
		return undefined;
	}
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

/** Clamp a percentage into 0–100. */
export const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** A short name for a window from its length: 5h, Week, Month, 30d. */
export function windowLabel(seconds: number | undefined, fallback: string): string {
	if (!seconds) return fallback;
	if (seconds === 604_800) return "Week";
	// Calendar months run 28–31 days.
	if (seconds >= 28 * 86_400 && seconds <= 31 * 86_400 && seconds % 86_400 === 0) return "Month";
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	return fallback;
}
