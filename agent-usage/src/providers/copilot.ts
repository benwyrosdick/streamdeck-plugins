import { existsSync } from "node:fs";
import path from "node:path";

import { clampPercent, type Fetch, requestJson, type Runner, toEpochMs } from "./http";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "./types";

export type CopilotDeps = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	fetch?: Fetch;
	run: Runner;
	exists?: (file: string) => boolean;
};

export const USAGE_URL = "https://api.github.com/copilot_internal/user";

/** Where `gh` usually lives; Stream Deck launches plugins with a minimal PATH. */
export function ghPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	switch (platform) {
		case "darwin":
			return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh"];
		case "win32": {
			const programFiles = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"];
			const dirs = [...new Set(programFiles.filter((dir): dir is string => !!dir))].map((dir) => path.win32.join(dir, "GitHub CLI"));
			if (env.LOCALAPPDATA) {
				dirs.push(path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI"));
			}
			return dirs.map((dir) => path.win32.join(dir, "gh.exe"));
		}
		default:
			return ["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];
	}
}

type QuotaJson = {
	percent_remaining?: number;
	remaining?: number;
	unlimited?: boolean;
} | null;

/** The fields of `GET /copilot_internal/user` the plugin reads. */
export type CopilotUsageJson = {
	copilot_plan?: string;
	access_type_sku?: string;
	quota_reset_date_utc?: string;
	quota_reset_date?: string;
	quota_snapshots?: { premium_interactions?: QuotaJson; chat?: QuotaJson; completions?: QuotaJson } | null;
};

/** A monthly quota's length: from the same day a month before the reset, to the reset. */
export function monthBefore(resetsAt: number | undefined): number | undefined {
	if (resetsAt === undefined) return undefined;
	const start = new Date(resetsAt);
	start.setUTCMonth(start.getUTCMonth() - 1);
	return resetsAt - start.getTime();
}

export function parseCopilotUsage(json: CopilotUsageJson): UsageWindow[] {
	const resetsAt = toEpochMs(json.quota_reset_date_utc ?? json.quota_reset_date);
	const windowMs = monthBefore(resetsAt);
	const window = (id: string, label: string, data: QuotaJson | undefined): UsageWindow[] => {
		if (!data) return [];
		if (data.unlimited) return [{ id, label, usedPercent: undefined, resetsAt, windowMs }];
		if (typeof data.percent_remaining !== "number") return [];
		return [{ id, label, usedPercent: clampPercent(100 - data.percent_remaining), resetsAt, windowMs, remaining: data.remaining }];
	};
	const quotas = json.quota_snapshots;
	return [...window("premium", "Premium", quotas?.premium_interactions), ...window("chat", "Chat", quotas?.chat)];
}

/**
 * GitHub Copilot premium-request and chat quotas from the endpoint Copilot's
 * editor integrations use, authenticated with the GitHub CLI's login
 * (`GH_TOKEN` / `GITHUB_TOKEN` take precedence, as they do for `gh`).
 */
export class CopilotProvider implements UsageProvider {
	readonly id = "copilot";
	readonly #deps: Required<CopilotDeps>;
	#gh: string | undefined;

	constructor(deps: CopilotDeps) {
		this.#deps = { platform: process.platform, env: process.env, fetch, exists: existsSync, ...deps };
	}

	async fetchUsage(): Promise<UsageSnapshot> {
		const token = await this.#token();
		if (!token) {
			throw new ProviderError("signedOut", "No GitHub login; run `gh auth login`");
		}
		const json = await requestJson<CopilotUsageJson>(this.#deps.fetch, USAGE_URL, {
			headers: { Authorization: `token ${token}`, Accept: "application/json", "X-Github-Api-Version": "2025-04-01" },
		});
		if (json.access_type_sku === "subscription_ended" || !json.quota_snapshots) {
			throw new ProviderError("unsupported", "No active Copilot subscription");
		}
		return { windows: parseCopilotUsage(json), plan: json.copilot_plan };
	}

	async #token(): Promise<string | undefined> {
		const { env, platform, exists, run } = this.#deps;
		const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
		if (fromEnv) {
			return fromEnv;
		}
		this.#gh ??= ghPaths(platform, env).find((file) => exists(file)) ?? (platform === "win32" ? "gh.exe" : "gh");
		const result = await run(this.#gh, ["auth", "token"]);
		return result.ok ? result.stdout.trim() || undefined : undefined;
	}
}
