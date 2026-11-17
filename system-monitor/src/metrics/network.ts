import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { readText, toNumber } from "./exec";
import type { NetworkSample, Runner } from "./types";

/** Cumulative bytes received / sent across physical interfaces. */
export type Counters = { rx: number; tx: number };

export type NetworkDeps = {
	platform: NodeJS.Platform;
	run: Runner;
	/** Root of the Linux sysfs network class (overridable for tests). */
	sysfs?: string;
};

export async function readCounters({ platform, run, sysfs = "/sys/class/net" }: NetworkDeps): Promise<Counters | undefined> {
	switch (platform) {
		case "win32": {
			const result = await run(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "netstat.exe"), ["-e"], 3_000);
			return result.ok ? parseNetstatE(result.stdout) : undefined;
		}
		case "darwin": {
			const result = await run("/usr/sbin/netstat", ["-ibn"], 3_000);
			return result.ok ? parseNetstatIbn(result.stdout) : undefined;
		}
		default:
			return linuxCounters(sysfs);
	}
}

/**
 * Bytes per second between two counter readings. Windows' counters are
 * 32-bit and wrap; any other decrease (an interface went away) reads as idle.
 */
export function networkRate(previous: Counters, next: Counters, elapsedMs: number): NetworkSample {
	const delta = (before: number, after: number) => {
		let d = after - before;
		if (d < 0) {
			d = before < 2 ** 32 ? d + 2 ** 32 : 0;
		}
		return elapsedMs > 0 ? (d * 1000) / elapsedMs : 0;
	};
	return { down: delta(previous.rx, next.rx), up: delta(previous.tx, next.tx) };
}

/**
 * `netstat -e` (Windows): the first statistics row is bytes received / sent,
 * whatever the display language calls it.
 */
export function parseNetstatE(stdout: string): Counters | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\D+?\s(\d+)\s+(\d+)\s*$/.exec(line);
		if (match) {
			return { rx: Number(match[1]), tx: Number(match[2]) };
		}
	}
	return undefined;
}

/**
 * `netstat -ibn` (macOS): sum the link-level rows of the physical `enN`
 * interfaces (Wi-Fi, Ethernet), skipping tunnels, bridges and loopback so
 * VPN traffic isn't counted twice. Columns are located from the header,
 * counted from the right, because the Address column is sometimes blank.
 */
export function parseNetstatIbn(stdout: string): Counters | undefined {
	const lines = stdout.split("\n");
	const header = lines[0]?.trim().split(/\s+/) ?? [];
	const ibytes = header.indexOf("Ibytes");
	const obytes = header.indexOf("Obytes");
	if (ibytes < 0 || obytes < 0) {
		return undefined;
	}
	const fromEnd = (index: number) => header.length - index;

	let rx = 0;
	let tx = 0;
	let found = false;
	for (const line of lines.slice(1)) {
		const cols = line.trim().split(/\s+/);
		if (!/^en\d+$/.test(cols[0] ?? "") || !cols[2]?.startsWith("<Link#")) {
			continue;
		}
		const inBytes = toNumber(cols[cols.length - fromEnd(ibytes)]);
		const outBytes = toNumber(cols[cols.length - fromEnd(obytes)]);
		if (inBytes !== undefined && outBytes !== undefined) {
			rx += inBytes;
			tx += outBytes;
			found = true;
		}
	}
	return found ? { rx, tx } : undefined;
}

/** Physical interfaces only: virtual ones (lo, docker, veth, VPN tunnels) live under devices/virtual. */
async function linuxCounters(sysfs: string): Promise<Counters | undefined> {
	let names: string[];
	try {
		names = await readdir(sysfs);
	} catch {
		return undefined;
	}
	let rx = 0;
	let tx = 0;
	let found = false;
	for (const name of names) {
		const target = await realpath(path.join(sysfs, name)).catch(() => "");
		if (!target || target.includes("/virtual/")) {
			continue;
		}
		const inBytes = toNumber(await readText(path.join(sysfs, name, "statistics", "rx_bytes")));
		const outBytes = toNumber(await readText(path.join(sysfs, name, "statistics", "tx_bytes")));
		if (inBytes !== undefined && outBytes !== undefined) {
			rx += inBytes;
			tx += outBytes;
			found = true;
		}
	}
	return found ? { rx, tx } : undefined;
}
