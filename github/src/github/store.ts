import { type GhCli, RateLimitError, type StepProgress, type WorkflowRun } from "./cli";

export type StoreListener = () => void;

export type GitHubStoreOptions = {
	/** Epoch milliseconds; injectable for tests. */
	now?: () => number;
};

/** How long each kind of read is considered fresh (ms). */
export const MAX_AGE = {
	auth: 300_000,
	count: 45_000,
	run: 30_000,
	progress: 15_000,
	notifications: 60_000,
} as const;

type Entry = { value: unknown; fetchedAt: number };

/**
 * Shared, cached GitHub reads.
 *
 * Every read hits the network, so it must never block a render: getters
 * return the cached value immediately (or `undefined` before the first fetch
 * completes) and refresh in the background once the value is older than its
 * max age. Entries are keyed by what they fetch, so identical keys share a
 * single fetch and unrelated keys don't clobber each other.
 *
 * Every completed fetch is broadcast to subscribers, which is how keys update
 * as soon as new data lands rather than on the next tick.
 *
 * When GitHub rate-limits us, all fetching is suspended until the reset; the
 * last cached values keep being served in the meantime.
 */
export class GitHubStore {
	readonly #cli: GhCli;
	readonly #now: () => number;
	readonly #cache = new Map<string, Entry>();
	readonly #inflight = new Set<string>();
	readonly #listeners = new Set<StoreListener>();
	#rateLimitedUntil = 0;
	#timer: NodeJS.Timeout | undefined;

	constructor(cli: GhCli, options: GitHubStoreOptions = {}) {
		this.#cli = cli;
		this.#now = options.now ?? Date.now;
	}

	// ------------------------------------------------------------------ //
	// Typed reads used by the actions
	// ------------------------------------------------------------------ //

	/** Whether `gh` is installed and authenticated; `undefined` until checked. */
	authenticated(): boolean | undefined {
		return this.read("auth", () => this.#cli.authenticated(), MAX_AGE.auth);
	}

	count(query: string): number | undefined {
		return query ? this.read(countKey(query), () => this.#cli.count(query), MAX_AGE.count) : undefined;
	}

	/** The latest run; `null` when there are none, `undefined` while unknown. */
	run(repo: string, workflow = "", branch = ""): WorkflowRun | null | undefined {
		if (!repo) {
			return undefined;
		}
		return this.read(runKey(repo, workflow, branch), () => this.#cli.latestRun(repo, workflow, branch), MAX_AGE.run);
	}

	/** Cached more briefly than runs, so the live counter advances while a run is going. */
	runProgress(repo: string, runId: number | undefined): StepProgress | undefined {
		if (!repo || !runId) {
			return undefined;
		}
		return this.read(`progress\0${repo}\0${runId}`, () => this.#cli.runStepProgress(repo, runId), MAX_AGE.progress);
	}

	notificationCount(repo = "", participating = false, reason = ""): number | undefined {
		return this.read(
			notificationKey(repo, participating, reason),
			() => this.#cli.notificationCount(repo, participating, reason),
			MAX_AGE.notifications,
		);
	}

	invalidateCount(query: string): void {
		this.invalidate(countKey(query));
	}

	invalidateRun(repo: string, workflow = "", branch = ""): void {
		this.invalidate(runKey(repo, workflow, branch));
	}

	invalidateNotificationCount(repo = "", participating = false, reason = ""): void {
		this.invalidate(notificationKey(repo, participating, reason));
	}

	// ------------------------------------------------------------------ //
	// Generic cache
	// ------------------------------------------------------------------ //

	/**
	 * The cached value for `key` (or `undefined`), refreshing it in the
	 * background when missing or older than `maxAgeMs`. Never blocks.
	 */
	read<T>(key: string, fetcher: () => Promise<T | undefined>, maxAgeMs: number): T | undefined {
		const entry = this.#cache.get(key);
		const fresh = entry !== undefined && this.#now() - entry.fetchedAt < maxAgeMs;
		if (!fresh && !this.#inflight.has(key) && this.rateLimitedUntil() === undefined) {
			this.#inflight.add(key);
			void this.#refresh(key, fetcher);
		}
		return entry?.value as T | undefined;
	}

	/** Drop a cached value so the next read re-fetches. */
	invalidate(key: string): void {
		this.#cache.delete(key);
	}

	/** Epoch ms when the rate limit resets, or `undefined` when not limited. */
	rateLimitedUntil(): number | undefined {
		return this.#now() < this.#rateLimitedUntil ? this.#rateLimitedUntil : undefined;
	}

	subscribe(listener: StoreListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Notify subscribers every `intervalMs` while `shouldTick()` holds (e.g. any
	 * key is visible). Each tick re-renders keys, which re-reads the cache and so
	 * starts any refreshes that have come due; it also advances countdowns.
	 */
	startTicking(intervalMs: number, shouldTick: () => boolean): void {
		this.stopTicking();
		this.#timer = setInterval(() => {
			if (shouldTick()) {
				this.#notify();
			}
		}, intervalMs);
	}

	stopTicking(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/** Resolves once every fetch currently in flight has settled (for tests). */
	async settled(): Promise<void> {
		while (this.#inflight.size > 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	async #refresh<T>(key: string, fetcher: () => Promise<T | undefined>): Promise<void> {
		let value: T | undefined;
		try {
			value = await fetcher();
		} catch (error) {
			if (error instanceof RateLimitError) {
				// Suspend all fetching until the reset; leave the cached value
				// (and its stale timestamp) alone so it re-fetches afterwards.
				this.#rateLimitedUntil = Math.max(this.#rateLimitedUntil, error.resetAt);
				this.#inflight.delete(key);
				this.#notify();
				return;
			}
			value = undefined;
		}

		const previous = this.#cache.get(key)?.value;
		// A transient failure (timeout, flaky keyring/auth, …) keeps the last
		// good value on screen instead of blanking it; the timestamp still
		// resets, so we back off one max-age window before retrying. Failures
		// are cached too, so a broken `gh` isn't hammered on every tick.
		this.#cache.set(key, { value: value === undefined ? previous : value, fetchedAt: this.#now() });
		this.#inflight.delete(key);
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not stop the others from updating.
			}
		}
	}
}

function countKey(query: string): string {
	return `count\0${query}`;
}

function runKey(repo: string, workflow: string, branch: string): string {
	return `run\0${repo}\0${workflow}\0${branch}`;
}

function notificationKey(repo: string, participating: boolean, reason: string): string {
	return `notifications\0${repo}\0${participating ? 1 : 0}\0${reason}`;
}
