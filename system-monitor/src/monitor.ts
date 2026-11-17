import { cpuTemperature, cpuTimes, type CpuTimes, cpuUsage } from "./metrics/cpu";
import { listDrives, readDisk, systemDrive } from "./metrics/disk";
import { run } from "./metrics/exec";
import { GpuReader } from "./metrics/gpu";
import { readMemory } from "./metrics/memory";
import { type Counters, networkRate, readCounters } from "./metrics/network";
import type { CpuSample, DiskSample, Drive, GpuSample, MemorySample, MetricKind, NetworkSample } from "./metrics/types";

/** Points of history kept per series: enough for a key-wide graph. */
export const HISTORY_LENGTH = 40;

/** A metric is sampled while a key has asked for it within this window. */
const DEMAND_WINDOW = 5_000;

/** How often (in ticks) each metric is sampled; disks barely move. */
const EVERY: Record<MetricKind, number> = { cpu: 1, memory: 2, network: 1, gpu: 2, disk: 10 };
const DRIVE_LIST_EVERY = 30;

/** Where the monitor reads each metric from; swapped out in tests. */
export type Sources = {
	cpuTimes: () => CpuTimes;
	cpuTemperature: () => Promise<number | undefined>;
	memory: () => Promise<MemorySample>;
	gpu: () => Promise<GpuSample | undefined>;
	networkCounters: () => Promise<Counters | undefined>;
	drives: () => Promise<Drive[]>;
	disk: (drive: Drive) => Promise<DiskSample | undefined>;
	systemDrive: string;
	now: () => number;
	stop?: () => void;
};

export function systemSources(platform: NodeJS.Platform = process.platform): Sources {
	const gpu = new GpuReader({ platform, run });
	return {
		cpuTimes: () => cpuTimes(),
		cpuTemperature: () => cpuTemperature(platform),
		memory: () => readMemory(platform, run),
		gpu: () => gpu.read(),
		networkCounters: () => readCounters({ platform, run }),
		drives: () => listDrives({ platform }),
		disk: (drive) => readDisk(drive),
		systemDrive: systemDrive(platform),
		now: () => Date.now(),
		stop: () => gpu.stop(),
	};
}

/** History series names: one per metric, one per drive, and one per network direction. */
export type Series = "cpu" | "gpu" | "memory" | "net:down" | "net:up" | `disk:${string}`;

/**
 * The single source of system readings for every key.
 *
 * Keys read through the getters, which also register demand: only metrics a
 * visible key has asked for recently are sampled on each tick, so a deck
 * showing just a CPU key never spawns nvidia-smi. Listeners are told after
 * every tick so keys can re-render.
 */
export class SystemMonitor {
	readonly #sources: Sources;
	readonly #listeners = new Set<() => void>();
	readonly #demand = new Map<string, number>();
	readonly #history = new Map<Series, number[]>();
	readonly #inFlight = new Set<string>();

	#tick = 0;
	#kicked = false;
	#timer: ReturnType<typeof setInterval> | undefined;

	#cpu: CpuSample | undefined;
	#cpuTimes: CpuTimes | undefined;
	#memory: MemorySample | undefined;
	#gpu: GpuSample | null | undefined;
	#network: NetworkSample | undefined;
	#counters: { at: number; value: Counters } | undefined;
	#drives: Drive[] | undefined;
	readonly #disks = new Map<string, DiskSample | null>();

	constructor(sources: Sources) {
		this.#sources = sources;
	}

	// ------------------------------------------------------------------ //
	// Readings (each also marks the metric as wanted)
	// ------------------------------------------------------------------ //
	cpu(): CpuSample | undefined {
		this.#want("cpu");
		return this.#cpu;
	}

	memory(): MemorySample | undefined {
		this.#want("memory");
		return this.#memory;
	}

	/** `null` once it's clear no GPU can be read on this machine. */
	gpu(): GpuSample | null | undefined {
		this.#want("gpu");
		return this.#gpu;
	}

	network(): NetworkSample | undefined {
		this.#want("network");
		return this.#network;
	}

	/** Usage of the drive at `path` (default: the system drive); `null` if it can't be read. */
	disk(path?: string): DiskSample | null | undefined {
		const target = path || this.#sources.systemDrive;
		this.#want(`disk:${target}`);
		return this.#disks.get(target);
	}

	/** Known drives, system drive first; empty until first listed. */
	drives(): Drive[] {
		this.#want("drives");
		return this.#drives ?? [];
	}

	history(series: Series): number[] {
		return this.#history.get(series) ?? [];
	}

	get systemDrive(): string {
		return this.#sources.systemDrive;
	}

	// ------------------------------------------------------------------ //
	// Lifecycle
	// ------------------------------------------------------------------ //
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Sample on an interval while `active()` says anything is on screen. */
	start(intervalMs: number, active: () => boolean): void {
		this.stop();
		this.#timer = setInterval(() => {
			if (active()) {
				void this.tick();
			}
		}, intervalMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	dispose(): void {
		this.stop();
		this.#sources.stop?.();
	}

	/** Sample whatever is due, then notify listeners. */
	async tick(): Promise<void> {
		const tick = this.#tick++;
		// Due on its schedule, or straight away while there's no reading yet.
		const due = (key: string, every: number, missing: boolean) => this.#wanted(key) && (missing || tick % every === 0);
		const jobs: Promise<void>[] = [];

		if (due("cpu", EVERY.cpu, !this.#cpu)) jobs.push(this.#once("cpu", () => this.#sampleCpu()));
		if (due("memory", EVERY.memory, !this.#memory)) jobs.push(this.#once("memory", () => this.#sampleMemory()));
		if (due("gpu", EVERY.gpu, this.#gpu === undefined)) jobs.push(this.#once("gpu", () => this.#sampleGpu()));
		if (due("network", EVERY.network, !this.#network)) jobs.push(this.#once("network", () => this.#sampleNetwork()));
		if (this.#wanted("drives") && (this.#drives === undefined || tick % DRIVE_LIST_EVERY === 0)) {
			jobs.push(this.#once("drives", () => this.#listDrives()));
		}
		for (const key of this.#demand.keys()) {
			if (key.startsWith("disk:") && due(key, EVERY.disk, !this.#disks.has(key.slice(5)))) {
				jobs.push(this.#once(key, () => this.#sampleDisk(key.slice(5))));
			}
		}

		await Promise.all(jobs);
		this.#notify();
	}

	/** Re-sample `kind` right away (a key press), regardless of schedule. */
	async refresh(kind: MetricKind, path?: string): Promise<void> {
		switch (kind) {
			case "cpu":
				await this.#once("cpu", () => this.#sampleCpu());
				break;
			case "memory":
				await this.#once("memory", () => this.#sampleMemory());
				break;
			case "gpu":
				await this.#once("gpu", () => this.#sampleGpu());
				break;
			case "network":
				await this.#once("network", () => this.#sampleNetwork());
				break;
			case "disk": {
				const target = path || this.#sources.systemDrive;
				await this.#once(`disk:${target}`, () => this.#sampleDisk(target));
				break;
			}
		}
		this.#notify();
	}

	/** Re-list drives now (the property inspector asked). */
	async refreshDrives(): Promise<Drive[]> {
		await this.#once("drives", () => this.#listDrives());
		return this.#drives ?? [];
	}

	// ------------------------------------------------------------------ //
	// Sampling
	// ------------------------------------------------------------------ //
	async #sampleCpu(): Promise<void> {
		const times = this.#sources.cpuTimes();
		const previous = this.#cpuTimes;
		this.#cpuTimes = times;
		if (!previous) {
			return;
		}
		const { usage, maxCore } = cpuUsage(previous, times);
		this.#cpu = { usage, maxCore, cores: times.length, temperature: await this.#sources.cpuTemperature() };
		this.#push("cpu", usage);
	}

	async #sampleMemory(): Promise<void> {
		const memory = await this.#sources.memory();
		this.#memory = memory;
		this.#push("memory", memory.total > 0 ? (memory.used / memory.total) * 100 : 0);
	}

	async #sampleGpu(): Promise<void> {
		const gpu = await this.#sources.gpu();
		if (gpu) {
			this.#gpu = gpu;
			this.#push("gpu", gpu.usage);
		} else if (!this.#gpu) {
			this.#gpu = null;
		}
	}

	async #sampleNetwork(): Promise<void> {
		const value = await this.#sources.networkCounters();
		const at = this.#sources.now();
		const previous = this.#counters;
		if (!value) {
			return;
		}
		this.#counters = { at, value };
		if (!previous) {
			return;
		}
		const rate = networkRate(previous.value, value, at - previous.at);
		this.#network = rate;
		this.#push("net:down", rate.down);
		this.#push("net:up", rate.up);
	}

	async #listDrives(): Promise<void> {
		this.#drives = await this.#sources.drives();
	}

	async #sampleDisk(path: string): Promise<void> {
		this.#drives ??= await this.#sources.drives();
		const drives = this.#drives;
		const drive = drives.find((d) => d.path === path) ?? { path, label: path };
		const sample = await this.#sources.disk(drive);
		this.#disks.set(path, sample ?? null);
		if (sample) {
			this.#push(`disk:${path}`, (sample.used / (sample.used + sample.free || 1)) * 100);
		}
	}

	// ------------------------------------------------------------------ //
	// Helpers
	// ------------------------------------------------------------------ //
	#want(key: string): void {
		const first = !this.#demand.has(key);
		this.#demand.set(key, this.#sources.now());
		if (first && !this.#kicked) {
			// Don't make a newly shown key wait for the next tick.
			this.#kicked = true;
			queueMicrotask(() => {
				this.#kicked = false;
				void this.tick();
			});
		}
	}

	#wanted(key: string): boolean {
		const at = this.#demand.get(key);
		if (at === undefined) {
			return false;
		}
		if (this.#sources.now() - at > DEMAND_WINDOW) {
			this.#demand.delete(key);
			return false;
		}
		return true;
	}

	/** Run `job` unless the same sample is still in flight (a slow command). */
	async #once(key: string, job: () => Promise<void>): Promise<void> {
		if (this.#inFlight.has(key)) {
			return;
		}
		this.#inFlight.add(key);
		try {
			await job();
		} catch {
			// A failed sample just leaves the previous reading in place.
		} finally {
			this.#inFlight.delete(key);
		}
	}

	#push(series: Series, value: number): void {
		const values = this.#history.get(series) ?? [];
		values.push(value);
		if (values.length > HISTORY_LENGTH) {
			values.splice(0, values.length - HISTORY_LENGTH);
		}
		this.#history.set(series, values);
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}
}
