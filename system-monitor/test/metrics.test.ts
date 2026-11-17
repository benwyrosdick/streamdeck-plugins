import { describe, expect, it, vi } from "vitest";

import { cpuTimes, cpuUsage } from "../src/metrics/cpu";
import { listDrives, parseMounts, readDisk, systemDrive } from "../src/metrics/disk";
import { GpuReader, nvidiaSmiPaths, parseIoreg, parseNvidiaSmi, parseWindowsCounters, type WindowsGpuCounters } from "../src/metrics/gpu";
import { parseVmStat } from "../src/metrics/memory";
import { networkRate, parseNetstatE, parseNetstatIbn } from "../src/metrics/network";
import type { RunResult } from "../src/metrics/types";

const GiB = 2 ** 30;
const MiB = 2 ** 20;

describe("cpu", () => {
	it("computes overall and busiest-core utilisation between snapshots", () => {
		const times = (busy: number[], idle: number[]) =>
			cpuTimes(busy.map((user, i) => ({ times: { user, nice: 0, sys: 0, idle: idle[i], irq: 0 } })));
		const before = times([100, 100], [900, 900]);
		const after = times([150, 190], [950, 910]); // core 0: 50%, core 1: 90%
		const { usage, maxCore } = cpuUsage(before, after);
		expect(usage).toBeCloseTo(70);
		expect(maxCore).toBeCloseTo(90);
	});

	it("reads idle when no time has passed", () => {
		const same = cpuTimes([{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }]);
		expect(cpuUsage(same, same)).toEqual({ usage: 0, maxCore: 0 });
	});
});

describe("memory", () => {
	it("computes Activity Monitor's Memory Used from vm_stat", () => {
		const vmStat = [
			"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
			"Pages free:                               12000.",
			"Pages active:                            400000.",
			"Pages wired down:                        100000.",
			"Pages purgeable:                          10000.",
			"Anonymous pages:                         300000.",
			"Pages occupied by compressor:             50000.",
		].join("\n");
		expect(parseVmStat(vmStat)).toBe((300000 - 10000 + 100000 + 50000) * 16384);
	});

	it("rejects unrecognised output", () => {
		expect(parseVmStat("nope")).toBeUndefined();
	});
});

describe("disk", () => {
	it("dedupes btrfs subvolumes and skips boot, loop and pseudo mounts", () => {
		const mounts = [
			"/dev/mapper/root / btrfs rw 0 0",
			"/dev/mapper/root /home btrfs rw 0 0",
			"/dev/nvme2n1p1 /boot vfat rw 0 0",
			"/dev/nvme1n1p1 /data ext4 rw 0 0",
			"/dev/loop1 /run/media/ben/bootfs1 vfat rw 0 0",
			"/dev/sdb1 /media/My\\040Drive exfat rw 0 0",
			"tmpfs /tmp tmpfs rw 0 0",
		].join("\n");
		expect(parseMounts(mounts)).toEqual([
			{ path: "/", label: "/" },
			{ path: "/data", label: "data" },
			{ path: "/media/My Drive", label: "My Drive" },
		]);
	});

	it("reads usage from statfs like df does", async () => {
		const statfs = vi.fn(async () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }));
		expect(await readDisk({ path: "/", label: "/" }, { statfs })).toEqual({
			path: "/",
			label: "/",
			used: 600 * 4096,
			free: 300 * 4096,
			total: 1000 * 4096,
		});
		expect(await readDisk({ path: "/x", label: "x" }, { statfs: async () => Promise.reject(new Error("ENOENT")) })).toBeUndefined();
	});

	it("lists Windows drive letters, system drive first", async () => {
		const present = new Set(["C:\\", "D:\\", "E:\\"]);
		const drives = await listDrives({
			platform: "win32",
			env: { SystemDrive: "D:" },
			statfs: async (p) => (present.has(p) ? { bsize: 1, blocks: 1, bfree: 0, bavail: 0 } : Promise.reject(new Error("no"))),
		});
		expect(drives).toEqual([
			{ path: "D:\\", label: "D:" },
			{ path: "C:\\", label: "C:" },
			{ path: "E:\\", label: "E:" },
		]);
	});

	it("names the Mac root volume after its /Volumes alias", async () => {
		const drives = await listDrives({
			platform: "darwin",
			readdir: async () => ["Macintosh HD", "Backup", ".timemachine"],
			realpath: async (p) => (p === "/Volumes/Macintosh HD" ? "/" : p),
		});
		expect(drives).toEqual([
			{ path: "/", label: "Macintosh HD" },
			{ path: "/Volumes/Backup", label: "Backup" },
		]);
	});

	it("defaults to the system drive", () => {
		expect(systemDrive("win32", { SystemDrive: "C:" })).toBe("C:\\");
		expect(systemDrive("win32", {})).toBe("C:\\");
		expect(systemDrive("darwin")).toBe("/");
	});
});

describe("network", () => {
	it("parses netstat -e whatever the row is called", () => {
		const english = "Interface Statistics\r\n\r\n                           Received            Sent\r\n\r\nBytes                    1234567890      987654321\r\nUnicast packets             1000            2000\r\n";
		expect(parseNetstatE(english)).toEqual({ rx: 1234567890, tx: 987654321 });
		expect(parseNetstatE(english.replace("Bytes", "Octets"))).toEqual({ rx: 1234567890, tx: 987654321 });
		expect(parseNetstatE("garbage")).toBeUndefined();
	});

	it("sums physical interfaces from netstat -ibn", () => {
		const netstat = [
			"Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
			"lo0        16384 <Link#1>                        100     0      50000      100     0      50000     0",
			"en0        1500  <Link#6>      aa:bb:cc:dd:ee:ff 2000     0    1000000     1500     0     400000     0",
			"en0        1500  192.168.1     192.168.1.10      2000     -    1000000     1500     -     400000     -",
			"en1        1500  <Link#7>      11:22:33:44:55:66   10     0       2000       10     0       1000     0",
			"utun3      1380  <Link#20>                       500     0     900000      500     0     900000     0",
		].join("\n");
		expect(parseNetstatIbn(netstat)).toEqual({ rx: 1002000, tx: 401000 });
		expect(parseNetstatIbn("Name Mtu\n")).toBeUndefined();
	});

	it("turns counters into rates and survives 32-bit wraparound", () => {
		expect(networkRate({ rx: 1000, tx: 0 }, { rx: 3000, tx: 500 }, 2000)).toEqual({ down: 1000, up: 250 });
		expect(networkRate({ rx: 2 ** 32 - 100, tx: 0 }, { rx: 900, tx: 0 }, 1000)).toEqual({ down: 1000, up: 0 });
		expect(networkRate({ rx: 2 ** 40, tx: 0 }, { rx: 5, tx: 0 }, 1000).down).toBe(0);
	});
});

describe("gpu", () => {
	it("parses nvidia-smi, tolerating [N/A] fields", () => {
		expect(parseNvidiaSmi("NVIDIA GeForce RTX 5080, 8, 46, 3738, 16303\nLaptop GPU, 12, [N/A], 100, [N/A]\n")).toEqual([
			{ name: "NVIDIA GeForce RTX 5080", usage: 8, temperature: 46, memoryUsed: 3738 * MiB, memoryTotal: 16303 * MiB },
			{ name: "Laptop GPU", usage: 12, temperature: undefined, memoryUsed: 100 * MiB, memoryTotal: undefined },
		]);
	});

	it("parses ioreg PerformanceStatistics, picking the busiest GPU", () => {
		const ioreg = [
			'+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X>',
			'    "PerformanceStatistics" = {"In use system memory"=1073741824,"Device Utilization %"=37,"Renderer Utilization %"=30}',
			'+-o IntelAccelerator  <class IntelAccelerator>',
			'    "PerformanceStatistics" = {"Device Utilization %"=5,"vramFreeBytes"=1073741824}',
			'    "VRAM,totalMB" = 1536',
		].join("\n");
		expect(parseIoreg(ioreg)).toEqual({ usage: 37, memoryUsed: GiB, memoryTotal: undefined });
		expect(parseIoreg("+-o Nothing\n")).toBeUndefined();
	});

	it("parses the Windows counter reader's JSON lines", () => {
		expect(parseWindowsCounters('{"usage":42.5,"used":2147483648,"total":8589934592}')).toEqual({
			usage: 42.5,
			memoryUsed: 2 * GiB,
			memoryTotal: 8 * GiB,
		});
		expect(parseWindowsCounters('{"usage":130,"used":0,"total":0}')).toEqual({ usage: 100, memoryUsed: undefined, memoryTotal: undefined });
		expect(parseWindowsCounters("WARNING: something")).toBeUndefined();
	});

	it("probes nvidia-smi once, then remembers where it is", async () => {
		const run = vi.fn(async (file: string): Promise<RunResult> =>
			file === "/usr/local/bin/nvidia-smi" ? { ok: true, stdout: "GPU, 50, 60, 1024, 2048", stderr: "" } : { ok: false, stdout: "", stderr: "", missing: true },
		);
		const reader = new GpuReader({ platform: "linux", run, drm: "/nonexistent" });
		expect((await reader.read())?.usage).toBe(50);
		run.mockClear();
		await reader.read();
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0]).toBe("/usr/local/bin/nvidia-smi");
	});

	it("falls back to the platform backend and stops probing nvidia-smi", async () => {
		const run = vi.fn(async (): Promise<RunResult> => ({ ok: false, stdout: "", stderr: "", missing: true }));
		const counters = { latest: vi.fn(() => ({ usage: 12 })), stop: vi.fn() } as unknown as WindowsGpuCounters;
		const reader = new GpuReader({ platform: "win32", env: {}, run, windowsCounters: () => counters });
		expect(await reader.read()).toEqual({ usage: 12 });
		const probes = run.mock.calls.length;
		await reader.read();
		expect(run.mock.calls.length).toBe(probes);
		reader.stop();
		expect(counters.stop).toHaveBeenCalled();
	});

	it("knows where nvidia-smi is installed", () => {
		expect(nvidiaSmiPaths("win32", { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" })).toEqual([
			"C:\\Windows\\System32\\nvidia-smi.exe",
			"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
		]);
		expect(nvidiaSmiPaths("darwin")).toEqual([]);
	});
});
