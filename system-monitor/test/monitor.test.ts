import { describe, expect, it, vi } from "vitest";

import { HISTORY_LENGTH, type Sources, SystemMonitor } from "../src/monitor";

function fakeSources(overrides: Partial<Sources> = {}) {
	let now = 0;
	let busy = 0;
	const sources = {
		cpuTimes: vi.fn(() => {
			busy += 50;
			return [{ idle: busy, total: busy * 2 }];
		}),
		cpuTemperature: vi.fn(async () => 55),
		memory: vi.fn(async () => ({ used: 4, total: 16 })),
		gpu: vi.fn(async () => ({ usage: 30 })),
		networkCounters: vi.fn(async () => ({ rx: now * 10, tx: now })),
		drives: vi.fn(async () => [
			{ path: "/", label: "/" },
			{ path: "/data", label: "data" },
		]),
		disk: vi.fn(async (drive: { path: string; label: string }) => ({ ...drive, used: 25, free: 75, total: 100 })),
		systemDrive: "/",
		now: () => now,
		...overrides,
	} satisfies Sources;
	return { sources, advance: (ms: number) => (now += ms) };
}

/** Let the "first demand" microtask tick run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SystemMonitor", () => {
	it("only samples metrics a key has asked for", async () => {
		const { sources } = fakeSources();
		const monitor = new SystemMonitor(sources);
		await monitor.tick();
		expect(sources.cpuTimes).not.toHaveBeenCalled();
		expect(sources.gpu).not.toHaveBeenCalled();

		expect(monitor.memory()).toBeUndefined();
		await settle();
		expect(monitor.memory()).toEqual({ used: 4, total: 16 });
		expect(monitor.history("memory")).toEqual([25]);
		expect(sources.gpu).not.toHaveBeenCalled();
	});

	it("needs two CPU snapshots before reporting usage", async () => {
		const { sources, advance } = fakeSources();
		const monitor = new SystemMonitor(sources);
		monitor.cpu();
		await settle();
		expect(monitor.cpu()).toBeUndefined();
		advance(1000);
		await monitor.tick();
		expect(monitor.cpu()).toEqual({ usage: 50, maxCore: 50, cores: 1, temperature: 55 });
	});

	it("derives network rates from counters", async () => {
		const { sources, advance } = fakeSources();
		const monitor = new SystemMonitor(sources);
		monitor.network();
		await settle();
		advance(1000);
		await monitor.tick();
		expect(monitor.network()).toEqual({ down: 10_000, up: 1_000 });
		expect(monitor.history("net:down")).toEqual([10_000]);
	});

	it("stops sampling once no key has asked for a while", async () => {
		const { sources, advance } = fakeSources();
		const monitor = new SystemMonitor(sources);
		monitor.gpu();
		await settle();
		expect(sources.gpu).toHaveBeenCalledTimes(1);
		advance(10_000);
		await monitor.tick();
		await monitor.tick();
		expect(sources.gpu).toHaveBeenCalledTimes(1);
	});

	it("reports a missing GPU as null but keeps the last good reading", async () => {
		const gpu = vi.fn(async () => undefined as { usage: number } | undefined);
		const { sources } = fakeSources({ gpu });
		const monitor = new SystemMonitor(sources);
		monitor.gpu();
		await settle();
		expect(monitor.gpu()).toBeNull();

		gpu.mockResolvedValue({ usage: 10 });
		await monitor.refresh("gpu");
		gpu.mockResolvedValue(undefined);
		await monitor.refresh("gpu");
		expect(monitor.gpu()).toEqual({ usage: 10 });
	});

	it("reads each requested drive", async () => {
		const { sources } = fakeSources();
		const monitor = new SystemMonitor(sources);
		monitor.disk();
		monitor.disk("/data");
		await settle();
		expect(monitor.disk()).toMatchObject({ label: "/", used: 25 });
		expect(monitor.disk("/data")).toMatchObject({ label: "data" });
		expect(monitor.history("disk:/data")).toEqual([25]);
	});

	it("caps history and notifies listeners", async () => {
		const { sources } = fakeSources();
		const monitor = new SystemMonitor(sources);
		const listener = vi.fn();
		monitor.subscribe(listener);
		for (let i = 0; i < HISTORY_LENGTH + 5; i++) {
			monitor.memory();
			await monitor.refresh("memory");
		}
		expect(monitor.history("memory")).toHaveLength(HISTORY_LENGTH);
		expect(listener).toHaveBeenCalled();
	});

	it("keeps the previous reading when a sample fails", async () => {
		const memory = vi.fn(async () => ({ used: 1, total: 2 }));
		const { sources } = fakeSources({ memory });
		const monitor = new SystemMonitor(sources);
		await monitor.refresh("memory");
		memory.mockRejectedValue(new Error("boom"));
		await monitor.refresh("memory");
		expect(monitor.memory()).toEqual({ used: 1, total: 2 });
	});
});
