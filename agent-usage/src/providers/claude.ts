import os from "node:os";
import path from "node:path";

import { clampPercent, type Fetch, readJson, requestJson, type Runner, toEpochMs } from "./http";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "./types";

/** Claude Code's OAuth login, as it stores it under `claudeAiOauth`. */
export type ClaudeCredentials = {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms. */
	expiresAt?: number;
	scopes?: string[];
	subscriptionType?: string;
};

/**
 * Where the plugin keeps its own refreshed copy of the login (Stream Deck's
 * global settings), used only when "refresh the login" is turned on.
 */
export type CredentialVault = {
	refreshEnabled(): boolean;
	load(): ClaudeCredentials | undefined;
	save(credentials: ClaudeCredentials): Promise<void>;
};

export type ClaudeDeps = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	fetch?: Fetch;
	run: Runner;
	vault: CredentialVault;
	now?: () => number;
};

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Claude Code's public OAuth client id. */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** The usage endpoint needs this scope; `claude setup-token` tokens only have `user:inference`. */
const PROFILE_SCOPE = "user:profile";
/** Treat a token this close to expiry as expired. */
const EXPIRY_MARGIN_MS = 60_000;

type UsageWindowJson = { utilization?: number | null; resets_at?: string | null } | null;

/** The fields of `GET /api/oauth/usage` the plugin reads. */
export type ClaudeUsageJson = {
	five_hour?: UsageWindowJson;
	seven_day?: UsageWindowJson;
	seven_day_oauth_apps?: UsageWindowJson;
	seven_day_opus?: UsageWindowJson;
	seven_day_sonnet?: UsageWindowJson;
};

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Windows in display order; a window the plan doesn't have is left out. */
export function parseClaudeUsage(json: ClaudeUsageJson): UsageWindow[] {
	// The API doesn't say how long its windows are; they're fixed: 5 hours, and a week.
	const window = (id: string, label: string, windowMs: number, data: UsageWindowJson | undefined): UsageWindow[] =>
		typeof data?.utilization === "number"
			? [{ id, label, usedPercent: clampPercent(data.utilization), resetsAt: toEpochMs(data.resets_at), windowMs }]
			: [];
	return [
		...window("session", "5h", 5 * HOUR_MS, json.five_hour),
		...window("weekly", "Week", WEEK_MS, json.seven_day ?? json.seven_day_oauth_apps),
		...window("opus", "Opus", WEEK_MS, json.seven_day_opus),
		...window("sonnet", "Sonnet", WEEK_MS, json.seven_day_sonnet),
	];
}

/**
 * Claude Code plan usage from Anthropic's OAuth usage endpoint, authenticated
 * with Claude Code's own login.
 *
 * Claude Code's credentials are only ever read. Access tokens last a few
 * hours and Claude Code refreshes them as it runs; when the stored one has
 * expired the key says so, unless the user has turned on refreshing, in which
 * case the plugin refreshes into its own copy (never Claude Code's file).
 */
export class ClaudeProvider implements UsageProvider {
	readonly id = "claude";
	readonly #deps: Required<Omit<ClaudeDeps, "vault" | "run">> & Pick<ClaudeDeps, "vault" | "run">;

	constructor(deps: ClaudeDeps) {
		this.#deps = { platform: process.platform, env: process.env, fetch, now: Date.now, ...deps };
	}

	async fetchUsage(): Promise<UsageSnapshot> {
		let credentials = await this.#credentials();
		try {
			return await this.#usage(credentials);
		} catch (error) {
			// A token can be revoked before its expiry; one refresh is worth a try.
			if (!(error instanceof ProviderError) || error.kind !== "expired" || !this.#canRefresh(credentials)) {
				throw error;
			}
			credentials = await this.#refresh(credentials);
			return this.#usage(credentials);
		}
	}

	async #usage(credentials: ClaudeCredentials): Promise<UsageSnapshot> {
		const json = await requestJson<ClaudeUsageJson>(this.#deps.fetch, USAGE_URL, {
			headers: { Authorization: `Bearer ${credentials.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
		});
		return { windows: parseClaudeUsage(json), plan: credentials.subscriptionType };
	}

	/** The freshest usable login: Claude Code's, or the plugin's refreshed copy. */
	async #credentials(): Promise<ClaudeCredentials> {
		const { vault, now } = this.#deps;
		const candidates = [await this.readClaudeCode(), vault.refreshEnabled() ? vault.load() : undefined].filter(
			(c): c is ClaudeCredentials => !!c?.accessToken,
		);
		if (!candidates.length) {
			throw new ProviderError("signedOut", "Claude Code isn't signed in");
		}
		const best = candidates.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
		if (best.scopes && !best.scopes.includes(PROFILE_SCOPE)) {
			throw new ProviderError("unsupported", "This Claude login can't read plan usage; sign in with `claude auth login`");
		}
		if (best.expiresAt === undefined || best.expiresAt - EXPIRY_MARGIN_MS > now()) {
			return best;
		}
		if (!this.#canRefresh(best)) {
			throw new ProviderError("expired", "Claude Code's login has expired; run Claude Code to renew it");
		}
		return this.#refresh(best);
	}

	#canRefresh(credentials: ClaudeCredentials): boolean {
		return this.#deps.vault.refreshEnabled() && !!credentials.refreshToken;
	}

	async #refresh(credentials: ClaudeCredentials): Promise<ClaudeCredentials> {
		const { fetch: fetchImpl, vault, now } = this.#deps;
		let json: { access_token?: string; refresh_token?: string; expires_in?: number };
		try {
			json = await requestJson(fetchImpl, TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken ?? "", client_id: CLIENT_ID }),
			});
		} catch (error) {
			// A rejected refresh token (400 invalid_grant) means signing in again.
			if (error instanceof ProviderError && error.kind === "failed") {
				throw new ProviderError("expired", "Couldn't refresh the Claude login; run `claude auth login`");
			}
			throw error;
		}
		if (!json.access_token) {
			throw new ProviderError("expired", "Couldn't refresh the Claude login; run `claude auth login`");
		}
		const refreshed: ClaudeCredentials = {
			...credentials,
			accessToken: json.access_token,
			refreshToken: json.refresh_token ?? credentials.refreshToken,
			expiresAt: now() + (json.expires_in ?? 3600) * 1000,
		};
		await vault.save(refreshed);
		return refreshed;
	}

	/** Claude Code's login: the macOS Keychain item, else `.credentials.json` in its config dir. */
	async readClaudeCode(): Promise<ClaudeCredentials | undefined> {
		const { platform, env, run } = this.#deps;
		if (platform === "darwin") {
			const result = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
			const fromKeychain = result.ok ? parseCredentials(result.stdout) : undefined;
			if (fromKeychain) {
				return fromKeychain;
			}
		}
		const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude");
		const file = await readJson<{ claudeAiOauth?: ClaudeCredentials }>(path.join(dir, ".credentials.json"));
		return file?.claudeAiOauth?.accessToken ? file.claudeAiOauth : undefined;
	}
}

export function parseCredentials(text: string): ClaudeCredentials | undefined {
	try {
		const oauth = (JSON.parse(text) as { claudeAiOauth?: ClaudeCredentials }).claudeAiOauth;
		return oauth?.accessToken ? oauth : undefined;
	} catch {
		return undefined;
	}
}
