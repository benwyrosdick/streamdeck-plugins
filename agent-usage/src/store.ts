import { ProviderError, type ProviderId, type UsageProvider, type UsageSnapshot } from "./providers/types";

/** Points of history kept per window, for the graphs. */
export const HISTORY_LENGTH = 40;

/** How often each provider is polled while a key shows it. Copilot's quota is monthly. */
export const POLL_MS: Record<ProviderId, number> = { claude: 120_000, codex: 120_000, copilot: 300_000, grok: 120_000 };

/** After a 429, wait this long before asking again. */
export const RATE_LIMIT_BACKOFF_MS = 600_000;

/** A provider is polled while a key has asked for it within this window. */
const DEMAND_WINDOW_MS = 60_000;

export type ProviderState = {
	/** The last good reading, kept through transient failures. */
	snapshot?: UsageSnapshot;
	/** Why the latest fetch failed, if it did. */
	error?: ProviderError;
	/** When `snapshot` was fetched, epoch ms. */
	fetchedAt?: number;
};

/**
 * The single source of usage readings for every key.
 *
 * Keys read through {@link UsageStore.state}, which also registers demand:
 * only providers a visible key has asked for recently are polled, each on
 * its own interval, and never more than one request per provider at a time.
 * Listeners are told after every tick so reset countdowns stay current.
 */
export class UsageStore {
	readonly #providers: Map<ProviderId, UsageProvider>;
	readonly #now: () => number;
	readonly #states = new Map<ProviderId, ProviderState>();
	readonly #demand = new Map<ProviderId, number>();
	readonly #nextFetch = new Map<ProviderId, number>();
	readonly #inFlight = new Map<ProviderId, Promise<void>>();
	readonly #history = new Map<string, number[]>();
	readonly #listeners = new Set<() => void>();
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(providers: UsageProvider[], { now = Date.now }: { now?: () => number } = {}) {
		this.#providers = new Map(providers.map((p) => [p.id, p]));
		this.#now = now;
	}

	/** The provider's current state; asking keeps it polled. */
	state(id: ProviderId): ProviderState {
		const first = !this.#demand.has(id);
		this.#demand.set(id, this.#now());
		if (first && !this.#states.has(id)) {
			// Don't make a newly shown key wait for the next tick.
			queueMicrotask(() => void this.refresh(id));
		}
		return this.#states.get(id) ?? {};
	}

	/** Recent used-percent readings for one window, oldest first. */
	history(id: ProviderId, window: string): number[] {
		return this.#history.get(`${id}:${window}`) ?? [];
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Tick on an interval while `active()` says anything is on screen. */
	start(intervalMs: number, active: () => boolean): void {
		this.stop();
		this.#timer = setInterval(() => {
			if (active()) {
				void this.tick();
			}
		}, intervalMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	/** Poll whatever is wanted and due, then notify listeners (even if nothing was fetched). */
	async tick(): Promise<void> {
		const now = this.#now();
		const due = [...this.#demand.entries()]
			.filter(([id, at]) => {
				if (now - at > DEMAND_WINDOW_MS) {
					this.#demand.delete(id);
					return false;
				}
				return now >= (this.#nextFetch.get(id) ?? 0);
			})
			.map(([id]) => this.#fetch(id));
		await Promise.all(due);
		this.#notify();
	}

	/** Fetch `id` now, regardless of schedule (a key press or first appearance). */
	async refresh(id: ProviderId): Promise<void> {
		await this.#fetch(id);
		this.#notify();
	}

	#fetch(id: ProviderId): Promise<void> {
		const running = this.#inFlight.get(id);
		if (running) {
			return running;
		}
		const job = this.#doFetch(id).finally(() => this.#inFlight.delete(id));
		this.#inFlight.set(id, job);
		return job;
	}

	async #doFetch(id: ProviderId): Promise<void> {
		const provider = this.#providers.get(id);
		if (!provider) {
			return;
		}
		const previous = this.#states.get(id) ?? {};
		try {
			const snapshot = await provider.fetchUsage();
			const now = this.#now();
			this.#states.set(id, { snapshot, fetchedAt: now });
			this.#nextFetch.set(id, now + POLL_MS[id]);
			for (const window of snapshot.windows) {
				if (window.usedPercent !== undefined) {
					this.#push(`${id}:${window.id}`, window.usedPercent);
				}
			}
		} catch (cause) {
			const error = cause instanceof ProviderError ? cause : new ProviderError("failed", String(cause));
			this.#states.set(id, { ...previous, error });
			this.#nextFetch.set(id, this.#now() + (error.kind === "rateLimited" ? RATE_LIMIT_BACKOFF_MS : POLL_MS[id]));
		}
	}

	#push(key: string, value: number): void {
		const values = this.#history.get(key) ?? [];
		values.push(value);
		if (values.length > HISTORY_LENGTH) {
			values.splice(0, values.length - HISTORY_LENGTH);
		}
		this.#history.set(key, values);
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}
}
