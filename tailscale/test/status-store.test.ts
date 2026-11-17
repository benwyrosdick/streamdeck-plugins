import { describe, expect, it } from "vitest";

import type { TailscaleStatus } from "../src/tailscale/status";
import { StatusStore } from "../src/tailscale/status-store";

function setup(responses: (TailscaleStatus | undefined)[]) {
	let now = 0;
	let calls = 0;
	const cli = {
		getStatus: async () => responses[Math.min(calls++, responses.length - 1)],
	};
	const store = new StatusStore(cli, { maxAgeMs: 2_000, staleToleranceMs: 10_000, now: () => now });
	return {
		store,
		calls: () => calls,
		advance: (ms: number) => (now += ms),
	};
}

const running = { BackendState: "Running" };
const stopped = { BackendState: "Stopped" };

describe("StatusStore", () => {
	it("serves the cached status within the cache window", async () => {
		const { store, calls, advance } = setup([running, stopped]);
		expect(await store.get()).toEqual(running);
		advance(1_000);
		expect(await store.get()).toEqual(running);
		expect(calls()).toBe(1);
		advance(1_500);
		expect(await store.get()).toEqual(stopped);
		expect(calls()).toBe(2);
	});

	it("shares one in-flight fetch between concurrent callers", async () => {
		const { store, calls } = setup([running]);
		const results = await Promise.all([store.get(), store.get(), store.get()]);
		expect(results).toEqual([running, running, running]);
		expect(calls()).toBe(1);
	});

	it("force always fetches", async () => {
		const { store, calls } = setup([running, stopped]);
		await store.get();
		expect(await store.get({ force: true })).toEqual(stopped);
		expect(calls()).toBe(2);
	});

	it("serves the last good status through transient failures, then gives up", async () => {
		const { store, advance } = setup([running, undefined]);
		await store.get();
		advance(3_000);
		expect(await store.get()).toEqual(running);
		advance(8_000);
		expect(await store.get()).toBeUndefined();
	});

	it("notifies subscribers after every fetch", async () => {
		const { store } = setup([running, stopped]);
		const seen: unknown[] = [];
		const unsubscribe = store.subscribe((s) => seen.push(s));
		await store.get();
		await store.get({ force: true });
		unsubscribe();
		await store.get({ force: true });
		expect(seen).toEqual([running, stopped]);
	});
});
