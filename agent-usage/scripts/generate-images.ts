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
const root = path.join(project, "com.benwyrosdick.agent-usage.sdPlugin/imgs");

function write(file: string, contents: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, contents + "\n");
}

type Glyph = "claude" | "codex" | "copilot" | "overview" | "gauge";

/** Monochrome line icons on a 256×256 grid (generic marks, not the vendors' logos). */
function glyphShapes(glyph: Glyph, color: string): string {
	const stroke = (width: number) => `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
	switch (glyph) {
		case "claude": {
			// A sparkle: eight rays of alternating length.
			const rays = Array.from({ length: 8 }, (_, i) => {
				const angle = (i * Math.PI) / 4;
				const length = i % 2 ? 62 : 92;
				const x = (r: number) => (128 + r * Math.cos(angle)).toFixed(1);
				const y = (r: number) => (128 + r * Math.sin(angle)).toFixed(1);
				return `<path d="M${x(18)} ${y(18)}L${x(length)} ${y(length)}" ${stroke(22)}/>`;
			});
			return rays.join("");
		}
		case "codex":
			return [`<rect x="28" y="48" width="200" height="160" rx="24" ${stroke(18)}/>`, `<path d="M72 102L104 128L72 154M124 158H180" ${stroke(18)}/>`].join("");
		case "copilot":
			return [
				`<rect x="36" y="76" width="80" height="64" rx="28" ${stroke(18)}/>`,
				`<rect x="140" y="76" width="80" height="64" rx="28" ${stroke(18)}/>`,
				`<path d="M116 104H140M56 168Q128 220 200 168" ${stroke(18)}/>`,
			].join("");
		case "overview":
			return [
				[60, 128, 196].map((y) => `<path d="M40 ${y}H216" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="22" stroke-linecap="round"/>`).join(""),
				`<path d="M40 60H150M40 128H104M40 196H184" ${stroke(22)}/>`,
			].join("");
		case "gauge":
			return [`<path d="M52 176A84 84 0 1 1 204 176" ${stroke(22)}/>`, `<path d="M128 140L170 92" ${stroke(22)}/>`, `<circle cx="128" cy="140" r="14" fill="${color}"/>`].join("");
	}
}

/** A monochrome icon on a transparent canvas, as the action list / category icons expect. */
function glyph(name: Glyph, size: number, color = "#ffffff"): string {
	return [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="16 16 224 224">`, glyphShapes(name, color), "</svg>"].join("");
}

/** A plausible usage curve for preview art: climbing through a session. */
const climb = (to: number) => Array.from({ length: 40 }, (_, i) => Math.max(0, Math.min(1, (to * i) / 39 + 0.03 * Math.sin(i / 1.7))));

const gauge = (view: Partial<GaugeView> & Pick<GaugeView, "title" | "value" | "fraction">): GaugeView => ({
	kind: "gauge",
	style: "ring",
	level: "normal",
	history: climb(view.fraction),
	...view,
});

/** The image each key shows before the plugin first draws it. */
const actions: Record<string, { glyph: Glyph; key: View }> = {
	claude: { glyph: "claude", key: gauge({ title: "Claude 5h", value: "42%", detail: "2h 13m", fraction: 0.42 }) },
	codex: { glyph: "codex", key: gauge({ title: "Codex 5h", value: "18%", detail: "3h 40m", fraction: 0.18 }) },
	copilot: { glyph: "copilot", key: gauge({ title: "Copilot", value: "35%", detail: "12d 4h", fraction: 0.35 }) },
	overview: {
		glyph: "overview",
		key: {
			kind: "overview",
			rows: [
				{ label: "Claude", value: "42%", fraction: 0.42, level: "normal" },
				{ label: "Codex", value: "76%", fraction: 0.76, level: "warning" },
				{ label: "Copilot", value: "35%", fraction: 0.35, level: "normal" },
			],
		},
	},
};

for (const [name, { glyph: icon, key }] of Object.entries(actions)) {
	write(`actions/${name}/icon.svg`, glyph(icon, 20));
	write(`actions/${name}/key.svg`, keySvg(key));
}

write("plugin/category-icon.svg", glyph("gauge", 28));

const tmp = mkdtempSync(path.join(os.tmpdir(), "agent-usage-icons-"));
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
		glyphShapes("gauge", "#34d399"),
		"</g>",
		"</svg>",
	].join(""),
	[
		[path.join(root, "plugin/marketplace.png"), 256, 256],
		[path.join(root, "plugin/marketplace@2x.png"), 512, 512],
	],
);

// Store thumbnail: the name beside a row of keys at different levels.
const showcase: View[] = [
	gauge({ title: "Claude 5h", value: "42%", detail: "2h 13m", fraction: 0.42 }),
	gauge({ style: "classic", level: "warning", title: "Codex Week", value: "78%", detail: "resets 3d 4h", fraction: 0.78 }),
	gauge({ style: "solid", level: "critical", title: "Copilot", value: "94%", detail: "resets 12d 4h", fraction: 0.94 }),
];
const keys = showcase
	.map((view, i) => `<g transform="translate(${532 + i * 152} 108)">${keySvg(view).replace(/<svg [^>]*>/, "").replace(/<\/svg>$/, "")}</g>`)
	.join("");
png(
	[
		`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360" viewBox="0 0 1000 360">`,
		`<defs><linearGradient id="thumb-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151a2e"/><stop offset="1" stop-color="#090c14"/></linearGradient></defs>`,
		`<rect width="1000" height="360" fill="url(#thumb-bg)"/>`,
		`<text x="56" y="176" fill="#f8fafc" font-family="'Noto Sans', 'Segoe UI', Helvetica, Arial, sans-serif" font-size="56" font-weight="700">Agent Usage</text>`,
		`<text x="58" y="226" fill="#94a3b8" font-family="'Noto Sans', 'Segoe UI', Helvetica, Arial, sans-serif" font-size="22">Claude Code, Codex &amp; Copilot limits</text>`,
		keys,
		"</svg>",
	].join(""),
	[[path.join(project, "store/Thumbnail.png"), 1000, 360]],
);
rmSync(tmp, { recursive: true });
