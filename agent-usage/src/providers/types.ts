/** The agents the plugin reads plan usage for. */
export type ProviderId = "claude" | "codex" | "copilot" | "grok";

/** One rate-limit window, e.g. Claude's 5-hour session or Copilot's monthly premium requests. */
export type UsageWindow = {
	/** Stable id the key settings refer to: `session`, `weekly`, `opus`, `premium`, … */
	id: string;
	/** Short name for the key header: `5h`, `Week`, `Opus`. */
	label: string;
	/** Percent of the allowance used, 0–100; `undefined` for an unlimited allowance. */
	usedPercent: number | undefined;
	/** When the window resets, epoch ms. */
	resetsAt?: number;
	/** Requests left, where the provider counts them (Copilot). */
	remaining?: number;
};

export type UsageSnapshot = {
	windows: UsageWindow[];
	/** Plan name as the provider reports it: `max`, `team`, `individual`. */
	plan?: string;
};

/**
 * Why there's no reading. Each maps to a short hint on the key.
 *
 * - `signedOut`: no login found for the agent.
 * - `expired`: the login exists but its access token has expired.
 * - `unsupported`: signed in a way that can't report plan usage (e.g. an API key).
 * - `rateLimited`: the usage endpoint asked us to back off.
 * - `failed`: anything else (network, unexpected response).
 */
export type ProviderErrorKind = "signedOut" | "expired" | "unsupported" | "rateLimited" | "failed";

export class ProviderError extends Error {
	constructor(
		readonly kind: ProviderErrorKind,
		message: string,
	) {
		super(message);
		this.name = "ProviderError";
	}
}

/** Fetches a provider's current usage, throwing {@link ProviderError} when it can't. */
export type UsageProvider = {
	readonly id: ProviderId;
	fetchUsage(): Promise<UsageSnapshot>;
};
