/**
 * Regenerates the static artwork in the .sdPlugin folder (and the store
 * thumbnail) from the same SVG renderer the plugin draws keys with at
 * runtime (src/render.ts).
 *
 *     npm run images
 *
 * Needs `rsvg-convert` for the PNGs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ActionKind, Glyph, View } from "../src/bridge/protocol";
import { glyphShapes, keySvg } from "../src/render";

const project = path.resolve(import.meta.dirname, "..");
const root = path.join(project, "com.benwyrosdick.foundry-vtt.sdPlugin/imgs");

function write(file: string, contents: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, contents + "\n");
}

/** A monochrome icon on a transparent canvas, as the action list / category icons expect. */
function icon(glyph: Glyph, size: number, color = "#ffffff"): string {
	return [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="16 16 224 224">`, glyphShapes(glyph, color), "</svg>"].join("");
}

/** Each action's list icon and the image its key shows before the plugin draws it. */
const actions: Record<ActionKind, { glyph: Glyph; key: View }> = {
	macro: { glyph: "macro", key: { glyph: "macro", title: "Macro" } },
	scene: { glyph: "scene", key: { glyph: "scene", title: "Scene" } },
	token: { glyph: "token", key: { glyph: "token", title: "Token" } },
	combat: { glyph: "combat", key: { big: "R1", subtitle: "Combat" } },
	playlist: { glyph: "music", key: { glyph: "music", title: "Music" } },
	system: { glyph: "pause", key: { glyph: "pause", title: "Pause" } },
};

for (const [kind, { glyph, key }] of Object.entries(actions) as [ActionKind, { glyph: Glyph; key: View }][]) {
	write(`actions/${kind}/icon.svg`, icon(glyph, 20));
	write(`actions/${kind}/key.svg`, keySvg(kind, key));
}
write("plugin/category-icon.svg", icon("dice", 28));

const tmp = mkdtempSync(path.join(os.tmpdir(), "foundry-vtt-icons-"));
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
		`<rect width="256" height="256" fill="#4b2d73"/>`,
		`<g transform="translate(40 40) scale(0.6875)">`,
		glyphShapes("dice", "#ffffff"),
		"</g>",
		"</svg>",
	].join(""),
	[
		[path.join(root, "plugin/marketplace.png"), 256, 256],
		[path.join(root, "plugin/marketplace@2x.png"), 512, 512],
	],
);

// Store thumbnail: the name beside a row of keys.
const showcase: [ActionKind, View][] = [
	["combat", { big: "R3", subtitle: "Turn 2/5" }],
	["system", { glyph: "dice", title: "1d20+5", badge: "GM" }],
	["playlist", { glyph: "music", title: "Tavern", border: "active", badge: "▶" }],
];
const keys = showcase
	.map(([kind, view], i) => `<g transform="translate(${532 + i * 152} 108)">${keySvg(kind, view).replace(/<svg [^>]*>/, "").replace(/<\/svg>$/, "")}</g>`)
	.join("");
png(
	[
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="360" viewBox="0 0 1000 360">`,
		`<defs><linearGradient id="thumb-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#241a33"/><stop offset="1" stop-color="#0c0a12"/></linearGradient></defs>`,
		`<rect width="1000" height="360" fill="url(#thumb-bg)"/>`,
		`<text x="56" y="176" fill="#f8fafc" font-family="'Noto Sans', 'Segoe UI', Helvetica, Arial, sans-serif" font-size="56" font-weight="700">Foundry VTT</text>`,
		`<text x="58" y="226" fill="#a3a0b8" font-family="'Noto Sans', 'Segoe UI', Helvetica, Arial, sans-serif" font-size="22">Run your table from the Stream Deck</text>`,
		keys,
		"</svg>",
	].join(""),
	[[path.join(project, "store/Thumbnail.png"), 1000, 360]],
);
rmSync(tmp, { recursive: true });
