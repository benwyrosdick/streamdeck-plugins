import os from "node:os";

import type { MemorySample, Runner } from "./types";

/**
 * Memory in use. Windows and Linux report available memory accurately
 * through Node; on macOS `os.freemem()` ignores reclaimable cache (so the
 * key would sit near 100%), so the figure comes from `vm_stat` instead.
 */
export async function readMemory(platform: NodeJS.Platform, run: Runner): Promise<MemorySample> {
	const total = os.totalmem();
	if (platform === "darwin") {
		const result = await run("/usr/bin/vm_stat", [], 3_000);
		const used = result.ok ? parseVmStat(result.stdout) : undefined;
		if (used !== undefined) {
			return { used: Math.min(used, total), total };
		}
	}
	return { used: total - os.freemem(), total };
}

/**
 * "Memory Used" as Activity Monitor computes it: app memory (anonymous pages
 * that aren't purgeable) plus wired plus compressed.
 */
export function parseVmStat(stdout: string): number | undefined {
	const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
	if (!pageSize) {
		return undefined;
	}
	const pages = (label: string): number | undefined => {
		const match = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(stdout);
		return match ? Number(match[1]) : undefined;
	};
	const wired = pages("Pages wired down");
	const compressed = pages("Pages occupied by compressor") ?? 0;
	const anonymous = pages("Anonymous pages");
	const purgeable = pages("Pages purgeable") ?? 0;
	const app = anonymous !== undefined ? anonymous - purgeable : pages("Pages active");
	if (wired === undefined || app === undefined) {
		return undefined;
	}
	return (Math.max(0, app) + wired + compressed) * pageSize;
}
