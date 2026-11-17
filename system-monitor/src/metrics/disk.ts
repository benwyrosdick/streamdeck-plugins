import { readdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";

import { readText } from "./exec";
import type { DiskSample, Drive } from "./types";

/** Give up on a volume (e.g. a sleeping network share) after this long. */
const STATFS_TIMEOUT = 2_000;

export type DiskDeps = {
	platform: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	statfs?: (path: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
	readdir?: (path: string) => Promise<string[]>;
	realpath?: (path: string) => Promise<string>;
	readText?: (path: string) => Promise<string | undefined>;
};

/** The drive a Disk key shows until another is chosen: the system drive. */
export function systemDrive(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
	return platform === "win32" ? `${(env.SystemDrive ?? "C:").replace(/\\$/, "")}\\` : "/";
}

/** Usage of the volume mounted at `drive.path`, or `undefined` if it can't be read. */
export async function readDisk(drive: Drive, deps: Pick<DiskDeps, "statfs"> = {}): Promise<DiskSample | undefined> {
	const stat = deps.statfs ?? statfs;
	try {
		const s = await withTimeout(stat(drive.path), STATFS_TIMEOUT);
		if (!s || s.blocks <= 0) {
			return undefined;
		}
		const used = (s.blocks - s.bfree) * s.bsize;
		const free = s.bavail * s.bsize;
		return { ...drive, used, free, total: s.blocks * s.bsize };
	} catch {
		return undefined;
	}
}

/** Mounted volumes worth offering, system drive first. */
export async function listDrives(deps: DiskDeps): Promise<Drive[]> {
	switch (deps.platform) {
		case "win32":
			return windowsDrives(deps);
		case "darwin":
			return macDrives(deps);
		default:
			return linuxDrives(deps);
	}
}

/** Drive letters C–Z that have a mounted filesystem. */
async function windowsDrives(deps: DiskDeps): Promise<Drive[]> {
	const system = systemDrive("win32", deps.env);
	const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`);
	const present = await Promise.all(
		letters.map(async (root) => ((await readDisk({ path: root, label: "" }, deps)) ? root : undefined)),
	);
	const roots = present.filter((root): root is string => !!root);
	if (!roots.includes(system)) {
		roots.unshift(system);
	}
	return sortSystemFirst(
		roots.map((root) => ({ path: root, label: root.slice(0, 2) })),
		system,
	);
}

/** `/` (named after its /Volumes alias, e.g. "Macintosh HD") plus everything else in /Volumes. */
async function macDrives(deps: DiskDeps): Promise<Drive[]> {
	const list = deps.readdir ?? readdir;
	const resolve = deps.realpath ?? realpath;
	let names: string[] = [];
	try {
		names = await list("/Volumes");
	} catch {
		// Fall back to the root volume alone.
	}

	let rootLabel = "Disk";
	const drives: Drive[] = [];
	for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
		const mount = path.posix.join("/Volumes", name);
		const target = await resolve(mount).catch(() => mount);
		if (target === "/") {
			rootLabel = name;
		} else {
			drives.push({ path: mount, label: name });
		}
	}
	return [{ path: "/", label: rootLabel }, ...drives];
}

/** Filesystems pseudo or read-only enough to never be worth a key. */
const IGNORED_FS = new Set(["squashfs", "iso9660", "overlay", "tmpfs", "devtmpfs", "ramfs", "erofs"]);

/** Block-device mounts from /proc/mounts, one per device (btrfs subvolumes share one). */
async function linuxDrives(deps: DiskDeps): Promise<Drive[]> {
	const text = await (deps.readText ?? readText)("/proc/mounts");
	return text ? parseMounts(text) : [{ path: "/", label: "/" }];
}

export function parseMounts(text: string): Drive[] {
	const byDevice = new Map<string, string>();
	for (const line of text.split("\n")) {
		const [device, rawMount, fs] = line.split(" ");
		if (!device?.startsWith("/dev/") || device.startsWith("/dev/loop") || IGNORED_FS.has(fs ?? "")) {
			continue;
		}
		// /proc/mounts escapes spaces and the like as octal.
		const mount = rawMount.replace(/\\(\d{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
		if (mount.startsWith("/boot")) {
			continue;
		}
		const existing = byDevice.get(device);
		if (existing === undefined || mount.length < existing.length) {
			byDevice.set(device, mount);
		}
	}
	const mounts = [...byDevice.values()];
	if (!mounts.includes("/")) {
		mounts.push("/");
	}
	return sortSystemFirst(
		mounts.map((mount) => ({ path: mount, label: mount === "/" ? "/" : path.posix.basename(mount) })),
		"/",
	);
}

function sortSystemFirst(drives: Drive[], system: string): Drive[] {
	return [...drives].sort((a, b) => Number(b.path === system) - Number(a.path === system) || a.path.localeCompare(b.path));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
