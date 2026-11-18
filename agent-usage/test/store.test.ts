import { describe, expect, it, vi } from "vitest";

import { ProviderError, type ProviderId, type UsageProvider, type UsageSnapshot } from "../src/providers/types";
import { HISTORY_LENGTH, MIN_REFRESH_GAP_MS, POLL_MS, RATE_LIMIT_BACKOFF_MS, UsageStore } from "../src/store";

const snapshot = (used: number): UsageSnapshot => ({ windows: [{ id: "session", label: "5h", usedPercent: used }] });

function fakeProvider(id: ProviderId, results: (UsageSnapshot | ProviderError)[]) {
	let i = 0;
	const provider: UsageProvider & { fetchUsage: ReturnType<typeof vi.fn> } = {
		id,
		fetchUsage: vi.fn(async () => {
			const result = results[Math.min(i++, results.length - 1)];
			if (result instanceof ProviderError) throw result;
			return result;
		}),
	};
	return provider;
}

function setup(providers: UsageProvider[]) {
	let now = 0;
	const store = new UsageStore(providers, { now: () => now });
	return { store, advance: (ms: number) => (now += ms) };
}

/** Let the "first demand" microtask fetch run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("UsageStore", () => {
	it("fetches a provider as soon as a key asks, and only that provider", async () => {
		const claude = fakeProvider("claude", [snapshot(10)]);
		const codex = fakeProvider("codex", [snapshot(20)]);
		const { store } = setup([claude, codex]);
		expect(store.state("claude")).toEqual({});
		await settle();
		expect(store.state("claude").snapshot).toEqual(snapshot(10));
		expect(codex.fetchUsage).not.toHaveBeenCalled();
	});

	it("polls on each provider's interval while wanted, then stops", async () => {
		const claude = fakeProvider("claude", [snapshot(10)]);
		const { store, advance } = setup([claude]);
		store.state("claude");
		await settle();
		advance(POLL_MS.claude - 1);
		store.state("claude");
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(1);
		advance(1);
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);
		// Nobody has asked for over a minute.
		advance(POLL_MS.claude + 60_001);
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("keeps the last reading through a failure, alongside the error", async () => {
		const failure = new ProviderError("failed", "offline");
		const claude = fakeProvider("claude", [snapshot(10), failure]);
		const { store, advance } = setup([claude]);
		await store.refresh("claude");
		advance(MIN_REFRESH_GAP_MS);
		await store.refresh("claude");
		expect(store.state("claude")).toMatchObject({ snapshot: snapshot(10), error: failure });
	});

	it("backs off after being rate limited", async () => {
		const claude = fakeProvider("claude", [new ProviderError("rateLimited", "429"), snapshot(5)]);
		const { store, advance } = setup([claude]);
		store.state("claude");
		await settle();
		advance(POLL_MS.claude);
		store.state("claude");
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(1);
		advance(RATE_LIMIT_BACKOFF_MS - POLL_MS.claude);
		store.state("claude");
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("honours Retry-After, but never retries sooner than the normal interval", async () => {
		const claude = fakeProvider("claude", [new ProviderError("rateLimited", "429", 3_600_000), snapshot(5)]);
		const { store, advance } = setup([claude]);
		await store.refresh("claude");
		advance(3_600_000 - 1);
		store.state("claude");
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(1);
		advance(1);
		await store.tick();
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);

		const soon = fakeProvider("codex", [new ProviderError("rateLimited", "429", 1_000), snapshot(5)]);
		const other = setup([soon]);
		await other.store.refresh("codex");
		other.advance(POLL_MS.codex - 1);
		other.store.state("codex");
		await other.store.tick();
		expect(soon.fetchUsage).toHaveBeenCalledTimes(1);
	});

	it("doesn't let key presses hammer the endpoint", async () => {
		const claude = fakeProvider("claude", [snapshot(10)]);
		const { store, advance } = setup([claude]);
		await store.refresh("claude");
		await store.refresh("claude");
		advance(MIN_REFRESH_GAP_MS - 1);
		await store.refresh("claude");
		expect(claude.fetchUsage).toHaveBeenCalledTimes(1);
		advance(1);
		await store.refresh("claude");
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("lets a forced refresh skip the gap, but not a rate-limit backoff", async () => {
		const claude = fakeProvider("claude", [snapshot(10), new ProviderError("rateLimited", "429"), snapshot(20)]);
		const { store } = setup([claude]);
		await store.refresh("claude");
		await store.refresh("claude", { force: true });
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);
		await store.refresh("claude", { force: true });
		expect(claude.fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("shares one request between concurrent refreshes", async () => {
		const claude = fakeProvider("claude", [snapshot(10)]);
		const { store } = setup([claude]);
		await Promise.all([store.refresh("claude"), store.refresh("claude")]);
		expect(claude.fetchUsage).toHaveBeenCalledTimes(1);
	});

	it("records capped history per window and notifies listeners", async () => {
		const values = Array.from({ length: HISTORY_LENGTH + 5 }, (_, i) => snapshot(i));
		const claude = fakeProvider("claude", values);
		const { store, advance } = setup([claude]);
		const listener = vi.fn();
		store.subscribe(listener);
		for (let i = 0; i < values.length; i++) {
			await store.refresh("claude");
			advance(MIN_REFRESH_GAP_MS);
		}
		expect(store.history("claude", "session")).toHaveLength(HISTORY_LENGTH);
		expect(store.history("claude", "session").at(-1)).toBe(HISTORY_LENGTH + 4);
		expect(listener).toHaveBeenCalledTimes(values.length);
	});
});
