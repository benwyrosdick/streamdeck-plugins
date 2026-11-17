import type { TailscaleCli } from "./cli";
import type { TailscaleStatus } from "./status";

export type StatusListener = (status: TailscaleStatus | undefined) => void;

export type StatusStoreOptions = {
	/** How long a fetched status is considered fresh. */
	maxAgeMs?: number;
	/**
	 * How long the last good status keeps being served after fetches start
	 * failing. Smooths over transient CLI hiccups without stranding a stale
	 * state forever if the daemon really goes away.
	 */
	staleToleranceMs?: number;
	now?: () => number;
};

/**
 * Shared, cached `tailscale status --json`.
 *
 * Every action reads through this store, so the daemon is queried at most once
 * per cache window no matter how many keys are visible. Every completed fetch
 * is broadcast to subscribers, which is how all keys stay in sync after a
 * mutation on any one of them.
 */
export class StatusStore {
	readonly #cli: Pick<TailscaleCli, "getStatus">;
	readonly #maxAgeMs: number;
	readonly #staleToleranceMs: number;
	readonly #now: () => number;
	readonly #listeners = new Set<StatusListener>();

	#status: TailscaleStatus | undefined;
	#fetchedAt = Number.NEGATIVE_INFINITY;
	#succeededAt = Number.NEGATIVE_INFINITY;
	#inflight: Promise<TailscaleStatus | undefined> | undefined;
	#timer: NodeJS.Timeout | undefined;

	constructor(cli: Pick<TailscaleCli, "getStatus">, options: StatusStoreOptions = {}) {
		this.#cli = cli;
		this.#maxAgeMs = options.maxAgeMs ?? 2_000;
		this.#staleToleranceMs = options.staleToleranceMs ?? 10_000;
		this.#now = options.now ?? Date.now;
	}

	/** The last status served, without fetching. */
	get current(): TailscaleStatus | undefined {
		return this.#status;
	}

	/**
	 * A recent status, or `undefined` when Tailscale is unavailable.
	 *
	 * Concurrent callers share a single in-flight fetch. `force` always starts
	 * a fresh fetch, so a mutation sees the state *after* its command returned
	 * rather than a fetch that was already running before it.
	 */
	get({ force = false } = {}): Promise<TailscaleStatus | undefined> {
		if (!force) {
			if (this.#inflight) {
				return this.#inflight;
			}
			if (this.#now() - this.#fetchedAt < this.#maxAgeMs) {
				return Promise.resolve(this.#status);
			}
		}

		const fetch = this.#fetch();
		this.#inflight = fetch;
		void fetch.finally(() => {
			if (this.#inflight === fetch) {
				this.#inflight = undefined;
			}
		});
		return fetch;
	}

	subscribe(listener: StatusListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Poll every `intervalMs` while `shouldPoll()` holds (e.g. any key is visible). */
	startPolling(intervalMs: number, shouldPoll: () => boolean): void {
		this.stopPolling();
		this.#timer = setInterval(() => {
			if (shouldPoll()) {
				void this.get();
			}
		}, intervalMs);
	}

	stopPolling(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async #fetch(): Promise<TailscaleStatus | undefined> {
		let status: TailscaleStatus | undefined;
		try {
			status = await this.#cli.getStatus();
		} catch {
			status = undefined;
		}

		const now = this.#now();
		this.#fetchedAt = now;
		if (status) {
			this.#status = status;
			this.#succeededAt = now;
		} else if (now - this.#succeededAt >= this.#staleToleranceMs) {
			this.#status = undefined;
		}

		for (const listener of this.#listeners) {
			try {
				listener(this.#status);
			} catch {
				// A broken listener must not stop the others from updating.
			}
		}
		return this.#status;
	}
}
