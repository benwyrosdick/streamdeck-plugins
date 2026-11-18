import os from "node:os";
import path from "node:path";

import { clampPercent, type Fetch, readJson, requestJson, toEpochMs } from "./http";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "./types";

export type CodexDeps = {
	env?: NodeJS.ProcessEnv;
	fetch?: Fetch;
};

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`). */
type CodexAuth = {
	auth_mode?: string;
	tokens?: { access_token?: string; account_id?: string } | null;
};

type WindowJson = { used_percent?: number; reset_at?: number; limit_window_seconds?: number } | null;

/** The fields of `GET /backend-api/wham/usage` the plugin reads. */
export type CodexUsageJson = {
	plan_type?: string;
	rate_limit?: { primary_window?: WindowJson; secondary_window?: WindowJson } | null;
};

/** A short name for a window from its length: 5h, Week, 30d. */
export function windowLabel(seconds: number | undefined, fallback: string): string {
	if (!seconds) return fallback;
	if (seconds === 604_800) return "Week";
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	return fallback;
}

export function parseCodexUsage(json: CodexUsageJson): UsageWindow[] {
	const window = (id: string, fallback: string, data: WindowJson | undefined): UsageWindow[] =>
		typeof data?.used_percent === "number"
			? [
					{
						id,
						label: windowLabel(data.limit_window_seconds, fallback),
						usedPercent: clampPercent(data.used_percent),
						resetsAt: toEpochMs(data.reset_at),
					},
				]
			: [];
	return [...window("session", "5h", json.rate_limit?.primary_window), ...window("weekly", "Week", json.rate_limit?.secondary_window)];
}

/**
 * Codex plan usage from the ChatGPT backend Codex itself queries, using the
 * ChatGPT login in Codex's `auth.json`. The file is only read; Codex refreshes
 * its tokens as it runs.
 */
export class CodexProvider implements UsageProvider {
	readonly id = "codex";
	readonly #env: NodeJS.ProcessEnv;
	readonly #fetch: Fetch;

	constructor(deps: CodexDeps = {}) {
		this.#env = deps.env ?? process.env;
		this.#fetch = deps.fetch ?? fetch;
	}

	async fetchUsage(): Promise<UsageSnapshot> {
		const home = this.#env.CODEX_HOME || path.join(this.#env.HOME || this.#env.USERPROFILE || os.homedir(), ".codex");
		const auth = await readJson<CodexAuth>(path.join(home, "auth.json"));
		const token = auth?.tokens?.access_token;
		if (!token) {
			// An API-key login (`auth_mode: "apikey"`) has no ChatGPT plan to report.
			throw auth?.auth_mode && auth.auth_mode !== "chatgpt"
				? new ProviderError("unsupported", "Codex is signed in with an API key, which has no plan usage")
				: new ProviderError("signedOut", "Codex isn't signed in");
		}
		const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": "codex-cli" };
		if (auth.tokens?.account_id) {
			headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
		}
		const json = await requestJson<CodexUsageJson>(this.#fetch, USAGE_URL, { headers });
		return { windows: parseCodexUsage(json), plan: json.plan_type };
	}
}
