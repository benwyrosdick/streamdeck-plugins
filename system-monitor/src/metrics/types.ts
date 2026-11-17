/** The metrics the plugin can show. */
export type MetricKind = "cpu" | "gpu" | "memory" | "disk" | "network";

export type CpuSample = {
	/** Overall utilisation, 0–100. */
	usage: number;
	/** Utilisation of the busiest logical core, 0–100. */
	maxCore: number;
	/** Logical core count. */
	cores: number;
	/** Package temperature in °C, where the OS exposes it without elevation. */
	temperature?: number;
};

export type GpuSample = {
	name?: string;
	/** Utilisation, 0–100. */
	usage: number;
	/** Core temperature in °C. */
	temperature?: number;
	/** Dedicated (or, on unified memory, in-use) GPU memory, in bytes. */
	memoryUsed?: number;
	memoryTotal?: number;
};

export type MemorySample = {
	/** Bytes in use, matching what the OS's own monitor reports. */
	used: number;
	total: number;
};

/** A mounted volume that can be shown on a Disk key. */
export type Drive = {
	/** Mount point (`/`, `/Volumes/Backup`) or drive root (`C:\`); the settings value. */
	path: string;
	/** Short name for the key: `C:`, `Macintosh HD`, `data`. */
	label: string;
};

export type DiskSample = Drive & {
	/** Bytes used. */
	used: number;
	/** Bytes available to the user. */
	free: number;
	total: number;
};

export type NetworkSample = {
	/** Receive rate, bytes per second. */
	down: number;
	/** Transmit rate, bytes per second. */
	up: number;
};

/** Running a command: resolves (never rejects) with its output. */
export type RunResult = { ok: boolean; stdout: string; stderr: string; missing?: boolean };
export type Runner = (file: string, args: string[], timeout: number) => Promise<RunResult>;
