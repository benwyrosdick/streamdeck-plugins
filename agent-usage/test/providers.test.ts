import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CLIENT_ID, type ClaudeCredentials, ClaudeProvider, type CredentialVault, parseClaudeUsage, TOKEN_URL, USAGE_URL } from "../src/providers/claude";
import { CodexProvider, parseCodexUsage } from "../src/providers/codex";
import { CopilotProvider, ghPaths, parseCopilotUsage } from "../src/providers/copilot";
import { BILLING_URL, GrokProvider, parseGrokBilling, pickLogin, SETTINGS_URL } from "../src/providers/grok";
import { type Runner, windowLabel } from "../src/providers/http";
import { ProviderError } from "../src/providers/types";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;

/** A fetch that answers per URL; records every call. */
function fakeFetch(routes: Record<string, (init: RequestInit) => { status?: number; body: unknown }>) {
	return vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
		const route = routes[String(url)];
		if (!route) throw new Error(`unexpected ${String(url)}`);
		const { status = 200, body } = route(init);
		return new Response(JSON.stringify(body), { status });
	});
}

/** A home directory with the given files. */
function home(files: Record<string, unknown>): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "agent-usage-test-"));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), typeof contents === "string" ? contents : JSON.stringify(contents));
	}
	return dir;
}

const noRun: Runner = async () => ({ ok: false, stdout: "" });

const kind = (promise: Promise<unknown>) =>
	promise.then(
		() => "ok",
		(error: unknown) => (error instanceof ProviderError ? error.kind : String(error)),
	);

// ---------------------------------------------------------------------- //
// Claude
// ---------------------------------------------------------------------- //

const usageBody = {
	five_hour: { utilization: 42, resets_at: "2026-11-18T14:13:00Z" },
	seven_day: { utilization: 18.5, resets_at: "2026-11-21T00:00:00Z" },
	seven_day_opus: null,
	seven_day_sonnet: { utilization: 3, resets_at: null },
};

const fileLogin = (overrides: Partial<ClaudeCredentials> = {}): ClaudeCredentials => ({
	accessToken: "file-token",
	refreshToken: "file-refresh",
	expiresAt: NOW + HOUR,
	scopes: ["user:inference", "user:profile"],
	subscriptionType: "max",
	...overrides,
});

function memoryVault(enabled: boolean, stored?: ClaudeCredentials): CredentialVault & { saved: ClaudeCredentials[] } {
	const saved: ClaudeCredentials[] = [];
	return {
		saved,
		refreshEnabled: () => enabled,
		load: () => saved.at(-1) ?? stored,
		save: async (c) => void saved.push(c),
	};
}

function claude(login: ClaudeCredentials | undefined, vault: CredentialVault, fetchImpl: typeof fetch, platform: NodeJS.Platform = "linux", run = noRun) {
	const dir = home(login ? { ".claude/.credentials.json": { claudeAiOauth: login } } : {});
	return new ClaudeProvider({ platform, env: { HOME: dir }, fetch: fetchImpl, run, vault, now: () => NOW });
}

describe("Claude", () => {
	it("parses the windows the plan has, in order", () => {
		expect(parseClaudeUsage(usageBody)).toEqual([
			{ id: "session", label: "5h", usedPercent: 42, resetsAt: Date.parse("2026-11-18T14:13:00Z") },
			{ id: "weekly", label: "Week", usedPercent: 18.5, resetsAt: Date.parse("2026-11-21T00:00:00Z") },
			{ id: "sonnet", label: "Sonnet", usedPercent: 3, resetsAt: undefined },
		]);
		expect(parseClaudeUsage({ seven_day_oauth_apps: { utilization: 7 } })).toMatchObject([{ id: "weekly", usedPercent: 7 }]);
	});

	it("reads usage with Claude Code's login", async () => {
		const fetchImpl = fakeFetch({ [USAGE_URL]: () => ({ body: usageBody }) });
		const usage = await claude(fileLogin(), memoryVault(false), fetchImpl).fetchUsage();
		expect(usage.plan).toBe("max");
		expect(usage.windows).toHaveLength(3);
		const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers).toMatchObject({ Authorization: "Bearer file-token", "anthropic-beta": "oauth-2025-04-20" });
	});

	it("reads the macOS Keychain first", async () => {
		const run = vi.fn<Runner>(async () => ({ ok: true, stdout: JSON.stringify({ claudeAiOauth: fileLogin({ accessToken: "keychain-token" }) }) }));
		const fetchImpl = fakeFetch({ [USAGE_URL]: () => ({ body: usageBody }) });
		await claude(undefined, memoryVault(false), fetchImpl, "darwin", run).fetchUsage();
		expect(run).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
		expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer keychain-token");
	});

	it("reports signed out, setup-token logins and expiry", async () => {
		const fetchImpl = fakeFetch({});
		expect(await kind(claude(undefined, memoryVault(false), fetchImpl).fetchUsage())).toBe("signedOut");
		expect(await kind(claude(fileLogin({ scopes: ["user:inference"] }), memoryVault(false), fetchImpl).fetchUsage())).toBe("unsupported");
		expect(await kind(claude(fileLogin({ expiresAt: NOW - HOUR }), memoryVault(false), fetchImpl).fetchUsage())).toBe("expired");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refreshes an expired login into its own copy when allowed, never touching Claude Code's", async () => {
		const fetchImpl = fakeFetch({
			[TOKEN_URL]: (init) => {
				const form = new URLSearchParams(String(init.body));
				expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: "file-refresh", client_id: CLIENT_ID });
				return { body: { access_token: "fresh-token", refresh_token: "fresh-refresh", expires_in: 28_800 } };
			},
			[USAGE_URL]: (init) => {
				expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
				return { body: usageBody };
			},
		});
		const vault = memoryVault(true);
		const provider = claude(fileLogin({ expiresAt: NOW - HOUR }), vault, fetchImpl);
		await provider.fetchUsage();
		expect(vault.saved).toEqual([{ ...fileLogin(), accessToken: "fresh-token", refreshToken: "fresh-refresh", expiresAt: NOW + 28_800_000 }]);
		// Claude Code's own file is unchanged.
		expect((await provider.readClaudeCode())?.accessToken).toBe("file-token");
	});

	it("prefers whichever login is fresher", async () => {
		const fetchImpl = fakeFetch({ [USAGE_URL]: () => ({ body: usageBody }) });
		const ownCopy = fileLogin({ accessToken: "own-token", expiresAt: NOW + 5 * HOUR });
		await claude(fileLogin({ expiresAt: NOW - HOUR }), memoryVault(true, ownCopy), fetchImpl).fetchUsage();
		expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer own-token");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("tries one refresh when a valid-looking token is rejected", async () => {
		let calls = 0;
		const fetchImpl = fakeFetch({
			[USAGE_URL]: () => (++calls === 1 ? { status: 401, body: {} } : { body: usageBody }),
			[TOKEN_URL]: () => ({ body: { access_token: "fresh-token", expires_in: 3600 } }),
		});
		await claude(fileLogin(), memoryVault(true), fetchImpl).fetchUsage();
		expect(calls).toBe(2);
	});

	it("reports a rejected refresh as expired", async () => {
		const fetchImpl = fakeFetch({ [TOKEN_URL]: () => ({ status: 400, body: { error: "invalid_grant" } }) });
		expect(await kind(claude(fileLogin({ expiresAt: NOW - HOUR }), memoryVault(true), fetchImpl).fetchUsage())).toBe("expired");
	});

	it("maps rate limiting", async () => {
		const fetchImpl = fakeFetch({ [USAGE_URL]: () => ({ status: 429, body: {} }) });
		expect(await kind(claude(fileLogin(), memoryVault(false), fetchImpl).fetchUsage())).toBe("rateLimited");
	});
});

// ---------------------------------------------------------------------- //
// Codex
// ---------------------------------------------------------------------- //

describe("Codex", () => {
	const body = {
		plan_type: "team",
		rate_limit: {
			primary_window: { used_percent: 15, limit_window_seconds: 18_000, reset_at: 1_794_981_498 },
			secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_at: 1_795_568_298 },
		},
	};

	it("parses both windows, naming them from their length", () => {
		expect(parseCodexUsage(body)).toEqual([
			{ id: "session", label: "5h", usedPercent: 15, resetsAt: 1_794_981_498_000 },
			{ id: "weekly", label: "Week", usedPercent: 5, resetsAt: 1_795_568_298_000 },
		]);
		expect(parseCodexUsage({ rate_limit: { primary_window: null } })).toEqual([]);
		expect(windowLabel(2_592_000, "x")).toBe("Month");
		expect(windowLabel(90 * 86_400, "x")).toBe("90d");
		expect(windowLabel(undefined, "5h")).toBe("5h");
	});

	it("reads usage with Codex's ChatGPT login and account header", async () => {
		const fetchImpl = fakeFetch({ "https://chatgpt.com/backend-api/wham/usage": () => ({ body }) });
		const dir = home({ "auth.json": { auth_mode: "chatgpt", tokens: { access_token: "tok", account_id: "acct" } } });
		const usage = await new CodexProvider({ env: { CODEX_HOME: dir }, fetch: fetchImpl }).fetchUsage();
		expect(usage.plan).toBe("team");
		expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer tok", "ChatGPT-Account-Id": "acct" });
	});

	it("tells signed-out apart from API-key logins", async () => {
		const fetchImpl = fakeFetch({});
		expect(await kind(new CodexProvider({ env: { CODEX_HOME: home({}) }, fetch: fetchImpl }).fetchUsage())).toBe("signedOut");
		const apiKey = home({ "auth.json": { auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null } });
		expect(await kind(new CodexProvider({ env: { CODEX_HOME: apiKey }, fetch: fetchImpl }).fetchUsage())).toBe("unsupported");
	});

	it("reports an expired login", async () => {
		const fetchImpl = fakeFetch({ "https://chatgpt.com/backend-api/wham/usage": () => ({ status: 401, body: {} }) });
		const dir = home({ "auth.json": { tokens: { access_token: "old" } } });
		expect(await kind(new CodexProvider({ env: { CODEX_HOME: dir }, fetch: fetchImpl }).fetchUsage())).toBe("expired");
	});
});

// ---------------------------------------------------------------------- //
// Copilot
// ---------------------------------------------------------------------- //

describe("Copilot", () => {
	const body = {
		copilot_plan: "individual",
		quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
		quota_snapshots: {
			premium_interactions: { percent_remaining: 64.5, remaining: 967, unlimited: false },
			chat: { percent_remaining: 100, unlimited: true },
		},
	};
	const reset = Date.parse("2026-12-01T00:00:00Z");

	it("turns percent remaining into percent used, and marks unlimited quotas", () => {
		expect(parseCopilotUsage(body)).toEqual([
			{ id: "premium", label: "Premium", usedPercent: 35.5, resetsAt: reset, remaining: 967 },
			{ id: "chat", label: "Chat", usedPercent: undefined, resetsAt: reset },
		]);
	});

	it("uses GH_TOKEN before asking gh", async () => {
		const run = vi.fn<Runner>();
		const fetchImpl = fakeFetch({ "https://api.github.com/copilot_internal/user": () => ({ body }) });
		await new CopilotProvider({ env: { GH_TOKEN: "env-token" }, fetch: fetchImpl, run }).fetchUsage();
		expect(run).not.toHaveBeenCalled();
		expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "token env-token" });
	});

	it("asks the gh CLI found in a well-known location", async () => {
		const run = vi.fn<Runner>(async () => ({ ok: true, stdout: "gh-token\n" }));
		const fetchImpl = fakeFetch({ "https://api.github.com/copilot_internal/user": () => ({ body }) });
		const provider = new CopilotProvider({ platform: "darwin", env: {}, fetch: fetchImpl, run, exists: (f) => f === "/usr/local/bin/gh" });
		expect((await provider.fetchUsage()).plan).toBe("individual");
		expect(run).toHaveBeenCalledWith("/usr/local/bin/gh", ["auth", "token"]);
	});

	it("reports no login and an ended subscription", async () => {
		const ended = fakeFetch({ "https://api.github.com/copilot_internal/user": () => ({ body: { access_type_sku: "subscription_ended" } }) });
		expect(await kind(new CopilotProvider({ env: {}, fetch: ended, run: noRun, exists: () => false }).fetchUsage())).toBe("signedOut");
		expect(await kind(new CopilotProvider({ env: { GH_TOKEN: "t" }, fetch: ended, run: noRun }).fetchUsage())).toBe("unsupported");
	});

	it("knows where gh is installed", () => {
		expect(ghPaths("win32", { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toEqual([
			"C:\\Program Files\\GitHub CLI\\gh.exe",
			"C:\\Users\\me\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
		]);
	});
});

// ---------------------------------------------------------------------- //
// Grok
// ---------------------------------------------------------------------- //

describe("Grok", () => {
	const period = { start: "2026-11-16T20:52:34Z", end: "2026-11-23T20:52:34Z" };
	const end = Date.parse(period.end);
	const billing = { config: { currentPeriod: period, creditUsagePercent: 12.5, billingPeriodEnd: period.end } };
	const login = (expires_at: string) => ({ "https://auth.x.ai::client": { key: "grok-token", expires_at, email: "x" } });

	it("reads the credits window, naming it from the period", () => {
		expect(parseGrokBilling(billing, NOW)).toEqual([{ id: "credits", label: "Week", usedPercent: 12.5, resetsAt: end }]);
		const monthly = { config: { billingPeriodStart: "2026-11-01T00:00:00Z", billingPeriodEnd: "2026-12-01T00:00:00Z", creditUsagePercent: 3 } };
		expect(parseGrokBilling(monthly, NOW)[0].label).toBe("Month");
	});

	it("falls back to on-demand spend, and reads a missing percentage in an active period as zero", () => {
		expect(parseGrokBilling({ config: { onDemandUsed: { val: 250 }, onDemandCap: { val: 1000 } } }, NOW)[0].usedPercent).toBe(25);
		expect(parseGrokBilling({ config: { currentPeriod: period } }, NOW)[0].usedPercent).toBe(0);
		// A period that has ended (or hasn't started) proves nothing.
		expect(parseGrokBilling({ config: { currentPeriod: period } }, end + 1)).toEqual([]);
		expect(parseGrokBilling({}, NOW)).toEqual([]);
	});

	it("prefers the SuperGrok login over a legacy session", () => {
		expect(pickLogin({ "https://accounts.x.ai/sign-in": { key: "old" }, "https://auth.x.ai::abc": { key: "new" } })?.key).toBe("new");
		expect(pickLogin({ "https://accounts.x.ai/sign-in": { key: "old" } })?.key).toBe("old");
		expect(pickLogin({ "https://auth.x.ai::abc": { key: "" } })).toBeUndefined();
	});

	it("reads usage and the plan name with the CLI's login", async () => {
		const fetchImpl = fakeFetch({
			[BILLING_URL]: () => ({ body: billing }),
			[SETTINGS_URL]: () => ({ body: { subscription_tier_display: "SuperGrok Heavy" } }),
		});
		const dir = home({ "auth.json": login("2026-11-18T15:00:00Z") });
		const usage = await new GrokProvider({ env: { GROK_HOME: dir }, fetch: fetchImpl, now: () => NOW }).fetchUsage();
		expect(usage).toEqual({ windows: [{ id: "credits", label: "Week", usedPercent: 12.5, resetsAt: end }], plan: "SuperGrok Heavy" });
		expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer grok-token", "x-xai-token-auth": "xai-grok-cli" });
	});

	it("still reports usage when the plan lookup fails", async () => {
		const fetchImpl = fakeFetch({ [BILLING_URL]: () => ({ body: billing }), [SETTINGS_URL]: () => ({ status: 500, body: {} }) });
		const dir = home({ "auth.json": login("2026-11-18T15:00:00Z") });
		const usage = await new GrokProvider({ env: { GROK_HOME: dir }, fetch: fetchImpl, now: () => NOW }).fetchUsage();
		expect(usage.plan).toBeUndefined();
		expect(usage.windows).toHaveLength(1);
	});

	it("reports signed out and expired logins without calling the API", async () => {
		const fetchImpl = fakeFetch({});
		expect(await kind(new GrokProvider({ env: { GROK_HOME: home({}) }, fetch: fetchImpl, now: () => NOW }).fetchUsage())).toBe("signedOut");
		const expired = home({ "auth.json": login("2026-11-18T11:00:00Z") });
		expect(await kind(new GrokProvider({ env: { GROK_HOME: expired }, fetch: fetchImpl, now: () => NOW }).fetchUsage())).toBe("expired");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
