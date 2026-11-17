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

import { iconShapes, type IconName, keySvg } from "../src/render.ts";

const root = path.resolve(import.meta.dirname, "../com.benwyrosdick.tailscale.sdPlugin/imgs");

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

const actions: Record<string, { list: IconName; key: IconName }> = {
	connect: { list: "connected", key: "disconnected" },
	disconnect: { list: "connected", key: "disconnected" },
	"toggle-connection": { list: "connected", key: "disconnected" },
	"switch-account": { list: "account", key: "account" },
	"toggle-exit-node": { list: "exitNodeOn", key: "exitNodeOff" },
};

for (const [name, { list, key }] of Object.entries(actions)) {
	write(`actions/${name}/icon.svg`, glyph(list, 20));
	write(`actions/${name}/key.svg`, keySvg({ icon: key }));
}

write("plugin/category-icon.svg", glyph("connected", 28));

// The marketplace icon must be a PNG (256px and 512px @2x).
const tmp = mkdtempSync(path.join(os.tmpdir(), "tailscale-icons-"));
const marketplace = path.join(tmp, "marketplace.svg");
writeFileSync(marketplace, keySvg({ icon: "connected", background: "#1f1f1f" }));
for (const [suffix, size] of [["", 256], ["@2x", 512]] as const) {
	execFileSync("rsvg-convert", [
		"-w", String(size), "-h", String(size),
		"-o", path.join(root, `plugin/marketplace${suffix}.png`),
		marketplace,
	]);
}
rmSync(tmp, { recursive: true });
