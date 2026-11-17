/**
 * Turns readings and key settings into what a key shows. Pure functions, so
 * every style/threshold combination is easy to test.
 */
import type { CpuSample, DiskSample, GpuSample, MemorySample, MetricKind, NetworkSample } from "./metrics/types";
import { type GaugeView, type Level, type OverviewRow, type OverviewView, type Style, STYLES } from "./render";

/** Settings every metric key shares. */
export type DisplaySettings = {
	style?: Style;
	/** "single" shows just the reading; "combined" adds temperature and usage details. */
	layout?: "single" | "combined";
	/** Overrides the header text. */
	label?: string;
	/** Colour the key amber / red past the thresholds (default on). */
	colorize?: boolean;
	/** Warning threshold, percent (default 70). */
	warnAt?: number | string;
	/** Critical threshold, percent (default 90). */
	critAt?: number | string;
};

export type DiskSettings = DisplaySettings & {
	/** Mount point / drive root; blank = the system drive. */
	drive?: string;
};

export type NetworkSettings = DisplaySettings & {
	direction?: "down" | "up";
	units?: "bytes" | "bits";
	/** Link speed in Mbit/s that counts as 100%; blank = scale to recent peak (no threshold colouring). */
	fullScale?: number | string;
};

export type OverviewSettings = Pick<DisplaySettings, "colorize" | "warnAt" | "critAt"> & {
	metrics?: MetricKind[];
};

export const DEFAULT_WARN = 70;
export const DEFAULT_CRIT = 90;
export const DEFAULT_OVERVIEW: MetricKind[] = ["cpu", "gpu", "memory", "disk"];

/** Starting settings for a metric key; thresholds are strings to match the inspector's selects. */
export const DISPLAY_DEFAULTS = {
	style: "classic",
	layout: "single",
	colorize: true,
	warnAt: String(DEFAULT_WARN),
	critAt: String(DEFAULT_CRIT),
} satisfies DisplaySettings;

/** Longest custom label before it's cut. */
const MAX_LABEL = 10;

/** Below this the network graph/meter doesn't zoom in further, so idle noise stays flat. */
const MIN_NETWORK_SCALE = 128 * 1024;
const AUTO_SCALE_HEADROOM = 1.25;

// ---------------------------------------------------------------------- //
// Thresholds
// ---------------------------------------------------------------------- //

function numberSetting(value: number | string | undefined, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function thresholds(settings: Pick<DisplaySettings, "warnAt" | "critAt">): { warn: number; crit: number } {
	const warn = numberSetting(settings.warnAt, DEFAULT_WARN);
	const crit = numberSetting(settings.critAt, DEFAULT_CRIT);
	return { warn, crit: Math.max(warn, crit) };
}

export function levelFor(percent: number, settings: Pick<DisplaySettings, "colorize" | "warnAt" | "critAt">): Level {
	if (settings.colorize === false) {
		return "normal";
	}
	const { warn, crit } = thresholds(settings);
	if (percent >= crit) return "critical";
	if (percent >= warn) return "warning";
	return "normal";
}

// ---------------------------------------------------------------------- //
// Formatting
// ---------------------------------------------------------------------- //

export const formatPercent = (value: number): string => `${Math.round(value)}%`;

/** Three significant figures at most: 0.5, 6.1, 19.4, 390. */
function figure(value: number): string {
	return value < 10 ? value.toFixed(1) : value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Binary sizes with the familiar labels (as Windows and most monitors show them): 16.0 GB. */
export function formatBytes(bytes: number, { fixed = false } = {}): string {
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	if (unit === 0) {
		return `${Math.round(value)} B`;
	}
	return `${fixed && value < 100 ? value.toFixed(1) : figure(value)} ${BYTE_UNITS[unit]}`;
}

/** A transfer rate: 3.6 MB/s, or in bits (decimal, like link speeds): 29 Mb/s. */
export function formatRate(bytesPerSecond: number, units: NetworkSettings["units"] = "bytes"): string {
	if (units === "bits") {
		let value = Math.max(0, bytesPerSecond) * 8;
		const labels = ["b/s", "Kb/s", "Mb/s", "Gb/s"];
		let unit = 0;
		while (value >= 1000 && unit < labels.length - 1) {
			value /= 1000;
			unit++;
		}
		return unit === 0 ? `${Math.round(value)} b/s` : `${figure(value)} ${labels[unit]}`;
	}
	return `${formatBytes(bytesPerSecond)}/s`;
}

/** "used / total", sharing one decimal: 19.4 GB / 32.0 GB. */
export function usedOfTotal(used: number, total: number): string {
	return `${formatBytes(used, { fixed: true })} / ${formatBytes(total, { fixed: true })}`;
}

function title(settings: DisplaySettings, fallback: string): string {
	return (settings.label ?? "").trim().slice(0, MAX_LABEL) || fallback;
}

function withTemperature(name: string, temperature: number | undefined, settings: DisplaySettings): string {
	return combined(settings) && temperature !== undefined ? `${name} ${Math.round(temperature)}°C` : name;
}

const combined = (settings: DisplaySettings): boolean => settings.layout === "combined";

export function styleOf(settings: DisplaySettings): Style {
	return STYLES.includes(settings.style as Style) ? (settings.style as Style) : "classic";
}

/** Percent history on the 0–1 scale the renderer draws, rounded to keep signatures small. */
const percentHistory = (values: number[]): number[] => values.map((v) => Math.round(v * 10) / 1000);

/** Placeholder while waiting for the first reading (`…`) or when unavailable (`N/A`). */
function placeholder(settings: DisplaySettings, heading: string, value: "…" | "N/A"): GaugeView {
	return { kind: "gauge", style: styleOf(settings), level: "idle", title: heading, value, fraction: 0, history: [] };
}

function percentGauge(settings: DisplaySettings, heading: string, percent: number, history: number[], detail?: string): GaugeView {
	return {
		kind: "gauge",
		style: styleOf(settings),
		level: levelFor(percent, settings),
		title: heading,
		value: formatPercent(percent),
		detail: combined(settings) ? detail : undefined,
		fraction: Math.round(percent * 10) / 1000,
		history: percentHistory(history),
	};
}

// ---------------------------------------------------------------------- //
// Metric views
// ---------------------------------------------------------------------- //

export function cpuView(sample: CpuSample | undefined, history: number[], settings: DisplaySettings): GaugeView {
	const name = title(settings, "CPU");
	if (!sample) {
		return placeholder(settings, name, "…");
	}
	return percentGauge(settings, withTemperature(name, sample.temperature, settings), sample.usage, history, `Top core ${formatPercent(sample.maxCore)}`);
}

export function gpuView(sample: GpuSample | null | undefined, history: number[], settings: DisplaySettings): GaugeView {
	const name = title(settings, "GPU");
	if (!sample) {
		return placeholder(settings, name, sample === null ? "N/A" : "…");
	}
	const detail =
		sample.memoryUsed !== undefined && sample.memoryTotal
			? usedOfTotal(sample.memoryUsed, sample.memoryTotal)
			: sample.memoryUsed !== undefined
				? `${formatBytes(sample.memoryUsed)} used`
				: undefined;
	return percentGauge(settings, withTemperature(name, sample.temperature, settings), sample.usage, history, detail);
}

export function memoryView(sample: MemorySample | undefined, history: number[], settings: DisplaySettings): GaugeView {
	const name = title(settings, "RAM");
	if (!sample) {
		return placeholder(settings, name, "…");
	}
	const percent = sample.total > 0 ? (sample.used / sample.total) * 100 : 0;
	return percentGauge(settings, name, percent, history, usedOfTotal(sample.used, sample.total));
}

export function diskView(sample: DiskSample | null | undefined, history: number[], settings: DiskSettings, fallbackLabel = "Disk"): GaugeView {
	if (!sample) {
		return placeholder(settings, title(settings, fallbackLabel), sample === null ? "N/A" : "…");
	}
	const percent = (sample.used / (sample.used + sample.free || 1)) * 100;
	return percentGauge(settings, title(settings, sample.label), percent, history, `${formatBytes(sample.free)} free`);
}

/** Bytes per second that count as full for the meter and graph. */
export function networkScale(settings: NetworkSettings, history: number[]): { scale: number; fixed: boolean } {
	const mbps = numberSetting(settings.fullScale, 0);
	if (mbps > 0) {
		return { scale: (mbps * 1_000_000) / 8, fixed: true };
	}
	// Headroom above the recent peak, so a steady transfer doesn't pin the meter.
	return { scale: Math.max(MIN_NETWORK_SCALE, ...history) * AUTO_SCALE_HEADROOM, fixed: false };
}

export function networkView(sample: NetworkSample | undefined, history: { down: number[]; up: number[] }, settings: NetworkSettings): GaugeView {
	const up = settings.direction === "up";
	const name = `${title(settings, "NET")} ${up ? "↑" : "↓"}`;
	if (!sample) {
		return placeholder(settings, name, "…");
	}
	const rate = up ? sample.up : sample.down;
	const series = up ? history.up : history.down;
	const { scale, fixed } = networkScale(settings, series);
	const fraction = Math.min(1, rate / scale);
	return {
		kind: "gauge",
		style: styleOf(settings),
		// Thresholds only mean something against a known link speed.
		level: fixed ? levelFor(fraction * 100, settings) : "normal",
		title: name,
		value: formatRate(rate, settings.units),
		detail: combined(settings) ? `${up ? "↓" : "↑"} ${formatRate(up ? sample.down : sample.up, settings.units)}` : undefined,
		fraction: Math.round(fraction * 1000) / 1000,
		history: series.map((v) => Math.round(Math.min(1, v / scale) * 100) / 100),
	};
}

/** The readings an overview key needs, each `undefined` while pending. */
export type OverviewReadings = {
	cpu?: CpuSample;
	gpu?: GpuSample | null;
	memory?: MemorySample;
	disk?: DiskSample | null;
	network?: NetworkSample;
	networkHistory?: number[];
};

export function overviewMetrics(settings: OverviewSettings): MetricKind[] {
	const valid: MetricKind[] = ["cpu", "gpu", "memory", "disk", "network"];
	const chosen = Array.isArray(settings.metrics) ? settings.metrics.filter((m) => valid.includes(m)) : DEFAULT_OVERVIEW;
	return valid.filter((m) => chosen.includes(m));
}

export function overviewView(readings: OverviewReadings, settings: OverviewSettings): OverviewView {
	const percentRow = (label: string, percent: number | undefined, missing = false): OverviewRow =>
		percent === undefined
			? { label, value: missing ? "N/A" : "…", fraction: 0, level: "idle" }
			: { label, value: formatPercent(percent), fraction: percent / 100, level: levelFor(percent, settings) };

	const rows = overviewMetrics(settings).map((metric): OverviewRow => {
		switch (metric) {
			case "cpu":
				return percentRow("CPU", readings.cpu?.usage);
			case "gpu":
				return percentRow("GPU", readings.gpu?.usage, readings.gpu === null);
			case "memory":
				return percentRow("RAM", readings.memory ? (readings.memory.used / (readings.memory.total || 1)) * 100 : undefined);
			case "disk": {
				const disk = readings.disk;
				return percentRow(disk?.label.slice(0, 5) ?? "Disk", disk ? (disk.used / (disk.used + disk.free || 1)) * 100 : undefined, disk === null);
			}
			case "network": {
				if (!readings.network) {
					return { label: "NET", value: "…", fraction: 0, level: "idle" };
				}
				const { scale } = networkScale({}, readings.networkHistory ?? []);
				return { label: "NET", value: formatRate(readings.network.down), fraction: readings.network.down / scale, level: "normal" };
			}
		}
	});
	return { kind: "overview", rows };
}
