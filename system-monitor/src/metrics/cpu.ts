import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";

import { clampPercent, readText, toNumber } from "./exec";

/** Cumulative busy/total CPU time per logical core, from `os.cpus()`. */
export type CpuTimes = { idle: number; total: number }[];

export function cpuTimes(cpus: Pick<os.CpuInfo, "times">[] = os.cpus()): CpuTimes {
	return cpus.map(({ times }) => ({
		idle: times.idle,
		total: times.user + times.nice + times.sys + times.idle + times.irq,
	}));
}

/** Utilisation between two snapshots: overall, and for the busiest core. */
export function cpuUsage(previous: CpuTimes, next: CpuTimes): { usage: number; maxCore: number } {
	let idle = 0;
	let total = 0;
	let maxCore = 0;
	next.forEach((core, i) => {
		const before = previous[i];
		if (!before) {
			return;
		}
		const coreIdle = core.idle - before.idle;
		const coreTotal = core.total - before.total;
		if (coreTotal <= 0) {
			return;
		}
		idle += coreIdle;
		total += coreTotal;
		maxCore = Math.max(maxCore, 1 - coreIdle / coreTotal);
	});
	return {
		usage: total > 0 ? clampPercent((1 - idle / total) * 100) : 0,
		maxCore: clampPercent(maxCore * 100),
	};
}

/** hwmon drivers that report the CPU package temperature as `temp1`. */
const CPU_HWMON = new Set(["coretemp", "k10temp", "zenpower", "cpu_thermal", "soc_thermal"]);

/**
 * The CPU package temperature on Linux, from hwmon. macOS and Windows don't
 * expose CPU temperature without elevated helpers, so they report none.
 */
export async function cpuTemperature(platform: NodeJS.Platform, root = "/sys/class/hwmon"): Promise<number | undefined> {
	if (platform !== "linux") {
		return undefined;
	}
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const name = (await readText(path.join(root, entry, "name")))?.trim();
		if (name && CPU_HWMON.has(name)) {
			const milli = toNumber(await readText(path.join(root, entry, "temp1_input")));
			if (milli !== undefined) {
				return Math.round(milli / 1000);
			}
		}
	}
	return undefined;
}
