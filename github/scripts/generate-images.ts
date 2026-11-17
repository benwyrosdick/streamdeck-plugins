/**
 * Regenerates the static artwork in the .sdPlugin folder from the same SVG
 * shapes the plugin draws at runtime (src/render.ts).
 *
 *     npm run images
 *
 * Requires Node 22.18+ (TypeScript type stripping) and `rsvg-convert` for the
 * PNG marketplace icon.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { iconShapes, type IconName, keySvg, type View } from "../src/render.ts";

const root = path.resolve(import.meta.dirname, "../com.benwyrosdick.github.sdPlugin/imgs");

function write(file: string, contents: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, contents + "\n");
}

/** A monochrome icon on a transparent canvas, as the action list / category icons expect. */
function glyph(icon: IconName, size: number, color = "#ffffff"): string {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="16 16 224 224">`,
		iconShapes(icon, color),
		"</svg>",
	].join("");
}

const actions: Record<string, { list: IconName; key: View }> = {
	"pr-count": { list: "pr", key: { icon: "pr", top: "PRs" } },
	"issue-count": { list: "issue", key: { icon: "issue", top: "Issues" } },
	"ci-status": { list: "ciSuccess", key: { icon: "ciSuccess", top: "CI" } },
	"notification-count": { list: "inbox", key: { icon: "inbox", top: "Inbox" } },
};

for (const [name, { list, key }] of Object.entries(actions)) {
	write(`actions/${name}/icon.svg`, glyph(list, 20));
	write(`actions/${name}/key.svg`, keySvg(key));
}

write("plugin/category-icon.svg", glyph("pr", 28));

// The marketplace icon must be a PNG (256px and 512px @2x).
const tmp = mkdtempSync(path.join(os.tmpdir(), "github-icons-"));
const marketplace = path.join(tmp, "marketplace.svg");
writeFileSync(
	marketplace,
	[
		`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">`,
		`<rect width="256" height="256" fill="#0d1117"/>`,
		`<g transform="translate(40 40) scale(0.6875)">`,
		iconShapes("pr", "#3fb950"),
		"</g>",
		"</svg>",
	].join(""),
);
for (const [suffix, size] of [["", 256], ["@2x", 512]] as const) {
	execFileSync("rsvg-convert", [
		"-w", String(size), "-h", String(size),
		"-o", path.join(root, `plugin/marketplace${suffix}.png`),
		marketplace,
	]);
}
rmSync(tmp, { recursive: true });
