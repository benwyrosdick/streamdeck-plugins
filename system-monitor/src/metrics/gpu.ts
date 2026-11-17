import { type ChildProcess, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { clampPercent, readText, toNumber } from "./exec";
import type { GpuSample, Runner } from "./types";

const MIB = 1024 * 1024;

export type GpuDeps = {
	platform: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	run: Runner;
	/** Root of the Linux DRM class (overridable for tests). */
	drm?: string;
	/** Starts the Windows performance-counter reader (overridable for tests). */
	windowsCounters?: () => WindowsGpuCounters;
};

/** Where `nvidia-smi` lives; Stream Deck launches plugins with a minimal PATH. */
export function nvidiaSmiPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
	switch (platform) {
		case "win32":
			return [
				path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe"),
				path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
			];
		case "darwin":
			return [];
		default:
			return ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "nvidia-smi"];
	}
}

const NVIDIA_QUERY = "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total";

/** One row per GPU of `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(stdout: string): GpuSample[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.split(",").map((s) => s.trim()))
		.filter((cols) => cols.length >= 5)
		.flatMap(([name, util, temp, used, total]) => {
			const usage = toNumber(util);
			if (usage === undefined) {
				return [];
			}
			const memoryUsed = toNumber(used);
			const memoryTotal = toNumber(total);
			return [
				{
					name,
					usage: clampPercent(usage),
					temperature: toNumber(temp),
					memoryUsed: memoryUsed === undefined ? undefined : memoryUsed * MIB,
					memoryTotal: memoryTotal === undefined ? undefined : memoryTotal * MIB,
				},
			];
		});
}

/**
 * `ioreg -r -d 1 -w 0 -c IOAccelerator` (macOS): each GPU's
 * PerformanceStatistics. Apple silicon reports utilisation and in-use
 * (unified) memory; Intel Macs with discrete GPUs also report VRAM.
 * Returns the busiest GPU.
 */
export function parseIoreg(stdout: string): GpuSample | undefined {
	const samples: GpuSample[] = [];
	for (const block of stdout.split(/^\+-o /m).slice(1)) {
		const number = (key: string) => {
			const match = new RegExp(`"${key}"=(\\d+)`).exec(block);
			return match ? Number(match[1]) : undefined;
		};
		const usage = number("Device Utilization %") ?? number("GPU Activity\\(%\\)");
		if (usage === undefined) {
			continue;
		}
		const vramFree = number("vramFreeBytes");
		const vramTotal = number("VRAM,totalMB");
		samples.push({
			usage: clampPercent(usage),
			memoryUsed: vramTotal && vramFree !== undefined ? vramTotal * MIB - vramFree : number("In use system memory"),
			memoryTotal: vramTotal ? vramTotal * MIB : undefined,
		});
	}
	return samples.sort((a, b) => b.usage - a.usage)[0];
}

/** AMD on Linux: amdgpu exposes busy %, VRAM and temperature through sysfs. */
export async function readAmdSysfs(drm = "/sys/class/drm"): Promise<GpuSample | undefined> {
	let cards: string[];
	try {
		cards = (await readdir(drm)).filter((name) => /^card\d+$/.test(name));
	} catch {
		return undefined;
	}
	for (const card of cards.sort()) {
		const device = path.join(drm, card, "device");
		const usage = toNumber(await readText(path.join(device, "gpu_busy_percent")));
		if (usage === undefined) {
			continue;
		}
		let temperature: number | undefined;
		try {
			for (const hwmon of await readdir(path.join(device, "hwmon"))) {
				const milli = toNumber(await readText(path.join(device, "hwmon", hwmon, "temp1_input")));
				if (milli !== undefined) {
					temperature = Math.round(milli / 1000);
					break;
				}
			}
		} catch {
			// No hwmon for this card.
		}
		return {
			usage: clampPercent(usage),
			temperature,
			memoryUsed: toNumber(await readText(path.join(device, "mem_info_vram_used"))),
			memoryTotal: toNumber(await readText(path.join(device, "mem_info_vram_total"))),
		};
	}
	return undefined;
}

/**
 * Reads the GPU through whichever backend works on this machine:
 * `nvidia-smi` for NVIDIA cards, then the platform's own source —
 * IOAccelerator on macOS, amdgpu sysfs on Linux, and the GPU performance
 * counters (any vendor) on Windows. The first backend that answers is
 * remembered.
 */
export class GpuReader {
	readonly #deps: GpuDeps;
	#nvidia: string | null | undefined;
	#windows: WindowsGpuCounters | undefined;

	constructor(deps: GpuDeps) {
		this.#deps = deps;
	}

	/** The current reading; `undefined` when no backend can see a GPU. */
	async read(): Promise<GpuSample | undefined> {
		const nvidia = await this.#readNvidia();
		if (nvidia) {
			return nvidia;
		}
		const { platform } = this.#deps;
		if (platform === "darwin") {
			const result = await this.#deps.run("/usr/sbin/ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], 3_000);
			return result.ok ? parseIoreg(result.stdout) : undefined;
		}
		if (platform === "win32") {
			this.#windows ??= (this.#deps.windowsCounters ?? (() => new WindowsGpuCounters()))();
			return this.#windows.latest();
		}
		return readAmdSysfs(this.#deps.drm);
	}

	/** Release background resources (the Windows counter reader). */
	stop(): void {
		this.#windows?.stop();
		this.#windows = undefined;
	}

	async #readNvidia(): Promise<GpuSample | undefined> {
		if (this.#nvidia === null) {
			return undefined;
		}
		const candidates = this.#nvidia ? [this.#nvidia] : nvidiaSmiPaths(this.#deps.platform, this.#deps.env);
		for (const file of candidates) {
			const result = await this.#deps.run(file, [NVIDIA_QUERY, "--format=csv,noheader,nounits"], 3_000);
			const sample = result.ok ? parseNvidiaSmi(result.stdout)[0] : undefined;
			if (sample) {
				this.#nvidia = file;
				return sample;
			}
		}
		// Not found anywhere: stop probing. A transient failure of a known path is retried.
		if (!this.#nvidia) {
			this.#nvidia = null;
		}
		return undefined;
	}
}

/**
 * The Windows GPU performance counters (what Task Manager shows), read by a
 * single long-lived PowerShell process that prints a JSON line every couple
 * of seconds — starting PowerShell per sample would cost more CPU than the
 * key is worth. The script exits on its own if the plugin goes away.
 */
export class WindowsGpuCounters {
	#child: ChildProcess | undefined;
	#latest: GpuSample | undefined;
	#buffer = "";
	#stopped = false;
	#restarts = 0;

	constructor() {
		this.#start();
	}

	latest(): GpuSample | undefined {
		return this.#latest;
	}

	stop(): void {
		this.#stopped = true;
		this.#child?.kill();
		this.#child = undefined;
	}

	#start(): void {
		const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsCounterScript(process.pid)], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.#buffer += chunk;
			const lines = this.#buffer.split(/\r?\n/);
			this.#buffer = lines.pop() ?? "";
			for (const line of lines) {
				const sample = parseWindowsCounters(line);
				if (sample) {
					this.#latest = sample;
					this.#restarts = 0;
				}
			}
		});
		child.on("error", () => undefined);
		child.on("exit", () => {
			if (this.#child === child) {
				this.#child = undefined;
			}
			// Restart with backoff, giving up if it keeps dying (counters unavailable).
			if (!this.#stopped && this.#restarts < 5) {
				this.#restarts++;
				setTimeout(() => !this.#stopped && this.#start(), 5_000 * this.#restarts).unref();
			}
		});
	}
}

export function parseWindowsCounters(line: string): GpuSample | undefined {
	try {
		const data = JSON.parse(line) as { usage?: number; used?: number; total?: number };
		if (typeof data.usage !== "number") {
			return undefined;
		}
		return {
			usage: clampPercent(data.usage),
			memoryUsed: data.used || undefined,
			memoryTotal: data.total || undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Sums 3D-engine utilisation per adapter (Task Manager's "GPU" figure) and
 * reports the busiest adapter, its dedicated memory in use, and the largest
 * adapter memory size from the display-adapter registry class.
 */
export function windowsCounterScript(parentPid: number): string {
	return `
$ErrorActionPreference = 'SilentlyContinue'
$total = 0
Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  $size = (Get-ItemProperty $_.PSPath).'HardwareInformation.qwMemorySize'
  if ($size -gt $total) { $total = [double]$size }
}
while ($true) {
  if (-not (Get-Process -Id ${parentPid})) { exit }
  $samples = (Get-Counter -Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage' -SampleInterval 2 -MaxSamples 1).CounterSamples
  if (-not $samples) { Start-Sleep -Seconds 2; continue }
  $util = @{}
  $mem = @{}
  foreach ($s in $samples) {
    $luid = [regex]::Match($s.InstanceName, '(?i)luid_0x[0-9a-f]+_0x[0-9a-f]+').Value
    if ($s.Path -like '*\\gpu engine(*') { $util[$luid] += $s.CookedValue } else { $mem[$luid] += $s.CookedValue }
  }
  $busiest = $util.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
  $usage = 0; $used = 0
  if ($busiest) { $usage = [double]$busiest.Value; $used = [double]$mem[$busiest.Key] }
  [Console]::Out.WriteLine((@{ usage = $usage; used = $used; total = $total } | ConvertTo-Json -Compress))
}
`;
}
