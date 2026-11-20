import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { clampPercent, type Fetch, readJson, requestJson, type Runner, toEpochMs } from "./http";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "./types";

export type CursorDeps = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	fetch?: Fetch;
	run: Runner;
	now?: () => number;
	exists?: (file: string) => boolean;
};

export const SUMMARY_URL = "https://cursor.com/api/usage-summary";
export const STATUS_URL = "https://cursor.com/api/dashboard/v2/usage-status?scope=user";

/** The account the Cursor CLI files its credentials under in the OS secret store. */
const SECRET_ACCOUNT = "cursor-user";

/** The fields of `GET /api/usage-summary` the plugin reads: the monthly plan. */
export type CursorSummaryJson = {
	billingCycleStart?: string;
	billingCycleEnd?: string;
	membershipType?: string;
	individualUsage?: {
		plan?: { used?: number; limit?: number; totalPercentUsed?: number } | null;
	} | null;
};

type Period = { usedCents?: number; budgetCents?: number | null; periodStart?: string; resetsAt?: string } | null;

/** The fields of `GET /api/dashboard/v2/usage-status` the plugin reads: the weekly included pool. */
export type CursorStatusJson = {
	weeklyIncludedUsage?: Period;
};

const span = (start?: string, end?: string): number | undefined => {
	const from = toEpochMs(start);
	const to = toEpochMs(end);
	return from !== undefined && to !== undefined && to > from ? to - from : undefined;
};

/**
 * Cursor's windows: the weekly included-usage pool (newer plans, including
 * the unified X Subscription ones) and the monthly plan allowance. On unified
 * plans the monthly figure isn't what runs out, so it's left out when the
 * weekly pool is there.
 */
export function parseCursorUsage(summary: CursorSummaryJson | undefined, status: CursorStatusJson | undefined): UsageWindow[] {
	const windows: UsageWindow[] = [];
	const weekly = status?.weeklyIncludedUsage;
	if (weekly && typeof weekly.usedCents === "number" && weekly.budgetCents) {
		windows.push({
			id: "weekly",
			label: "Week",
			usedPercent: clampPercent((weekly.usedCents / weekly.budgetCents) * 100),
			resetsAt: toEpochMs(weekly.resetsAt),
			windowMs: span(weekly.periodStart, weekly.resetsAt),
		});
	}

	const plan = summary?.individualUsage?.plan;
	const unified = summary?.membershipType?.startsWith("unified") ?? false;
	const used = typeof plan?.totalPercentUsed === "number" ? plan.totalPercentUsed : plan?.limit ? ((plan.used ?? 0) / plan.limit) * 100 : undefined;
	if (used !== undefined && !(unified && windows.length)) {
		windows.push({
			id: "monthly",
			label: "Month",
			usedPercent: clampPercent(used),
			resetsAt: toEpochMs(summary?.billingCycleEnd),
			windowMs: span(summary?.billingCycleStart, summary?.billingCycleEnd),
		});
	}
	return windows;
}

/** A plan name for display: "unified_ultra" → "Ultra". */
export const planName = (membership: string | undefined): string | undefined =>
	membership ? membership.replace(/^unified_/, "").replace(/(^|_)(\w)/g, (_, sep: string, c: string) => (sep ? " " : "") + c.toUpperCase()) : undefined;

/** The payload of a JWT, or undefined. */
function jwtClaims(token: string): { sub?: string; exp?: number } | undefined {
	try {
		return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { sub?: string; exp?: number };
	} catch {
		return undefined;
	}
}

/**
 * Cursor plan usage from the endpoints cursor.com's dashboard uses, with the
 * login `cursor-agent login` keeps: in the OS secret store (the keyring on
 * Linux, the Keychain on macOS, Credential Manager on Windows), or in older
 * versions `~/.config/cursor/auth.json`. Only ever read; the CLI renews it.
 */
export class CursorProvider implements UsageProvider {
	readonly id = "cursor";
	readonly #deps: Required<CursorDeps>;

	constructor(deps: CursorDeps) {
		this.#deps = { platform: process.platform, env: process.env, fetch, now: Date.now, exists: existsSync, ...deps };
	}

	async fetchUsage(): Promise<UsageSnapshot> {
		const token = await this.readToken();
		if (!token) {
			throw new ProviderError("signedOut", "Cursor isn't signed in; run `cursor-agent login`");
		}
		const claims = jwtClaims(token);
		const user = claims?.sub?.split("|").pop();
		if (!user) {
			throw new ProviderError("signedOut", "Couldn't read the Cursor login; run `cursor-agent login`");
		}
		if (claims?.exp && claims.exp * 1000 <= this.#deps.now()) {
			throw new ProviderError("expired", "Cursor's login has expired; run `cursor-agent login`");
		}
		// cursor.com takes the login as its session cookie, not as a bearer token.
		const headers = { Cookie: `WorkosCursorSessionToken=${user}%3A%3A${token}` };
		// The weekly pool is a best-effort extra; the monthly summary decides whether the login works.
		const [summary, status] = await Promise.all([
			requestJson<CursorSummaryJson>(this.#deps.fetch, SUMMARY_URL, { headers }),
			requestJson<CursorStatusJson>(this.#deps.fetch, STATUS_URL, { headers }).catch(() => undefined),
		]);
		return { windows: parseCursorUsage(summary, status), plan: planName(summary.membershipType) };
	}

	/** The CLI's access token, wherever this platform keeps it. */
	async readToken(): Promise<string | undefined> {
		const { platform, env, run, exists } = this.#deps;
		const home = env.HOME || env.USERPROFILE || os.homedir();
		const configHome = platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming") : env.XDG_CONFIG_HOME || path.join(home, ".config");
		const file = await readJson<{ accessToken?: string; storedIn?: string }>(path.join(configHome, "cursor", "auth.json"));
		if (file?.accessToken) {
			return file.accessToken;
		}

		let secret: string | undefined;
		if (platform === "linux") {
			// Stream Deck starts plugins with a minimal PATH.
			const tool = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"].find((f) => exists(f)) ?? "secret-tool";
			secret = (await run(tool, ["lookup", "account", SECRET_ACCOUNT])).stdout;
		} else if (platform === "darwin") {
			const result = await run("/usr/bin/security", ["find-generic-password", "-a", SECRET_ACCOUNT, "-w"]);
			secret = result.ok ? result.stdout : undefined;
		} else if (platform === "win32") {
			const script = [
				"$ErrorActionPreference='Stop'",
				"$null=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
				`$c=(New-Object Windows.Security.Credentials.PasswordVault).FindAllByUserName('${SECRET_ACCOUNT}') | Select-Object -First 1`,
				"$c.RetrievePassword(); $c.Password",
			].join(";");
			const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
			secret = result.ok ? result.stdout : undefined;
		}
		return parseSecret(secret);
	}
}

/** The secret-store value: JSON with `accessToken` (current CLIs), or the bare token. */
export function parseSecret(secret: string | undefined): string | undefined {
	const text = secret?.trim();
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as { accessToken?: unknown };
		return typeof parsed.accessToken === "string" && parsed.accessToken ? parsed.accessToken : undefined;
	} catch {
		return text.split(".").length === 3 ? text : undefined;
	}
}
