import { describe, expect, it } from "vitest";

import {
	cpuView,
	diskView,
	formatBytes,
	formatRate,
	gpuView,
	levelFor,
	memoryView,
	networkView,
	overviewMetrics,
	overviewView,
	thresholds,
	usedOfTotal,
} from "../src/views";

const GiB = 2 ** 30;

describe("levelFor", () => {
	it("colours past the default thresholds", () => {
		expect(levelFor(69, {})).toBe("normal");
		expect(levelFor(70, {})).toBe("warning");
		expect(levelFor(90, {})).toBe("critical");
	});

	it("honours custom thresholds, including the strings the inspector stores", () => {
		expect(levelFor(55, { warnAt: "50", critAt: "60" })).toBe("warning");
		expect(levelFor(65, { warnAt: 50, critAt: 60 })).toBe("critical");
	});

	it("never lets critical sit below warning", () => {
		expect(thresholds({ warnAt: "80", critAt: "60" })).toEqual({ warn: 80, crit: 80 });
	});

	it("can be switched off", () => {
		expect(levelFor(100, { colorize: false })).toBe("normal");
	});
});

describe("formatting", () => {
	it("formats sizes", () => {
		expect(formatBytes(6.1 * GiB)).toBe("6.1 GB");
		expect(formatBytes(390 * GiB)).toBe("390 GB");
		expect(formatBytes(1300 * GiB)).toBe("1.3 TB");
		expect(formatBytes(512)).toBe("512 B");
		expect(usedOfTotal(19.4 * GiB, 32 * GiB)).toBe("19.4 GB / 32.0 GB");
	});

	it("formats rates in bytes or bits", () => {
		expect(formatRate(3.6 * 2 ** 20)).toBe("3.6 MB/s");
		expect(formatRate(0)).toBe("0 B/s");
		expect(formatRate(3_600_000, "bits")).toBe("28.8 Mb/s");
	});
});

describe("metric views", () => {
	it("shows a single metric by default", () => {
		const view = cpuView({ usage: 20.4, maxCore: 64, cores: 8, temperature: 50 }, [10, 20], {});
		expect(view).toEqual({
			kind: "gauge",
			style: "classic",
			level: "normal",
			title: "CPU",
			value: "20%",
			detail: undefined,
			fraction: 0.204,
			history: [0.1, 0.2],
		});
	});

	it("adds temperature and details when combined", () => {
		const view = gpuView({ usage: 39, temperature: 64, memoryUsed: 6.1 * GiB, memoryTotal: 16 * GiB }, [], { layout: "combined", style: "neon" });
		expect(view).toMatchObject({ style: "neon", title: "GPU 64°C", value: "39%", detail: "6.1 GB / 16.0 GB" });
		expect(cpuView({ usage: 5, maxCore: 64, cores: 8 }, [], { layout: "combined" })).toMatchObject({ title: "CPU", detail: "Top core 64%" });
	});

	it("uses a custom label and falls back to classic for unknown styles", () => {
		expect(memoryView({ used: 8 * GiB, total: 16 * GiB }, [], { label: "Mem", style: "fancy" as never })).toMatchObject({
			title: "Mem",
			value: "50%",
			style: "classic",
		});
	});

	it("shows pending and unavailable readings", () => {
		expect(gpuView(undefined, [], {})).toMatchObject({ value: "…", level: "idle" });
		expect(gpuView(null, [], {})).toMatchObject({ value: "N/A", level: "idle" });
		expect(diskView(null, [], {}, "C:")).toMatchObject({ title: "C:", value: "N/A" });
	});

	it("shows disk usage and free space", () => {
		const view = diskView({ path: "C:\\", label: "C:", used: 540 * GiB, free: 390 * GiB, total: 1000 * GiB }, [], { layout: "combined" });
		expect(view).toMatchObject({ title: "C:", value: "58%", detail: "390 GB free" });
	});

	it("shows network rates, scaled to the recent peak unless a full scale is set", () => {
		const sample = { down: 3.6 * 2 ** 20, up: 100 * 1024 };
		const auto = networkView(sample, { down: [sample.down], up: [] }, { colorize: true });
		expect(auto).toMatchObject({ title: "NET ↓", value: "3.6 MB/s", level: "normal", fraction: 0.8 });

		const fixed = networkView(sample, { down: [], up: [] }, { fullScale: "40" }); // 40 Mbit/s = 5 MB/s
		expect(fixed.level).toBe("warning");

		const up = networkView(sample, { down: [], up: [] }, { direction: "up", layout: "combined" });
		expect(up).toMatchObject({ title: "NET ↑", value: "100 KB/s", detail: "↓ 3.6 MB/s" });
	});
});

describe("overview", () => {
	it("defaults to CPU, GPU, RAM and disk, in a fixed order", () => {
		expect(overviewMetrics({})).toEqual(["cpu", "gpu", "memory", "disk"]);
		expect(overviewMetrics({ metrics: ["network", "cpu", "bogus" as never] })).toEqual(["cpu", "network"]);
	});

	it("builds one row per metric with its own colour", () => {
		const view = overviewView(
			{ cpu: { usage: 95, maxCore: 100, cores: 4 }, gpu: null, memory: undefined },
			{ metrics: ["cpu", "gpu", "memory"] },
		);
		expect(view.rows).toEqual([
			{ label: "CPU", value: "95%", fraction: 0.95, level: "critical" },
			{ label: "GPU", value: "N/A", fraction: 0, level: "idle" },
			{ label: "RAM", value: "…", fraction: 0, level: "idle" },
		]);
	});
});
