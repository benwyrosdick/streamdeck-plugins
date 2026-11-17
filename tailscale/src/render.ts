/**
 * Key artwork, generated as SVG so the icon can be recolored and composed over
 * a background color without any image-processing dependency.
 *
 * Icons are drawn on a 256×256 grid (matching the original artwork) and scaled
 * onto the 144×144 key canvas.
 */

export type IconName = "account" | "connected" | "connecting" | "disconnected" | "exitNodeOff" | "exitNodeOn";

/** Everything visible on a key; also used as the render-dedup signature. */
export type View = {
	icon: IconName;
	/** Key background, as `#rrggbb`; omitted for the deck's default (black). */
	background?: string;
	/** Text shown as the key title / dial value. */
	label?: string;
	/** Draw the "unavailable" badge. */
	error?: boolean;
};

export const ICON_COLORS: Record<IconName, string> = {
	account: "#d2d2eb",
	connected: "#f5f5f5",
	connecting: "#ffb428",
	disconnected: "#a0a0a0",
	exitNodeOff: "#828282",
	exitNodeOn: "#5aaaff",
};

/** Color an icon is recolored to for legibility on a light background. */
export const DARK_ICON_COLOR = "#1e1e1e";

/** Dimmed icon color used while Tailscale is unavailable. */
const ERROR_ICON_COLOR = "#5a5a5a";

const KEY_SIZE = 144;

/**
 * `DARK_ICON_COLOR` when `background` is light enough that the (light) icons
 * would wash out; otherwise `undefined`.
 */
export function iconTintForBackground(background: string | undefined): string | undefined {
	const rgb = parseHex(background);
	if (!rgb) {
		return undefined;
	}
	// Perceptual luminance (Rec. 601). ~150/255 is a sensible light/dark cut.
	const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
	return luminance > 150 ? DARK_ICON_COLOR : undefined;
}

/** Normalizes `#rgb` / `#rrggbb` to `#rrggbb`, or `undefined` when invalid. */
export function normalizeHex(value: string | undefined): string | undefined {
	const rgb = parseHex(value);
	return rgb ? `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}` : undefined;
}

/** The SVG markup for a key showing `view`. */
export function keySvg(view: View): string {
	const background = normalizeHex(view.background);
	const color = view.error ? ERROR_ICON_COLOR : (iconTintForBackground(background) ?? ICON_COLORS[view.icon]);

	// Leave room for the title along the bottom when there is one.
	const iconSize = view.label ? 96 : 108;
	const x = (KEY_SIZE - iconSize) / 2;
	const y = view.label ? 10 : x;

	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`,
		background ? `<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="${background}"/>` : "",
		`<g transform="translate(${x} ${y}) scale(${iconSize / 256})">`,
		iconShapes(view.icon, color),
		"</g>",
		view.error ? errorBadge() : "",
		"</svg>",
	];
	return parts.join("");
}

/** `keySvg` as a data URL suitable for `setImage` / `setFeedback`. */
export function keyImage(view: View): string {
	return `data:image/svg+xml;base64,${Buffer.from(keySvg(view)).toString("base64")}`;
}

/** The bare icon shapes, drawn on a 256×256 grid. */
export function iconShapes(icon: IconName, color: string): string {
	switch (icon) {
		case "exitNodeOff":
		case "exitNodeOn":
			return `<polygon points="56,116 148,116 148,76 216,128 148,180 148,140 56,140" fill="${color}"/>`;
		default:
			return dotGrid(color);
	}
}

/** The Tailscale-style 3×3 dot grid: hollow outer rows, filled middle row. */
function dotGrid(color: string): string {
	const centers = [56.5, 128, 199.5];
	const dots: string[] = [];
	for (const cy of centers) {
		for (const cx of centers) {
			dots.push(
				cy === 128
					? `<circle cx="${cx}" cy="${cy}" r="22.5" fill="${color}"/>`
					: `<circle cx="${cx}" cy="${cy}" r="19.5" fill="none" stroke="${color}" stroke-width="6"/>`,
			);
		}
	}
	return dots.join("");
}

/** A red "!" badge in the top-right corner. */
function errorBadge(): string {
	return [
		`<circle cx="114" cy="30" r="22" fill="#d93025"/>`,
		`<rect x="111" y="15" width="6" height="19" rx="3" fill="#ffffff"/>`,
		`<circle cx="114" cy="42" r="3.5" fill="#ffffff"/>`,
	].join("");
}

function parseHex(value: string | undefined): [number, number, number] | undefined {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value?.trim() ?? "");
	if (!match) {
		return undefined;
	}
	const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
	return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
