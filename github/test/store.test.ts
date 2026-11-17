import { describe, expect, it } from "vitest";

import { type GhCli, RateLimitError } from "../src/github/cli";
import { GitHubStore, MAX_AGE } from "../src/github/store";

function setup(responses: (number | undefined | Error)[]) {
	let now = 0;
	let calls = 0;
	const cli = {
		count: async () => {
			const response = responses[Math.min(calls++, responses.length - 1)];
			if (response instanceof Error) {
				throw response;
			}
			return response;
		},
		authenticated: async () => true,
	} as unknown as GhCli;
	const store = new GitHubStore(cli, { now: () => now });
	let notified = 0;
	store.subscribe(() => notified++);
	return {
		store,
		calls: () => calls,
		notified: () => notified,
		advance: (ms: number) => (now += ms),
	};
}

describe("GitHubStore", () => {
	it("returns nothing until the background fetch lands, then notifies", async () => {
		const { store, notified } = setup([5]);
		expect(store.count("q")).toBeUndefined();
		await store.settled();
		expect(notified()).toBe(1);
		expect(store.count("q")).toBe(5);
	});

	it("serves the cached value within its window, then refreshes", async () => {
		const { store, calls, advance } = setup([5, 7]);
		store.count("q");
		await store.settled();
		advance(MAX_AGE.count - 1);
		expect(store.count("q")).toBe(5);
		expect(calls()).toBe(1);
		advance(1);
		expect(store.count("q")).toBe(5); // stale value while refreshing
		await store.settled();
		expect(store.count("q")).toBe(7);
		expect(calls()).toBe(2);
	});

	it("shares one in-flight fetch between readers of the same key", async () => {
		const { store, calls } = setup([5]);
		store.count("q");
		store.count("q");
		store.count("q");
		await store.settled();
		expect(calls()).toBe(1);
	});

	it("keeps the last good value through a transient failure", async () => {
		const { store, advance } = setup([5, undefined]);
		store.count("q");
		await store.settled();
		advance(MAX_AGE.count);
		store.count("q");
		await store.settled();
		expect(store.count("q")).toBe(5);
	});

	it("re-fetches after invalidation", async () => {
		const { store, calls } = setup([5, 6]);
		store.count("q");
		await store.settled();
		store.invalidateCount("q");
		expect(store.count("q")).toBeUndefined();
		await store.settled();
		expect(store.count("q")).toBe(6);
		expect(calls()).toBe(2);
	});

	it("suspends fetching while rate limited", async () => {
		const { store, calls, advance } = setup([new RateLimitError(30_000), 9]);
		store.count("q");
		await store.settled();
		expect(store.rateLimitedUntil()).toBe(30_000);

		store.count("other");
		expect(calls()).toBe(1);

		advance(30_000);
		expect(store.rateLimitedUntil()).toBeUndefined();
		store.count("q");
		await store.settled();
		expect(store.count("q")).toBe(9);
	});
});
