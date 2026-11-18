import os from "node:os";
import path from "node:path";

import { clampPercent, type Fetch, readJson, requestJson, toEpochMs, windowLabel } from "./http";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "./types";

export type GrokDeps = {
	env?: NodeJS.ProcessEnv;
	fetch?: Fetch;
	now?: () => number;
};

const API = "https://cli-chat-proxy.grok.com/v1";
export const BILLING_URL = `${API}/billing?format=credits`;
export const SETTINGS_URL = `${API}/settings`;

/** How long to wait for the optional plan name once usage has arrived. */
const PLAN_WAIT_MS = 2_000;

/** One login in `~/.grok/auth.json`, which is keyed by OIDC issuer. */
type GrokLogin = { key?: string; expires_at?: string | number };

type Period = { start?: string; end?: string } | null;
type Cents = { val?: number } | null;

/** The fields of `GET /v1/billing?format=credits` the plugin reads. */
export type GrokBillingJson = {
	config?: {
		currentPeriod?: Period;
		creditUsagePercent?: number | null;
		onDemandUsed?: Cents;
		onDemandCap?: Cents;
		billingPeriodStart?: string;
		billingPeriodEnd?: string;
	} | null;
};

/**
 * The credits window: percent of the plan's included credits used this
 * period, which resets weekly on SuperGrok plans.
 */
export function parseGrokBilling(json: GrokBillingJson, now: number): UsageWindow[] {
	const config = json.config;
	if (!config) return [];
	const start = toEpochMs(config.currentPeriod?.start ?? config.billingPeriodStart);
	const end = toEpochMs(config.currentPeriod?.end ?? config.billingPeriodEnd);
	const label = windowLabel(start && end ? Math.round((end - start) / 86_400_000) * 86_400 : undefined, "Credits");

	let used = typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : undefined;
	if (used === undefined && config.onDemandCap?.val) {
		used = ((config.onDemandUsed?.val ?? 0) / config.onDemandCap.val) * 100;
	}
	// Early in a period the percentage can be omitted rather than sent as zero
	// (Grok's own web client reads it as zero); only trust that for a period in progress.
	if (used === undefined && start !== undefined && end !== undefined && start <= now && now < end) {
		used = 0;
	}
	return used === undefined ? [] : [{ id: "credits", label, usedPercent: clampPercent(used), resetsAt: end }];
}

/** The issuer entries `grok login` writes, preferred first. */
const ISSUERS = ["https://auth.x.ai", "https://accounts.x.ai/sign-in"];

export function pickLogin(auth: Record<string, GrokLogin> | undefined): GrokLogin | undefined {
	const entries = Object.entries(auth ?? {}).filter(([, login]) => typeof login?.key === "string" && login.key);
	for (const issuer of ISSUERS) {
		const found = entries.find(([key]) => key.startsWith(issuer));
		if (found) return found[1];
	}
	return entries[0]?.[1];
}

/**
 * Grok plan usage from the billing API the Grok CLI itself uses, with the
 * login `grok login` keeps in `~/.grok/auth.json` (or `$GROK_HOME`). The file
 * is only read; the CLI renews its login as it runs.
 */
export class GrokProvider implements UsageProvider {
	readonly id = "grok";
	readonly #env: NodeJS.ProcessEnv;
	readonly #fetch: Fetch;
	readonly #now: () => number;

	constructor(deps: GrokDeps = {}) {
		this.#env = deps.env ?? process.env;
		this.#fetch = deps.fetch ?? fetch;
		this.#now = deps.now ?? Date.now;
	}

	async fetchUsage(): Promise<UsageSnapshot> {
		const home = this.#env.GROK_HOME || path.join(this.#env.HOME || this.#env.USERPROFILE || os.homedir(), ".grok");
		const login = pickLogin(await readJson<Record<string, GrokLogin>>(path.join(home, "auth.json")));
		if (!login?.key) {
			throw new ProviderError("signedOut", "Grok isn't signed in; run `grok login`");
		}
		const expiresAt = toEpochMs(typeof login.expires_at === "number" ? login.expires_at / 1000 : login.expires_at);
		if (expiresAt !== undefined && expiresAt <= this.#now()) {
			throw new ProviderError("expired", "Grok's login has expired; run grok to renew it");
		}

		const headers = { Authorization: `Bearer ${login.key}`, "x-xai-token-auth": "xai-grok-cli", Accept: "application/json" };
		// The plan name is a nice-to-have; never let it fail or delay the usage.
		const plan = requestJson<{ subscription_tier_display?: string }>(this.#fetch, SETTINGS_URL, { headers }).then(
			(settings) => settings.subscription_tier_display,
			() => undefined,
		);
		const billing = await requestJson<GrokBillingJson>(this.#fetch, BILLING_URL, { headers });
		const planWithin = await Promise.race([plan, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PLAN_WAIT_MS).unref())]);
		return { windows: parseGrokBilling(billing, this.#now()), plan: planWithin };
	}
}
