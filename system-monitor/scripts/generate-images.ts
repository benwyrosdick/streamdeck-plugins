/**
 * Regenerates the static artwork in the .sdPlugin folder (and the store
 * thumbnail) from the same SVG renderer the plugin draws keys with at
 * runtime (src/render.ts).
 *
 *     npm run images
 *
 * Requires Node 22.18+ (TypeScript type stripping) and `rsvg-convert` for the
 * PNGs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type GaugeView, keySvg, type View } from "../src/render.ts";

const project = path.resolve(import.meta.dirname, "..");
const root = path.join(project, "com.benwyrosdick.system-monitor.sdPlugin/imgs");

function write(file: string, contents: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, contents + "\n");
}

type Glyph = "cpu" | "gpu" | "memory" | "disk" | "network" | "overview" | "pulse";

/** Monochrome line icons on a 256×256 grid. */
function glyphShapes(glyph: Glyph, color: string): string {
	const stroke = (width: number) => `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
	const pins = (coords: number[][]) => coords.map(([x1, y1, x2, y2]) => `<path d="M${x1} ${y1}L${x2} ${y2}" ${stroke(16)}/>`).join("");
	switch (glyph) {
		case "cpu":
			return [
				`<rect x="64" y="64" width="128" height="128" rx="16" ${stroke(18)}/>`,
				`<rect x="102" y="102" width="52" height="52" rx="6" fill="${color}"/>`,
				pins([96, 128, 160].flatMap((p) => [[p, 32, p, 60], [p, 196, p, 224], [32, p, 60, p], [196, p, 224, p]])),
			].join("");
		case "gpu":
			return [
				`<rect x="28" y="60" width="200" height="120" rx="14" ${stroke(18)}/>`,
				`<circle cx="98" cy="120" r="32" ${stroke(16)}/>`,
				`<path d="M156 98H192M156 142H192" ${stroke(16)}/>`,
				pins([[60, 180, 60, 212], [100, 180, 100, 212], [140, 180, 140, 212]]),
			].join("");
		case "memory":
			return [
				`<rect x="24" y="72" width="208" height="96" rx="10" ${stroke(18)}/>`,
				[60, 110, 160].map((x) => `<rect x="${x}" y="98" width="36" height="44" rx="4" fill="${color}"/>`).join(""),
				pins([56, 88, 120, 152, 184].map((x) => [x, 168, x, 200])),
			].join("");
		case "disk":
			return [
				`<rect x="32" y="60" width="192" height="136" rx="20" ${stroke(18)}/>`,
				`<path d="M32 140H224" ${stroke(14)}/>`,
				`<circle cx="186" cy="170" r="10" fill="${color}"/>`,
			].join("");
		case "network":
			return [`<path d="M92 44V208M52 168L92 208L132 168" ${stroke(20)}/>`, `<path d="M164 212V48M124 88L164 48L204 88" ${stroke(20)}/>`].join("");
		case "overview":
			return [
				[60, 128, 196].map((y) => `<path d="M40 ${y}H216" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="22" stroke-linecap="round"/>`).join(""),
				`<path d="M40 60H120M40 128H184M40 196H92" ${stroke(22)}/>`,
			].join("");
		case "pulse":
			return `<path d="M24 136H76L104 64L144 196L172 112L188 136H232" ${stroke(20)}/>`;
	}
}

/** A monochrome icon on a transparent canvas, as the action list / category icons expect. */
function glyph(name: Glyph, size: number, color = "#ffffff"): string {
	return [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="16 16 224 224">`, glyphShapes(name, color), "</svg>"].join("");
}

/** A plausible graph for preview art. */
const wave = (base: number, amplitude = 0.08) =>
	Array.from({ length: 40 }, (_, i) => Math.max(0, Math.min(1, base + amplitude * Math.sin(i / 2.3) + amplitude * 0.6 * Math.cos(i * 1.7))));

const gauge = (view: Partial<GaugeView> & Pick<GaugeView, "title" | "value" | "fraction">): GaugeView => ({
	kind: "gauge",
	style: "classic",
	level: "normal",
	history: wave(view.fraction),
	...view,
});

/** The image each key shows before the plugin first draws it. */
const actions: Record<string, { glyph: Glyph; key: View }> = {
	cpu: { glyph: "cpu", key: gauge({ style: "ring", title: "CPU", value: "20%", fraction: 0.2 }) },
	gpu: { glyph: "gpu", key: gauge({ style: "solid", title: "GPU 64°C", value: "39%", detail: "6.1 GB / 16.0 GB", fraction: 0.39 }) },
	memory: { glyph: "memory", key: gauge({ style: "neon", title: "RAM", value: "61%", detail: "19.4 GB / 32.0 GB", fraction: 0.61, history: wave(0.6, 0.02) }) },
	disk: { glyph: "disk", key: gauge({ title: "C:", value: "58%", detail: "390 GB free", fraction: 0.58, history: [] }) },
	network: { glyph: "network", key: gauge({ style: "bars", title: "NET ↓", value: "3.6 MB/s", fraction: 0.4 }) },
	overview: {
		glyph: "overview",
		key: {
			kind: "overview",
			rows: [
				{ label: "CPU", value: "20%", fraction: 0.2, level: "normal" },
				{ label: "GPU", value: "39%", fraction: 0.39, level: "normal" },
				{ label: "RAM", value: "79%", fraction: 0.79, level: "warning" },
				{ label: "C:", value: "58%", fraction: 0.58, level: "normal" },
			],
		},
	},
};

for (const [name, { glyph: icon, key }] of Object.entries(actions)) {
	write(`actions/${name}/icon.svg`, glyph(icon, 20));
	write(`actions/${name}/key.svg`, keySvg(key));
}

write("plugin/category-icon.svg", glyph("pulse", 28));

const tmp = mkdtempSync(path.join(os.tmpdir(), "system-monitor-icons-"));
const png = (svg: string, outputs: [string, number, number][]) => {
	const source = path.join(tmp, "source.svg");
	writeFileSync(source, svg);
	for (const [file, width, height] of outputs) {
		execFileSync("rsvg-convert", ["-w", String(width), "-h", String(height), "-o", file, source]);
	}
};

// The marketplace icon must be a PNG (256px and 512px @2x).
png(
	[
		`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">`,
		`<rect width="256" height="256" fill="#10151f"/>`,
		`<g transform="translate(40 40) scale(0.6875)">`,
		glyphShapes("pulse", "#34d399"),
		"</g>",
		"</svg>",
	].join(""),
	[
		[path.join(root, "plugin/marketplace.png"), 256, 256],
		[path.join(root, "plugin/marketplace@2x.png"), 512, 512],
	],
);

// Store thumbnail: the name beside a row of keys in different styles and levels.
const showcase: View[] = [
	gauge({ style: "classic", title: "CPU", value: "20%", fraction: 0.2 }),
	gauge({ style: "ring", title: "GPU", value: "79%", fraction: 0.79, level: "warning" }),
	gauge({ style: "solid", level: "critical", title: "RAM", value: "93%", fraction: 0.93 }),
];
const keys = showcase
	.map((view, i) => `<g transform="translate(${532 + i * 152} 108)">${keySvg(view).replace(/<svg [^>]*>/, "").replace(/<\/svg>$/, "")}</g>`)
	.join("");
png(
	[
		`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360" viewBox="0 0 1000 360">`,
		`<defs><linearGradient id="thumb-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151a2e"/><stop offset="1" stop-color="#090c14"/></linearGradient></defs>`,
		`<rect width="1000" height="360" fill="url(#thumb-bg)"/>`,
		`<text x="56" y="176" fill="#f8fafc" font-family="'Noto Sans', 'Segoe UI', Helvetica, Arial, sans-serif" font-size="52" font-weight="700">System Monitor</text>`,
		`<text x="58" y="226" fill="#94a3b8" font-family="'Noto Sans', 'Segoe UI', Helvetica, Arial, sans-serif" font-size="22">CPU, GPU, memory, disk &amp; network</text>`,
		keys,
		"</svg>",
	].join(""),
	[[path.join(project, "store/Thumbnail.png"), 1000, 360]],
);
rmSync(tmp, { recursive: true });
